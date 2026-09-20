/**
 * Fetching a URL a stranger chose.
 *
 * Two of the paid routes read any public page on request. Without care that is a way to make this
 * machine talk to itself: the facilitator, the database and the metadata address all answer on
 * addresses the outside world cannot reach. So the address is checked where the connection is
 * made, not before it: the lookup the socket uses refuses anything that is not a public address,
 * which also covers a name that resolves differently the second time. Redirects are followed by
 * hand, each hop checked again. Only http and https on their usual ports, a size cap, a deadline.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32], ["64:ff9b::", 96]] as const) blocked.addSubnet(net, bits, "ipv6");

/** True for an address the public internet can reach. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6) return false;
  // An IPv4 address dressed as IPv6 is judged as the IPv4 address it is.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]!);
  return !blocked.check(address, "ipv6");
}

export class UnsafeUrl extends Error {
  override readonly name = "UnsafeUrl";
}

/** The URL if it is one we are willing to fetch, or the reason we are not. */
export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrl("not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrl("only http and https");
  if (url.port !== "") throw new UnsafeUrl("only the default port");
  if (url.username || url.password) throw new UnsafeUrl("no credentials in the URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) throw new UnsafeUrl("not a public address");
  if (!isIP(host) && !host.includes(".")) throw new UnsafeUrl("not a public host name");
  return url;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;
/** The resolver handed to the socket: one private address among the answers and the whole lookup fails. */
function guardedLookup(hostname: string, options: object, cb: LookupCb): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) return cb(Object.assign(new Error(`${hostname} does not resolve to a public address`), { code: "EUNSAFE" }));
    if ((options as { all?: boolean }).all) return cb(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });
}

export interface Hop {
  readonly url: string;
  readonly status: number;
  readonly ms: number;
}
export interface Fetched {
  readonly finalUrl: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly truncated: boolean;
  readonly hops: readonly Hop[];
}
export interface SafeFetchOptions {
  readonly method?: "GET" | "HEAD";
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
}

const UA = "cra-agent/0.1 (+https://cra-agent.tech)";

function once(url: URL, method: string, maxBytes: number, deadline: number): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const left = deadline - Date.now();
    if (left <= 0) return reject(new Error("timed out"));
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(url, { method, lookup: guardedLookup as never, headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8", "accept-encoding": "gzip, br" }, timeout: left }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      res.on("data", (c: Buffer) => {
        if (truncated) return;
        size += c.length;
        chunks.push(c);
        if (size >= maxBytes) {
          truncated = true;
          res.destroy();
          finish();
        }
      });
      const finish = () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated });
      res.on("end", finish);
      res.on("error", (e) => (truncated ? undefined : reject(e)));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}

function decoded(body: Buffer, encoding: string | undefined, truncated: boolean): Buffer {
  // A cut-off compressed stream cannot be trusted to inflate; what arrived is returned as it is.
  if (!encoding || truncated) return body;
  try {
    if (encoding === "gzip") return gunzipSync(body);
    if (encoding === "br") return brotliDecompressSync(body);
    if (encoding === "deflate") return inflateSync(body);
  } catch {
    /* fall through with the raw bytes */
  }
  return body;
}

export async function safeFetch(raw: string, opts: SafeFetchOptions = {}): Promise<Fetched> {
  const maxBytes = opts.maxBytes ?? 1_500_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 8000);
  const hops: Hop[] = [];
  let url = checkUrl(raw);
  for (let i = 0; ; i++) {
    const started = Date.now();
    const res = await once(url, opts.method ?? "GET", maxBytes, deadline);
    hops.push({ url: url.toString(), status: res.status, ms: Date.now() - started });
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location) {
      if (i >= (opts.maxRedirects ?? 5)) throw new Error("too many redirects");
      url = checkUrl(new URL(location, url).toString());
      continue;
    }
    const headers = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")]));
    return { finalUrl: url.toString(), status: res.status, headers, body: decoded(res.body, res.headers["content-encoding"], res.truncated), truncated: res.truncated, hops };
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©" };
const unescape = (s: string): string =>
  s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
const textOf = (html: string): string => unescape(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

export interface Extracted {
  title: string | null;
  description: string | null;
  headings: string[];
  text: string;
  textTruncated: boolean;
}

/** The readable part of an HTML page: what a person would see, without the machinery around it. */
export function extractReadable(html: string, maxChars = 20_000): Extracted {
  const meta = (name: string): string | null => {
    const tag = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, "i").exec(html)?.[0];
    const content = tag ? /content=["']([^"']*)["']/i.exec(tag)?.[1] : undefined;
    return content ? unescape(content).trim() : null;
  };
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|nav|footer|form)\b[\s\S]*?<\/\1>/gi, " ");
  const headings = [...body.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => textOf(m[1]!)).filter(Boolean).slice(0, 40);
  const text = textOf(body.replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, "$& \n"));
  return { title: title ? textOf(title) : (meta("og:title") ?? null), description: meta("description") ?? meta("og:description"), headings, text: text.slice(0, maxChars), textTruncated: text.length > maxChars };
}
