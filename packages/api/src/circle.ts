/**
 * Circle's x402 catalogue, the list behind its Agent Marketplace, as things an agent can search.
 *
 * Circle lists paid endpoints that take USDC on many chains. The ones that take it on Arc can be
 * bought today by an agent running CRA AGENT, so search covers them too, marked as Circle's. The
 * list is read every hour from Circle's public discovery API, and only what an agent can actually
 * call is kept: GET or POST, https, a payee on Arc and a price above zero. We do not call these
 * endpoints to check them, and the search says so: what is shown is what Circle lists.
 */
import type { Logger } from "pino";
import type { ParamExample, SearchItem, SearchParam } from "./search.js";
import { clean } from "./text.js";

export const CIRCLE_DISCOVERY = "https://api.circle.com/v2/x402/discovery/resources";

const PAGE = 100;
const MAX_PAGES = 30;
const MAX_PARAMS = 16;
/** Circle refreshes its entries every day or so; one it has not touched in a week is not shown. */
const STALE_MS = 7 * 86_400_000;
/** Tags every entry carries, which say nothing about what it sells. */
const NOISE_TAGS = new Set(["x402", "paid-api", "orthogonal-proxy", "agentic-markets", "data-apis"]);

interface Schema {
  type?: unknown;
  description?: unknown;
  title?: unknown;
  example?: unknown;
  examples?: unknown;
  enum?: unknown;
  deprecated?: unknown;
  properties?: unknown;
  required?: unknown;
  allOf?: unknown;
  oneOf?: unknown;
  anyOf?: unknown;
  items?: unknown;
}
interface Accept {
  scheme?: unknown;
  network?: unknown;
  amount?: unknown;
  payTo?: unknown;
  extra?: { name?: unknown } | null;
}
/** One entry of the discovery API, as far as it is read here. Everything is checked before use. */
export interface CircleEntry {
  resource?: unknown;
  lastUpdated?: unknown;
  accepts?: unknown;
  metadata?: {
    provider?: { name?: unknown; description?: unknown; category?: unknown; tags?: unknown; website?: unknown } | null;
    method?: unknown;
    description?: unknown;
    input?: { queryParams?: unknown; pathParams?: unknown; body?: unknown } | null;
  } | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A schema's fields and the names it requires, with its allOf branches folded in. */
function fieldsOf(schema: unknown, depth = 0): { props: Array<[string, Schema]>; required: Set<string> } {
  const props: Array<[string, Schema]> = [];
  const required = new Set<string>();
  if (!isObject(schema) || depth > 3) return { props, required };
  const s = schema as Schema;
  if (isObject(s.properties)) for (const [name, field] of Object.entries(s.properties)) if (isObject(field)) props.push([name, field as Schema]);
  if (Array.isArray(s.required)) for (const r of s.required) if (typeof r === "string") required.add(r);
  if (Array.isArray(s.allOf)) {
    for (const part of s.allOf) {
      const inner = fieldsOf(part, depth + 1);
      props.push(...inner.props);
      for (const r of inner.required) required.add(r);
    }
  }
  return { props, required };
}

function typeOf(s: Schema): string {
  if (typeof s.type === "string") {
    const item = isObject(s.items) && typeof s.items.type === "string" ? s.items.type : null;
    return s.type === "array" && item ? `array of ${item}` : s.type;
  }
  const alternatives = [s.oneOf, s.anyOf].find(Array.isArray) as unknown[] | undefined;
  const types = [...new Set((alternatives ?? []).map((a) => (isObject(a) && typeof a.type === "string" ? a.type : null)).filter((t): t is string => t !== null && t !== "null"))];
  if (types.length) return types.join(" or ");
  return Array.isArray(s.enum) ? "string" : "any";
}

/** The field's own words, and the values it takes when it lists them. */
function describe(s: Schema): string {
  const words = clean(s.description, 160) ?? clean(s.title, 80) ?? "";
  const values = Array.isArray(s.enum) ? s.enum.filter((v): v is string | number => typeof v === "string" || typeof v === "number").map(String) : [];
  if (!values.length) return words;
  const list = `One of: ${values.slice(0, 6).join(", ")}${values.length > 6 ? ", …" : ""}`;
  return clean(words ? `${words} ${list}` : list, 240) ?? "";
}

/** An example the seller gave, if it is small enough to pass on. */
function exampleOf(s: Schema): ParamExample {
  const given = s.example !== undefined ? s.example : Array.isArray(s.examples) && s.examples.length ? s.examples[0] : undefined;
  if (typeof given === "string") return clean(given, 200);
  if (typeof given === "boolean") return given;
  if (typeof given === "number") return Number.isFinite(given) ? given : null;
  if (given === undefined || given === null) return null;
  try {
    const text = JSON.stringify(given);
    return text.length <= 300 ? (JSON.parse(text) as ParamExample) : null;
  } catch {
    return null;
  }
}

function paramsOf(input: NonNullable<CircleEntry["metadata"]>["input"]): SearchParam[] {
  const out: SearchParam[] = [];
  const add = (where: SearchParam["in"], schema: unknown): void => {
    const { props, required } = fieldsOf(schema);
    for (const [raw, s] of props) {
      if (s.deprecated === true) continue;
      // Path parameters are named ":hash" in the schema and {hash} in the address.
      const name = clean(raw.replace(/^:/, ""), 60);
      if (!name || out.some((p) => p.name === name && p.in === where)) continue;
      out.push({ name, in: where, type: typeOf(s), description: describe(s), required: where === "path" || required.has(raw), example: exampleOf(s) });
    }
  };
  if (isObject(input)) {
    add("path", input.pathParams);
    add("query", input.queryParams);
    add("body", input.body);
  }
  // What the call cannot do without comes first, so a long list cut short still has it.
  return out.sort((a, b) => Number(b.required) - Number(a.required)).slice(0, MAX_PARAMS);
}

const scalar = (v: ParamExample): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** The address with the seller's examples put in; a {placeholder} without one stays for the agent to fill. */
function callUrl(resource: string, params: readonly SearchParam[]): string {
  let url = resource;
  for (const p of params) if (p.in === "path" && scalar(p.example)) url = url.replace(`{${p.name}}`, encodeURIComponent(String(p.example)));
  const query = params
    .filter((p) => p.in === "query" && scalar(p.example))
    .map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(String(p.example))}`)
    .join("&");
  return query ? `${url}${url.includes("?") ? "&" : "?"}${query}` : url;
}

/** A path as people read it, {placeholders} and all. */
const readable = (pathname: string): string => {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
};

/** Circle's category codes, in plain words. */
const CATEGORY: Record<string, string> = {
  DATA_ENRICHMENT: "Data enrichment",
  WEB_SEARCH_RESEARCH: "Web search & research",
  INFRASTRUCTURE: "Infrastructure",
  FINANCIAL_ANALYSIS: "Financial data",
  SOCIAL_INTELLIGENCE: "Social data",
  PREDICTION_MARKETS: "Prediction markets",
  CREATIVE: "Creative AI",
};

/** A website as an origin, when it is one: https only, no credentials. */
function siteOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password ? u.origin : null;
  } catch {
    return null;
  }
}

const usd = (units: string): string => (Number(units) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");

/** One entry as a search item, or null when an agent on this network could not buy it as listed. */
export function circleItem(entry: unknown, network: string, now: number): SearchItem | null {
  if (!isObject(entry)) return null;
  const e = entry as CircleEntry;
  if (typeof e.resource !== "string" || e.resource.length > 400) return null;
  let url: URL;
  try {
    url = new URL(e.resource);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const meta = isObject(e.metadata) ? e.metadata : {};
  const method = typeof meta.method === "string" ? meta.method.toUpperCase() : "GET";
  // arc_pay and every x402 client we ship call with GET or POST; the rest are account chores.
  if (method !== "GET" && method !== "POST") return null;

  const valid = (Array.isArray(e.accepts) ? e.accepts : []).filter(
    (a): a is Accept =>
      isObject(a) && a.network === network && a.scheme === "exact" && typeof a.payTo === "string" && /^0x[0-9a-fA-F]{40}$/.test(a.payTo) && typeof a.amount === "string" && /^\d{1,12}$/.test(a.amount) && BigInt(a.amount) > 0n,
  );
  const batched = (a: Accept): boolean => isObject(a.extra) && a.extra.name === "GatewayWalletBatched";
  // Our router takes the batched option when there is one, so that is the price the agent will see.
  const accept = valid.find(batched) ?? valid[0];
  if (!accept) return null;

  const provider = isObject(meta.provider) ? meta.provider : {};
  const params = paramsOf(meta.input);
  // The smallest call that works: the required fields the seller gave examples for, and nothing it would
  // do on top because an optional example was left in.
  const bodyParams = params.filter((p) => p.in === "body" && p.required && p.example !== null);
  const tags = (Array.isArray(provider.tags) ? provider.tags : []).filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase()).filter((t) => !NOISE_TAGS.has(t)).slice(0, 20);
  const category = typeof provider.category === "string" ? provider.category.toLowerCase().replace(/_/g, " ") : "";
  const readableCategory = typeof provider.category === "string" ? (CATEGORY[provider.category] ?? clean(provider.category.toLowerCase().replace(/_/g, " "), 40)) : null;
  const seen = typeof e.lastUpdated === "string" ? Date.parse(e.lastUpdated) : Number.NaN;
  return {
    url: callUrl(e.resource, params),
    method,
    priceUsd: usd(accept.amount as string),
    name: clean(provider.name, 80) ?? url.host,
    label: clean(meta.description, 200),
    description: clean(provider.description, 240),
    params,
    payTo: (accept.payTo as string).toLowerCase(),
    host: url.host.toLowerCase(),
    network,
    rail: batched(accept) ? "gateway" : "direct",
    direct: null,
    body: method === "POST" && bodyParams.length ? Object.fromEntries(bodyParams.map((p) => [p.name, p.example])) : null,
    source: "circle",
    category: readableCategory,
    site: siteOf(provider.website) ?? url.origin,
    networks: [network, ...new Set((e.accepts as unknown[]).flatMap((a) => (isObject(a) && typeof a.network === "string" && a.network !== network && a.network.length <= 64 ? [a.network] : [])))].slice(0, 12),
    // An exact accept that is not Gateway's batched one is a plain transfer any x402 client can sign.
    plainNetworks: [...new Set((e.accepts as unknown[]).flatMap((a) => (isObject(a) && a.scheme === "exact" && typeof a.network === "string" && a.network.length <= 64 && !(isObject(a.extra) && a.extra.name === "GatewayWalletBatched") ? [a.network] : [])))].slice(0, 12),
    online: Number.isFinite(seen) && now - seen < STALE_MS,
    keywords: clean(`${tags.join(" ")} ${category} ${readable(url.pathname).replace(/[/_{}:.-]+/g, " ")}`, 600) ?? "",
  };
}

/**
 * The whole catalogue as search items: one per method and address. A label a seller gave to many of
 * its entries says nothing about any one of them, so those get the call itself added to it.
 */
export function circleItems(entries: readonly unknown[], network: string, now: number): SearchItem[] {
  const items: SearchItem[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const item = circleItem(entry, network, now);
    const key = item ? `${item.method} ${item.url}` : "";
    if (!item || seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  const shared = new Map<string, number>();
  for (const i of items) if (i.label) shared.set(`${i.host} ${i.label}`, (shared.get(`${i.host} ${i.label}`) ?? 0) + 1);
  return items.map((i) => {
    if (!i.label || (shared.get(`${i.host} ${i.label}`) ?? 0) < 3) return i;
    const path = readable(new URL(i.url).pathname);
    // The path only: the method is its own field, and "POST" in a label would match "posts" in a question.
    return { ...i, label: clean(`${i.label}: ${path}`, 200) };
  });
}

/** Every entry Circle lists as payable on this network, page by page. */
export async function fetchCircleCatalogue(network: string, opts: { url?: string; fetchImpl?: typeof fetch } = {}): Promise<unknown[]> {
  const entries: unknown[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const u = new URL(opts.url ?? CIRCLE_DISCOVERY);
    u.searchParams.set("network", network);
    u.searchParams.set("limit", String(PAGE));
    u.searchParams.set("offset", String(page * PAGE));
    const res = await (opts.fetchImpl ?? fetch)(u, { headers: { accept: "application/json", "user-agent": "cra-agent (+https://cra-agent.tech)" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Circle's catalogue answered ${res.status}`);
    const doc = (await res.json()) as { items?: unknown; pagination?: { total?: unknown } };
    const items = Array.isArray(doc.items) ? doc.items : [];
    entries.push(...items);
    const total = typeof doc.pagination?.total === "number" ? doc.pagination.total : entries.length;
    if (items.length < PAGE || entries.length >= total) break;
  }
  return entries;
}

export interface CircleCatalogue {
  /** The last copy read. Empty until the first read succeeds. */
  items(): readonly SearchItem[];
  status(): { count: number; readAt: number | null; error: string | null };
  /** Read the catalogue again. False when it could not be read; the last copy is kept. */
  refresh(): Promise<boolean>;
  /** Read it now and every hour after, or again in five minutes when a read fails. */
  start(): void;
}

export function circleCatalogue(opts: { network: string; url?: string; fetchImpl?: typeof fetch; log?: Logger; everyMs?: number; retryMs?: number; now?: () => number }): CircleCatalogue {
  const now = opts.now ?? Date.now;
  let items: readonly SearchItem[] = [];
  let readAt: number | null = null;
  let error: string | null = null;
  let running: Promise<boolean> | null = null;

  const read = async (): Promise<boolean> => {
    try {
      const entries = await fetchCircleCatalogue(opts.network, { ...(opts.url ? { url: opts.url } : {}), ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
      const next = circleItems(entries, opts.network, now());
      // A list of hundreds that comes back empty is more likely a hiccup on their side than the end of it.
      if (next.length === 0 && items.length > 0) throw new Error("Circle's catalogue came back empty");
      items = next;
      readAt = now();
      error = null;
      opts.log?.info({ entries: entries.length, kept: next.length }, "circle catalogue read");
      return true;
    } catch (err) {
      error = (err as Error).message.slice(0, 200);
      opts.log?.warn({ error }, "circle catalogue not read, keeping the last copy");
      return false;
    }
  };
  const refresh = (): Promise<boolean> => {
    running ??= read().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    items: () => items,
    status: () => ({ count: items.length, readAt, error }),
    refresh,
    start() {
      const loop = async (): Promise<void> => {
        const ok = await refresh();
        setTimeout(() => void loop(), ok ? (opts.everyMs ?? 3_600_000) : (opts.retryMs ?? 300_000)).unref();
      };
      void loop();
    },
  };
}
