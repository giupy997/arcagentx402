/**
 * Paid routes that answer from outside our own database: the Arc chain read live, and a handful of
 * public sources (package registries, DNS, registration data, reference exchange rates, Wikipedia)
 * returned as one clean JSON shape an agent can use without an account anywhere.
 *
 * Every answer names its source. A bad parameter is a 400 and an upstream failure a 502, and either
 * way the payment is never settled: the buyer pays for an answer, not for an attempt.
 */
import type { Context, Hono } from "hono";
import { extractReadable, safeFetch, UnsafeUrl } from "./safe-fetch.js";

const UA = "cra-agent/0.1 (+https://cra-agent.tech)";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const PUBLIC_RPCS: Record<string, readonly string[]> = {
  mainnet: ["https://rpc.blockdaemon.mainnet.arc.io", "https://rpc.quicknode.mainnet.arc.io", "https://rpc.drpc.mainnet.arc.io", "https://rpc.mainnet.arc.io"],
  testnet: ["https://rpc.testnet.arc.network"],
};

class BadInput extends Error {}
class Upstream extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

/** Short-lived cache, so a popular question does not become a burden on somebody else's free service. */
const cache = new Map<string, { at: number; body: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.body as T;
  const body = await fn();
  if (cache.size > 2000) cache.clear();
  cache.set(key, { at: Date.now(), body });
  return body;
}

async function getJson<T>(url: string, init: { headers?: Record<string, string>; method?: string; body?: string; notFound?: string } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: init.method ?? "GET", ...(init.body ? { body: init.body } : {}), headers: { "user-agent": UA, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers }, signal: AbortSignal.timeout(8000) });
  } catch (err) {
    throw new Upstream(`${new URL(url).host} did not answer: ${(err as Error).message}`);
  }
  if (res.status === 404) throw new Upstream(init.notFound ?? "not found", 404);
  if (!res.ok) throw new Upstream(`${new URL(url).host} answered ${res.status}`);
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ parameters */

const param = (c: Context, name: string): string | undefined => c.req.query(name)?.trim() || undefined;
function need(c: Context, name: string, pattern: RegExp, what: string): string {
  const v = param(c, name);
  if (!v) throw new BadInput(`${name} is required: ${what}`);
  if (v.length > 300 || !pattern.test(v)) throw new BadInput(`${name} is not ${what}`);
  return v;
}
function optional(c: Context, name: string, pattern: RegExp, what: string): string | undefined {
  return param(c, name) === undefined ? undefined : need(c, name, pattern, what);
}
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const HOSTNAME = /^(?=.{1,253}$)([a-zA-Z0-9_]([a-zA-Z0-9_-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}\.?$/;
const NPM_NAME = /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const PYPI_NAME = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+!_-]{0,63}$/;
const CURRENCY = /^[A-Za-z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LANG = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/;

/* ------------------------------------------------------------------ Arc, read live */

function rpcClient(urls: readonly string[]) {
  let id = 0;
  return async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    let last: Error = new Error("no RPC endpoint configured");
    for (const url of urls) {
      try {
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { result?: T; error?: { message: string } };
        // A revert is the chain's answer, not an endpoint's failure: asking the next one changes nothing.
        if (body.error && /revert|execution/i.test(body.error.message)) throw new Upstream(`Arc RPC: ${body.error.message}`);
        if (body.error) throw new Error(body.error.message);
        return body.result as T;
      } catch (err) {
        if (err instanceof Upstream) throw err;
        last = err as Error;
      }
    }
    throw new Upstream(`Arc RPC: ${last.message}`);
  };
}

const SELECTOR = { balanceOf: "0x70a08231", name: "0x06fdde03", symbol: "0x95d89b41", decimals: "0x313ce567", totalSupply: "0x18160ddd" } as const;
/** Arc mirrors every USDC move on its native ledger, as a Transfer from this system address with 18 decimals. */
const NATIVE_LEDGER = "0xfffffffffffffffffffffffffffffffffffffffe";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (address: string): string => address.slice(2).toLowerCase().padStart(64, "0");
const toBig = (hex: string | null | undefined): bigint => (hex && hex !== "0x" ? BigInt(hex) : 0n);

export function formatUnits(value: bigint, decimals: number): string {
  const s = value.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** A string as a contract returns it: the usual dynamic encoding, or the fixed 32 bytes older tokens use. */
export function decodeString(hex: string): string | null {
  const data = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (data.length === 0) return null;
  const text = (h: string): string => Buffer.from(h, "hex").toString("utf8").replace(/\0+$/, "");
  if (data.length === 64) return text(data) || null;
  if (data.length < 128) return null;
  const offset = Number(BigInt(`0x${data.slice(0, 64)}`)) * 2;
  const length = Number(BigInt(`0x${data.slice(offset, offset + 64)}`)) * 2;
  if (!Number.isFinite(length) || length > 512) return null;
  return text(data.slice(offset + 64, offset + 64 + length)) || null;
}

interface TokenMeta { address: string; name: string | null; symbol: string | null; decimals: number | null }

/* ------------------------------------------------------------------ routes */

export interface ToolOptions {
  readonly network: string;
  readonly rpcUrls?: readonly string[];
  /** The project token, shown next to USDC in a wallet snapshot. */
  readonly token?: { readonly address: string; readonly symbol: string } | null;
}

export function mountToolHandlers(app: Hono, prefix: string, opts: ToolOptions): void {
  const rpc = rpcClient([...(opts.rpcUrls ?? []), ...(PUBLIC_RPCS[opts.network] ?? [])]);
  const call = (to: string, data: string): Promise<string> => rpc<string>("eth_call", [{ to, data }, "latest"]).catch((err) => (err instanceof Upstream && /revert|execution/i.test(err.message) ? "0x" : Promise.reject(err)));
  const tokenMeta = (address: string): Promise<TokenMeta> =>
    cached(`meta:${address.toLowerCase()}`, 3_600_000, async () => {
      if (address.toLowerCase() === NATIVE_LEDGER) return { address, name: "USDC, native ledger", symbol: "USDC", decimals: 18 };
      const [name, symbol, decimals] = await Promise.all([call(address, SELECTOR.name), call(address, SELECTOR.symbol), call(address, SELECTOR.decimals)]);
      return { address, name: decodeString(name), symbol: decodeString(symbol), decimals: decimals === "0x" ? null : Number(toBig(decimals)) };
    });

  /** Runs a handler and turns our two kinds of refusal into the status that keeps the buyer uncharged. */
  const route = (path: string, handler: (c: Context) => Promise<unknown>): void => {
    app.get(`${prefix}${path}`, async (c) => {
      try {
        return c.json((await handler(c)) as object);
      } catch (err) {
        if (err instanceof BadInput || err instanceof UnsafeUrl) return c.json({ error: err.message, charged: false }, 400);
        if (err instanceof Upstream) return c.json({ error: err.message, charged: false }, err.status === 404 ? 404 : 502);
        throw err;
      }
    });
  };

  route("/arc/wallet", async (c) => {
    const address = need(c, "address", ADDRESS, "a 0x address");
    return cached(`wallet:${address.toLowerCase()}`, 5000, async () => {
      const [native, usdc, nonce, code, project] = await Promise.all([
        rpc<string>("eth_getBalance", [address, "latest"]),
        call(ARC_USDC, SELECTOR.balanceOf + pad(address)),
        rpc<string>("eth_getTransactionCount", [address, "latest"]),
        rpc<string>("eth_getCode", [address, "latest"]),
        opts.token ? call(opts.token.address, SELECTOR.balanceOf + pad(address)) : Promise.resolve(null),
      ]);
      return {
        address,
        network: opts.network,
        type: code && code !== "0x" ? "contract" : "wallet",
        // On Arc the gas token is USDC: the native balance (18 decimals) and the ERC-20 view (6) are the same money.
        usdc: formatUnits(toBig(usdc), 6),
        nativeBalance: formatUnits(toBig(native), 18),
        ...(opts.token ? { [opts.token.symbol.toLowerCase()]: formatUnits(toBig(project), 18) } : {}),
        transactionsSent: Number(toBig(nonce)),
        ...(code && code !== "0x" ? { codeBytes: (code.length - 2) / 2 } : {}),
        source: "Arc RPC, latest block",
      };
    });
  });

  route("/arc/token", async (c) => {
    const address = need(c, "address", ADDRESS, "a 0x address");
    return cached(`token:${address.toLowerCase()}`, 30_000, async () => {
      const [meta, supply, code] = await Promise.all([tokenMeta(address), call(address, SELECTOR.totalSupply), rpc<string>("eth_getCode", [address, "latest"])]);
      if (!code || code === "0x") throw new Upstream("no contract at this address", 404);
      if (meta.decimals === null && meta.symbol === null) throw new Upstream("the contract at this address does not answer like an ERC-20", 404);
      const raw = toBig(supply);
      return { ...meta, network: opts.network, totalSupply: meta.decimals === null ? null : formatUnits(raw, meta.decimals), totalSupplyRaw: raw.toString(), source: "Arc RPC, latest block" };
    });
  });

  route("/arc/tx", async (c) => {
    const hash = need(c, "hash", TX_HASH, "a transaction hash");
    type Tx = { from: string; to: string | null; value: string; input: string; blockNumber: string | null; nonce: string };
    type Receipt = { status: string; gasUsed: string; effectiveGasPrice: string; contractAddress: string | null; logs: Array<{ address: string; topics: string[]; data: string; logIndex: string }> };
    const [tx, receipt] = await Promise.all([rpc<Tx | null>("eth_getTransactionByHash", [hash]), rpc<Receipt | null>("eth_getTransactionReceipt", [hash])]);
    if (!tx) throw new Upstream("no transaction with this hash on Arc", 404);
    const block = tx.blockNumber ? await rpc<{ timestamp: string } | null>("eth_getBlockByNumber", [tx.blockNumber, false]) : null;
    const moves = (receipt?.logs ?? []).filter((l) => l.topics[0] === TRANSFER_TOPIC && l.topics.length === 3);
    const metas = new Map<string, TokenMeta>();
    await Promise.all([...new Set(moves.map((l) => l.address.toLowerCase()))].slice(0, 12).map(async (a) => metas.set(a, await tokenMeta(a).catch(() => ({ address: a, name: null, symbol: null, decimals: null })))));
    const transfers = moves.slice(0, 100).map((l) => {
      const m = metas.get(l.address.toLowerCase());
      const raw = toBig(l.data);
      return { token: l.address, symbol: m?.symbol ?? null, from: `0x${l.topics[1]!.slice(26)}`, to: `0x${l.topics[2]!.slice(26)}`, amount: m?.decimals == null ? null : formatUnits(raw, m.decimals), amountRaw: raw.toString(), logIndex: Number(toBig(l.logIndex)) };
    });
    const fee = receipt ? toBig(receipt.gasUsed) * toBig(receipt.effectiveGasPrice) : null;
    return {
      hash,
      network: opts.network,
      status: !receipt ? "pending" : receipt.status === "0x1" ? "success" : "reverted",
      block: tx.blockNumber ? Number(toBig(tx.blockNumber)) : null,
      timestamp: block ? Number(toBig(block.timestamp)) : null,
      from: tx.from,
      to: tx.to,
      ...(receipt?.contractAddress ? { deployed: receipt.contractAddress } : {}),
      kind: tx.to === null ? "contract deploy" : tx.input === "0x" ? "plain transfer" : "contract call",
      selector: tx.input.length >= 10 ? tx.input.slice(0, 10) : null,
      valueUsdc: formatUnits(toBig(tx.value), 18),
      gasUsed: receipt ? Number(toBig(receipt.gasUsed)) : null,
      feeUsdc: fee === null ? null : formatUnits(fee, 18),
      transfers,
      transfersTruncated: moves.length > transfers.length,
      ...(moves.some((l) => l.address.toLowerCase() === NATIVE_LEDGER) ? { note: `Arc records a USDC move twice: as the ERC-20 event from ${ARC_USDC} and on the native ledger from ${NATIVE_LEDGER}. It is the same money, listed once per record.` } : {}),
      source: "Arc RPC",
    };
  });

  /* -------------------------------------------------------------- the web */

  route("/web/extract", async (c) => {
    const url = need(c, "url", /^https?:\/\//i, "an http(s) URL");
    return cached(`extract:${url}`, 60_000, async () => {
      const page = await safeFetch(url).catch((err: Error) => Promise.reject(err instanceof UnsafeUrl ? err : new Upstream(`could not fetch the page: ${err.message}`)));
      if (page.status >= 400) throw new Upstream(`the page answered ${page.status}`);
      const type = page.headers["content-type"] ?? "";
      if (!/html|xml|text\/plain/i.test(type)) throw new Upstream(`not a readable page: ${type || "unknown content type"}`);
      const html = page.body.toString("utf8");
      const out = /text\/plain/i.test(type) ? { title: null, description: null, headings: [], text: html.slice(0, 20_000), textTruncated: html.length > 20_000 } : extractReadable(html);
      return { url, finalUrl: page.finalUrl, status: page.status, contentType: type, ...out, words: out.text ? out.text.split(/\s+/).length : 0, pageTruncated: page.truncated, fetchedAt: Math.floor(Date.now() / 1000) };
    });
  });

  route("/web/check", async (c) => {
    const url = need(c, "url", /^https?:\/\//i, "an http(s) URL");
    return cached(`check:${url}`, 15_000, async () => {
      const started = Date.now();
      const page = await safeFetch(url, { maxBytes: 64_000 }).catch((err: Error) => Promise.reject(err instanceof UnsafeUrl ? err : new Upstream(`could not reach it: ${err.message}`)));
      const wanted = ["strict-transport-security", "content-security-policy", "x-content-type-options", "x-frame-options", "referrer-policy", "permissions-policy"];
      return {
        url,
        finalUrl: page.finalUrl,
        up: page.status > 0 && page.status < 500,
        status: page.status,
        totalMs: Date.now() - started,
        redirects: page.hops.slice(0, -1),
        https: page.finalUrl.startsWith("https://"),
        server: page.headers.server ?? null,
        contentType: page.headers["content-type"] ?? null,
        securityHeaders: Object.fromEntries(wanted.map((h) => [h, page.headers[h] ?? null])),
        missingSecurityHeaders: wanted.filter((h) => !page.headers[h]),
        checkedAt: Math.floor(Date.now() / 1000),
        from: "a single vantage point: ours",
      };
    });
  });

  /* -------------------------------------------------------------- packages */

  route("/packages/npm", async (c) => {
    const name = need(c, "name", NPM_NAME, "an npm package name");
    return cached(`npm:${name}`, 300_000, async () => {
      type Doc = { "dist-tags"?: Record<string, string>; time?: Record<string, string>; versions?: Record<string, { license?: unknown; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; deprecated?: string; engines?: Record<string, string>; repository?: { url?: string } | string; homepage?: string; description?: string }> };
      const doc = await getJson<Doc>(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, { notFound: `no npm package called ${name}` });
      const latest = doc["dist-tags"]?.latest;
      const v = latest ? doc.versions?.[latest] : undefined;
      if (!latest || !v) throw new Upstream(`${name} has no published version`, 404);
      const downloads = await getJson<{ downloads?: number }>(`https://api.npmjs.org/downloads/point/last-week/${name}`).catch(() => ({ downloads: undefined }));
      const repo = typeof v.repository === "string" ? v.repository : v.repository?.url;
      return {
        name,
        latest,
        publishedAt: doc.time?.[latest] ?? null,
        firstPublishedAt: doc.time?.created ?? null,
        versions: Object.keys(doc.versions ?? {}).length,
        distTags: doc["dist-tags"],
        description: v.description ?? null,
        license: typeof v.license === "string" ? v.license : null,
        deprecated: v.deprecated ?? null,
        weeklyDownloads: downloads.downloads ?? null,
        dependencies: v.dependencies ?? {},
        peerDependencies: v.peerDependencies ?? {},
        engines: v.engines ?? {},
        repository: repo?.replace(/^git\+/, "").replace(/\.git$/, "") ?? null,
        homepage: v.homepage ?? null,
        source: "registry.npmjs.org",
      };
    });
  });

  route("/packages/pypi", async (c) => {
    const name = need(c, "name", PYPI_NAME, "a PyPI project name");
    return cached(`pypi:${name.toLowerCase()}`, 300_000, async () => {
      type Doc = { info: { name: string; version: string; summary?: string; license?: string; license_expression?: string; requires_python?: string; requires_dist?: string[] | null; home_page?: string; project_urls?: Record<string, string> | null; yanked?: boolean }; urls?: Array<{ upload_time_iso_8601?: string }>; vulnerabilities?: Array<{ id: string; aliases?: string[]; summary?: string; fixed_in?: string[]; link?: string }> };
      const doc = await getJson<Doc>(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, { notFound: `no PyPI project called ${name}` });
      const license = doc.info.license_expression ?? doc.info.license ?? null;
      return {
        name: doc.info.name,
        latest: doc.info.version,
        publishedAt: doc.urls?.[0]?.upload_time_iso_8601 ?? null,
        summary: doc.info.summary ?? null,
        // Some projects paste the whole licence text in this field; a name is what is useful.
        license: license && license.length <= 80 ? license : null,
        requiresPython: doc.info.requires_python ?? null,
        yanked: doc.info.yanked === true,
        dependencies: doc.info.requires_dist ?? [],
        advisories: (doc.vulnerabilities ?? []).map((a) => ({ id: a.id, aliases: a.aliases ?? [], summary: a.summary ?? null, fixedIn: a.fixed_in ?? [], link: a.link ?? null })),
        homepage: doc.info.project_urls?.Homepage ?? doc.info.home_page ?? null,
        source: "pypi.org",
      };
    });
  });

  route("/packages/vulns", async (c) => {
    const ecosystemIn = (param(c, "ecosystem") ?? "npm").toLowerCase();
    const ecosystems: Record<string, string> = { npm: "npm", pypi: "PyPI", go: "Go", "crates.io": "crates.io", cargo: "crates.io", maven: "Maven", rubygems: "RubyGems", nuget: "NuGet", packagist: "Packagist" };
    const ecosystem = ecosystems[ecosystemIn];
    if (!ecosystem) throw new BadInput(`ecosystem is not one of ${Object.keys(ecosystems).join(", ")}`);
    const name = need(c, "name", /^[A-Za-z0-9@][A-Za-z0-9@/._:~-]*$/, "a package name");
    const version = optional(c, "version", VERSION, "a version");
    return cached(`vulns:${ecosystem}:${name}:${version ?? ""}`, 300_000, async () => {
      type Vuln = { id: string; aliases?: string[]; summary?: string; published?: string; modified?: string; database_specific?: { severity?: string }; severity?: Array<{ type: string; score: string }>; affected?: Array<{ package?: { name?: string }; ranges?: Array<{ events?: Array<{ introduced?: string; fixed?: string }> }> }>; references?: Array<{ url: string }> };
      const body = JSON.stringify({ package: { name, ecosystem }, ...(version ? { version } : {}) });
      const res = await getJson<{ vulns?: Vuln[] }>("https://api.osv.dev/v1/query", { method: "POST", body });
      const advisories = (res.vulns ?? []).map((v) => ({
        id: v.id,
        aliases: v.aliases ?? [],
        summary: v.summary ?? null,
        severity: v.database_specific?.severity ?? null,
        cvss: v.severity?.[0]?.score ?? null,
        fixedIn: [...new Set((v.affected ?? []).filter((a) => !a.package?.name || a.package.name === name).flatMap((a) => (a.ranges ?? []).flatMap((r) => (r.events ?? []).map((e) => e.fixed).filter((f): f is string => Boolean(f)))))],
        published: v.published ?? null,
        modified: v.modified ?? null,
        link: `https://osv.dev/vulnerability/${v.id}`,
      }));
      return { ecosystem, name, version: version ?? null, scope: version ? "this exact version" : "every version ever published", count: advisories.length, advisories: advisories.slice(0, 100), truncated: advisories.length > 100, source: "osv.dev" };
    });
  });

  /* -------------------------------------------------------------- domains */

  const DNS_TYPES: Record<string, number> = { A: 1, NS: 2, CNAME: 5, SOA: 6, MX: 15, TXT: 16, AAAA: 28, CAA: 257 };
  route("/domains/dns", async (c) => {
    const name = need(c, "name", HOSTNAME, "a host name").replace(/\.$/, "").toLowerCase();
    const asked = (param(c, "type") ?? "A,AAAA,CNAME,MX,TXT,NS").toUpperCase().split(",").map((t) => t.trim()).filter(Boolean);
    if (asked.length === 0 || asked.length > 8 || asked.some((t) => !(t in DNS_TYPES))) throw new BadInput(`type is a comma-separated list of ${Object.keys(DNS_TYPES).join(", ")}`);
    return cached(`dns:${name}:${asked.join(",")}`, 30_000, async () => {
      type Doh = { Status: number; AD?: boolean; Answer?: Array<{ name: string; type: number; TTL: number; data: string }> };
      const answers = await Promise.all(asked.map((t) => getJson<Doh>(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${t}&do=1`)));
      const byNumber = Object.fromEntries(Object.entries(DNS_TYPES).map(([k, v]) => [v, k]));
      const records = Object.fromEntries(asked.map((t, i) => [t, (answers[i]!.Answer ?? []).filter((a) => a.type === DNS_TYPES[t]).map((a) => ({ value: a.data, ttl: a.TTL }))]));
      const status = answers[0]!.Status;
      return {
        name,
        exists: status !== 3,
        status: status === 0 ? "NOERROR" : status === 3 ? "NXDOMAIN" : status === 2 ? "SERVFAIL" : `RCODE ${status}`,
        // Validated by the resolver: every answer it gave came back with the authenticated flag set.
        dnssec: answers.some((a) => (a.Answer ?? []).length > 0) && answers.filter((a) => (a.Answer ?? []).length > 0).every((a) => a.AD === true),
        records,
        aliases: [...new Set(answers.flatMap((a) => (a.Answer ?? []).filter((r) => byNumber[r.type] === "CNAME").map((r) => r.data)))],
        source: "dns.google (DNS over HTTPS)",
      };
    });
  });

  route("/domains/whois", async (c) => {
    const domain = need(c, "domain", HOSTNAME, "a domain name").replace(/\.$/, "").toLowerCase();
    return cached(`rdap:${domain}`, 600_000, async () => {
      type Entity = { roles?: string[]; vcardArray?: [string, Array<[string, unknown, string, unknown]>]; publicIds?: Array<{ type: string; identifier: string }> };
      type Rdap = { ldhName?: string; status?: string[]; events?: Array<{ eventAction: string; eventDate: string }>; nameservers?: Array<{ ldhName?: string }>; entities?: Entity[]; secureDNS?: { delegationSigned?: boolean } };
      let doc: Rdap;
      try {
        doc = await getJson<Rdap>(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { headers: { accept: "application/rdap+json, application/json" } });
      } catch (err) {
        // The registry saying "not found" is the answer to "is it taken?", not a failure.
        if (err instanceof Upstream && err.status === 404) return { domain, registered: false, looksAvailable: true, note: "No registration record. Registries can hold names back, so check with a registrar before relying on it.", source: "RDAP via rdap.org" };
        throw err;
      }
      const when = (action: string): string | null => doc.events?.find((e) => e.eventAction === action)?.eventDate ?? null;
      const registrar = doc.entities?.find((e) => e.roles?.includes("registrar"));
      const fn = registrar?.vcardArray?.[1]?.find((f) => f[0] === "fn")?.[3];
      const expires = when("expiration");
      return {
        domain: doc.ldhName?.toLowerCase() ?? domain,
        registered: true,
        looksAvailable: false,
        registrar: typeof fn === "string" ? fn : null,
        registrarIanaId: registrar?.publicIds?.find((p) => /iana/i.test(p.type))?.identifier ?? null,
        createdAt: when("registration"),
        updatedAt: when("last changed"),
        expiresAt: expires,
        daysToExpiry: expires ? Math.floor((Date.parse(expires) - Date.now()) / 86_400_000) : null,
        status: doc.status ?? [],
        nameservers: (doc.nameservers ?? []).map((n) => n.ldhName?.toLowerCase()).filter(Boolean),
        dnssecSigned: doc.secureDNS?.delegationSigned ?? null,
        source: "RDAP via rdap.org",
      };
    });
  });

  /* -------------------------------------------------------------- currencies */

  const rates = (base: string, date: string | undefined): Promise<{ base: string; date: string; rates: Record<string, number> }> =>
    cached(`rates:${base}:${date ?? "latest"}`, date ? 86_400_000 : 900_000, () => getJson(`https://api.frankfurter.dev/v1/${date ?? "latest"}?base=${base}`, { notFound: `no reference rates for ${base}${date ? ` on ${date}` : ""}` }));
  const RATES_NOTE = "European Central Bank reference rates, set once per working day around 16:00 CET. A reference, not a price anyone trades at; for executed rates on Arc see /v1/paid/fx/execution.";

  route("/currency/rates", async (c) => {
    const base = (optional(c, "base", CURRENCY, "a three-letter currency code") ?? "USD").toUpperCase();
    const date = optional(c, "date", DATE, "a date as YYYY-MM-DD");
    const only = param(c, "symbols")?.toUpperCase().split(",").map((s) => s.trim()).filter(Boolean);
    if (only && (only.length > 40 || only.some((s) => !CURRENCY.test(s)))) throw new BadInput("symbols is a comma-separated list of three-letter currency codes");
    const r = await rates(base, date);
    const picked = only ? Object.fromEntries(Object.entries(r.rates).filter(([k]) => only.includes(k))) : r.rates;
    return { base: r.base, date: r.date, rates: picked, note: RATES_NOTE, source: "ECB via frankfurter.dev" };
  });

  route("/currency/convert", async (c) => {
    const from = need(c, "from", CURRENCY, "a three-letter currency code").toUpperCase();
    const to = need(c, "to", CURRENCY, "a three-letter currency code").toUpperCase();
    const amountRaw = need(c, "amount", /^\d{1,15}(\.\d{1,8})?$/, "a positive number");
    const date = optional(c, "date", DATE, "a date as YYYY-MM-DD");
    const amount = Number(amountRaw);
    const r = from === to ? { base: from, date: date ?? new Date().toISOString().slice(0, 10), rates: { [to]: 1 } } : await rates(from, date);
    const rate = r.rates[to];
    if (rate === undefined) throw new Upstream(`no reference rate from ${from} to ${to}`, 404);
    return { from, to, amount, rate, result: Number((amount * rate).toFixed(6)), date: r.date, note: RATES_NOTE, source: "ECB via frankfurter.dev" };
  });

  /* -------------------------------------------------------------- Wikipedia */

  const WIKI_LICENSE = { text: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/", attribution: "Wikipedia contributors" };
  const wikiLang = (c: Context): string => optional(c, "lang", LANG, "a Wikipedia language code like en or it") ?? "en";
  const stripTags = (s: string): string => s.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#0?39;/g, "'");

  route("/wiki/search", async (c) => {
    const q = need(c, "q", /\S/, "a search query");
    const lang = wikiLang(c);
    const limit = Math.min(20, Math.max(1, Number(param(c, "limit") ?? 5) || 5));
    return cached(`wsearch:${lang}:${limit}:${q.toLowerCase()}`, 300_000, async () => {
      type Res = { pages?: Array<{ key: string; title: string; description?: string | null; excerpt?: string }> };
      const res = await getJson<Res>(`https://${lang}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(q)}&limit=${limit}`, { notFound: `no Wikipedia in the language ${lang}` });
      return { query: q, lang, results: (res.pages ?? []).map((p) => ({ title: p.title, key: p.key, description: p.description ?? null, excerpt: p.excerpt ? stripTags(p.excerpt) : null, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.key)}` })), license: WIKI_LICENSE, source: `${lang}.wikipedia.org` };
    });
  });

  route("/wiki/summary", async (c) => {
    const title = need(c, "title", /\S/, "an article title");
    const lang = wikiLang(c);
    return cached(`wsum:${lang}:${title.toLowerCase()}`, 300_000, async () => {
      type Sum = { title: string; description?: string; extract?: string; type?: string; timestamp?: string; thumbnail?: { source: string }; originalimage?: { source: string }; content_urls?: { desktop?: { page?: string } } };
      const s = await getJson<Sum>(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`, { notFound: `no article called ${title} on ${lang}.wikipedia.org` });
      return { title: s.title, lang, description: s.description ?? null, summary: s.extract ?? null, disambiguation: s.type === "disambiguation", image: s.originalimage?.source ?? s.thumbnail?.source ?? null, updatedAt: s.timestamp ?? null, url: s.content_urls?.desktop?.page ?? null, license: WIKI_LICENSE, source: `${lang}.wikipedia.org` };
    });
  });

  route("/wiki/article", async (c) => {
    const title = need(c, "title", /\S/, "an article title");
    const lang = wikiLang(c);
    return cached(`wart:${lang}:${title.toLowerCase()}`, 300_000, async () => {
      type Q = { query?: { pages?: Array<{ title: string; missing?: boolean; extract?: string; touched?: string; fullurl?: string }> } };
      const res = await getJson<Q>(`https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts%7Cinfo&explaintext=1&exsectionformat=plain&redirects=1&inprop=url&format=json&formatversion=2&titles=${encodeURIComponent(title)}`, { notFound: `no Wikipedia in the language ${lang}` });
      const page = res.query?.pages?.[0];
      if (!page || page.missing || !page.extract) throw new Upstream(`no article called ${title} on ${lang}.wikipedia.org`, 404);
      const max = 20_000;
      return { title: page.title, lang, text: page.extract.slice(0, max), characters: Math.min(page.extract.length, max), truncated: page.extract.length > max, updatedAt: page.touched ?? null, url: page.fullurl ?? null, license: WIKI_LICENSE, source: `${lang}.wikipedia.org` };
    });
  });
}
