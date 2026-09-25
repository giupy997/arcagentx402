/**
 * Request binding for `exact` on `lnbtc`: the invoice's signed description hash commits to the request it
 * pays for, so a paid invoice buys that request and no other. The hash is SHA-256 over the JCS (RFC 8785)
 * encoding of a small object built from the request: for HTTP its method, URL, body digest and the headers
 * the seller says matter; for MCP the server, the tool, its arguments and the metadata that matter.
 */
import { createHash } from "node:crypto";

export type BindingProfile = "http:1" | "mcp:1";
export type HttpBindingParams = { headers: string[] };
export type McpBindingParams = { server: string; metadata: string[] };

export class BindingError extends Error {
  override readonly name = "BindingError";
}

const sha256hex = (...parts: Uint8Array[]): string => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest("hex");
};
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A string JCS will accept: no lone surrogates, which UTF-8 cannot carry. */
function checkString(s: string): void {
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)) throw new BindingError("invalid Unicode: a lone surrogate");
}

/**
 * JSON Canonicalization Scheme (RFC 8785): members sorted by UTF-16 code units, strings escaped and numbers
 * written the way ECMAScript does, which JSON.stringify already follows. Rejects what JCS cannot represent.
 */
export function jcs(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new BindingError("JCS has no NaN or Infinity");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    checkString(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new BindingError("JCS takes plain objects only");
    const keys = Object.keys(value as object).sort();
    return `{${keys.map((k) => {
      checkString(k);
      return `${JSON.stringify(k)}:${jcs((value as Record<string, unknown>)[k])}`;
    }).join(",")}}`;
  }
  throw new BindingError(`JCS cannot encode a ${typeof value}`);
}

/** An HTTP header name: a lowercase token (RFC 9110). */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
/** An absolute http(s) URL in ASCII, without user information or a fragment. */
function checkUrl(url: string, what: string, schemes: readonly string[]): void {
  if (typeof url !== "string" || !/^[\x21-\x7e]+$/.test(url)) throw new BindingError(`${what} is not an ASCII URI`);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new BindingError(`${what} is not an absolute URI`);
  }
  if (!schemes.includes(u.protocol)) throw new BindingError(`${what} must be ${schemes.join(" or ")}`);
  if (u.username || u.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(url)) throw new BindingError(`${what} must not carry user information`);
  if (url.includes("#")) throw new BindingError(`${what} must not carry a fragment`);
}

/** The profile's parameters, checked: exactly its members, each well formed. Throws BindingError. */
export function checkParams(profile: unknown, params: unknown): asserts params is HttpBindingParams | McpBindingParams {
  if (profile !== "http:1" && profile !== "mcp:1") throw new BindingError(`unsupported request binding profile: ${String(profile)}`);
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new BindingError("request binding params must be an object");
  const keys = Object.keys(params).sort();
  if (profile === "http:1") {
    if (keys.length !== 1 || keys[0] !== "headers") throw new BindingError("http:1 takes exactly { headers }");
    const headers = (params as HttpBindingParams).headers;
    if (!Array.isArray(headers)) throw new BindingError("headers must be an array");
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      if (typeof h !== "string" || !TOKEN.test(h)) throw new BindingError(`bad header name: ${String(h)}`);
      if (h === "payment-signature") throw new BindingError("payment-signature cannot be bound");
      if (i > 0 && !(headers[i - 1]! < h)) throw new BindingError("header names must be in ascending order, without duplicates");
    }
    return;
  }
  if (keys.length !== 2 || keys[0] !== "metadata" || keys[1] !== "server") throw new BindingError("mcp:1 takes exactly { server, metadata }");
  const { server, metadata } = params as McpBindingParams;
  checkUrl(server, "server", ["http:", "https:", "ws:", "wss:", "stdio:", "urn:"]);
  if (!Array.isArray(metadata)) throw new BindingError("metadata must be an array");
  for (let i = 0; i < metadata.length; i++) {
    const m = metadata[i];
    if (typeof m !== "string" || m.length === 0) throw new BindingError("metadata names are non-empty strings");
    checkString(m);
    if (m === "x402/payment" || m === "progressToken") throw new BindingError(`${m} cannot be bound`);
    if (i > 0 && !(metadata[i - 1]! < m)) throw new BindingError("metadata names must be in JCS order, without duplicates");
  }
}

export interface HttpRequestForBinding {
  /** As the request carries it; case is kept. */
  method: string;
  /** The absolute URL, as the public origin plus the request target, query order and escapes kept. */
  url: string;
  /** The content bytes after transfer decoding; null for no body. */
  body: Uint8Array | null;
  /** A header's value, combined as HTTP does for repeated fields; null when absent. */
  header(name: string): string | null;
}

/** RFC 9421 2.1 for a field value without parameters: trimmed, visible ASCII and spaces only. */
function headerValue(v: string): string {
  const t = v.replace(/^[ \t]+|[ \t]+$/g, "");
  if (!/^[\x20-\x7e]*$/.test(t)) throw new BindingError("a bound header has a value this profile cannot represent");
  return t;
}

export function httpBinding(req: HttpRequestForBinding, params: HttpBindingParams): { binding: Record<string, unknown>; requestHash: string } {
  checkParams("http:1", params);
  checkUrl(req.url, "url", ["http:", "https:"]);
  if (typeof req.method !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(req.method)) throw new BindingError("bad HTTP method");
  const binding = {
    domain: "x402:exact:lnbtc:bolt11:http:1",
    method: req.method,
    url: req.url,
    bodyHash: sha256hex(req.body ?? new Uint8Array(0)),
    headers: params.headers.map((name) => {
      const v = req.header(name);
      return { name, valueHash: v === null ? sha256hex(new Uint8Array([0])) : sha256hex(new Uint8Array([1]), utf8(headerValue(v))) };
    }),
  };
  return { binding, requestHash: sha256hex(utf8(jcs(binding))) };
}

export interface McpCallForBinding {
  name: string;
  /** params.arguments as sent; undefined when omitted. */
  arguments?: unknown;
  /** params._meta as sent; undefined when omitted. */
  meta?: unknown;
}

export function mcpBinding(call: McpCallForBinding, params: McpBindingParams): { binding: Record<string, unknown>; requestHash: string } {
  checkParams("mcp:1", params);
  if (typeof call.name !== "string" || call.name.length === 0) throw new BindingError("a tool call names its tool");
  const args = call.arguments === undefined ? {} : call.arguments;
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw new BindingError("tool arguments must be an object");
  const meta = call.meta === undefined ? {} : call.meta;
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) throw new BindingError("_meta must be an object");
  const binding = {
    domain: "x402:exact:lnbtc:bolt11:mcp:1",
    server: params.server,
    method: "tools/call",
    name: call.name,
    arguments: args,
    metadata: params.metadata.map((name) => {
      const present = Object.prototype.hasOwnProperty.call(meta, name);
      return { name, valueHash: present ? sha256hex(new Uint8Array([1]), utf8(jcs((meta as Record<string, unknown>)[name]))) : sha256hex(new Uint8Array([0])) };
    }),
  };
  return { binding, requestHash: sha256hex(utf8(jcs(binding))) };
}
