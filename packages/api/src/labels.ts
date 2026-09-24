/**
 * Who is behind an address that pays or gets paid on Arc, when something public says so.
 *
 * Every label comes from a source that states it. Circle's catalogue lists the payee of each endpoint.
 * A CRA market listing is a 402 we read ourselves. The ERC-8004 registry names each agent's owner and
 * wallet, and an agent's card can point at its x402 catalogue. A facilitator's /supported names the
 * addresses it settles from. Nothing is guessed from behaviour. A source is replaced whole when it is
 * read again, and only when the read worked, so a label lasts as long as its source still says it.
 */
import { ERC8004_IDENTITY_REGISTRY, scanRegistry, viemRegistryReader } from "@cra-agent/identity";
import type { Logger } from "pino";
import { createPublicClient, http, type PublicClient } from "viem";
import { arc } from "viem/chains";
import type { CircleCatalogue } from "./circle.js";
import type { Db } from "./db.js";
import { probe } from "./market.js";
import { safeFetch } from "./safe-fetch.js";
import type { SearchItem } from "./search.js";
import { clean } from "./text.js";

export type LabelSource = "ours" | "market" | "circle" | "erc8004" | "facilitator";
export type LabelRole = "seller" | "facilitator" | "agent";

export interface AddressLabel {
  /** Lowercase 0x address. */
  address: string;
  role: LabelRole;
  name: string;
  url: string | null;
  source: LabelSource;
  detail: string | null;
}

const ARC = "eip155:5042";
const isAddress = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One label per address, role and name: a source that says the same thing twice says it once. */
function unique(labels: readonly AddressLabel[]): AddressLabel[] {
  const seen = new Map<string, AddressLabel>();
  for (const l of labels) seen.set(`${l.address}|${l.role}|${l.name}`, seen.get(`${l.address}|${l.role}|${l.name}`) ?? l);
  return [...seen.values()];
}

/** Circle lists the payee of every endpoint it carries: that address is the seller it names. */
export function labelsFromCircle(items: readonly SearchItem[]): AddressLabel[] {
  return unique(items.filter((i) => isAddress(i.payTo)).map((i) => ({ address: i.payTo.toLowerCase(), role: "seller", name: i.name, url: `https://${i.host}`, source: "circle", detail: i.description ?? "listed in Circle's x402 catalogue" })));
}

/** A market listing is a 402 we read: its payee is the seller of that endpoint. */
export function labelsFromMarket(rows: ReadonlyArray<{ url: string; host: string; name: string | null; description: string | null; pay_to: string }>): AddressLabel[] {
  return unique(rows.filter((r) => isAddress(r.pay_to)).map((r) => ({ address: r.pay_to.toLowerCase(), role: "seller", name: r.name ?? r.host, url: r.url, source: "market", detail: r.description })));
}

/** The addresses a facilitator says it settles from, from its own /supported. */
export function signersFromSupported(doc: unknown): string[] {
  if (!isObject(doc) || !isObject(doc.signers)) return [];
  const out = new Set<string>();
  for (const [network, list] of Object.entries(doc.signers)) {
    if (network !== "eip155:*" && network !== ARC) continue;
    for (const a of Array.isArray(list) ? list : []) if (isAddress(a)) out.add(a.toLowerCase());
  }
  return [...out];
}

/** Public x402 facilitators. Most do not settle on Arc, but an EVM signer is the same address everywhere. */
export const FACILITATORS: ReadonlyArray<{ name: string; url: string }> = [
  { name: "PayAI", url: "https://facilitator.payai.network" },
  { name: "x402.org", url: "https://x402.org/facilitator" },
  { name: "Daydreams", url: "https://facilitator.daydreams.systems" },
  { name: "OpenX402", url: "https://facilitator.openx402.ai" },
  { name: "Heurist", url: "https://facilitator.heurist.xyz" },
  { name: "Mogami", url: "https://v2.facilitator.mogami.tech" },
  { name: "x402.rs", url: "https://facilitator.x402.rs" },
];

export async function labelsFromFacilitators(fetchJson: (url: string) => Promise<unknown>, list = FACILITATORS): Promise<AddressLabel[]> {
  const found = await Promise.all(
    list.map(async (f) => {
      const doc = await fetchJson(`${f.url}/supported`).catch(() => null);
      return signersFromSupported(doc).map((address): AddressLabel => ({ address, role: "facilitator", name: f.name, url: f.url, source: "facilitator", detail: "named in its /supported" }));
    }),
  );
  return unique(found.flat());
}

export interface RegistryEntry {
  id: number;
  owner: string;
  wallet: string | null;
  /** The agent's registration file, when it could be read. */
  card: unknown;
  cardUrl: string | null;
}

/** An x402 catalogue in the Circle / APEX discovery shape: items that each list their accepts. */
function payeesInCatalogue(doc: unknown): string[] {
  const items = isObject(doc) && Array.isArray(doc.items) ? doc.items : [];
  const out = new Set<string>();
  for (const item of items.slice(0, 500)) {
    const accepts = isObject(item) && Array.isArray(item.accepts) ? item.accepts : [];
    for (const a of accepts) if (isObject(a) && a.network === ARC && isAddress(a.payTo)) out.add(a.payTo.toLowerCase());
  }
  return [...out];
}

/** The first paid URL a manifest lists, in the shapes sellers use: resources, routes or items with a url. */
function firstListedUrl(doc: unknown): string | null {
  if (!isObject(doc)) return null;
  for (const key of ["resources", "routes", "items"]) {
    const list = doc[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list.slice(0, 20)) {
      const url = isObject(entry) ? (entry.url ?? entry.resource) : null;
      if (typeof url === "string" && /^https:\/\//.test(url)) return url;
    }
  }
  return null;
}

/** The x402 endpoints an agent card declares: services named x402, or pointing at a manifest or catalogue. */
function x402Endpoints(card: unknown): string[] {
  const services = isObject(card) && Array.isArray(card.services) ? card.services : isObject(card) && Array.isArray(card.endpoints) ? card.endpoints : [];
  const out: string[] = [];
  for (const s of services) {
    if (!isObject(s) || typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint)) continue;
    const named = typeof s.name === "string" && s.name.toLowerCase().includes("x402");
    if (named || /\/\.well-known\/x402|\/discovery\/resources/.test(s.endpoint)) out.push(s.endpoint);
  }
  return [...new Set(out)].slice(0, 3);
}

/**
 * Registry labels: every agent's owner and declared wallet, and the payees of the x402 catalogues its
 * card points at. A catalogue in the discovery shape names its payees; any other manifest gives a paid
 * URL, whose 402 names the payee.
 */
export async function labelsFromRegistry(entries: readonly RegistryEntry[], deps: { fetchJson: (url: string) => Promise<unknown>; payToOf: (url: string) => Promise<string | null>; maxFetches?: number }): Promise<AddressLabel[]> {
  const labels: AddressLabel[] = [];
  let budget = deps.maxFetches ?? 60;
  for (const e of entries) {
    const name = (isObject(e.card) ? clean(e.card.name, 80) : null) ?? `Agent #${e.id}`;
    const detail = `ERC-8004 agent #${e.id}`;
    for (const address of new Set([e.owner, e.wallet].filter(isAddress).map((a) => a.toLowerCase()))) labels.push({ address, role: "agent", name, url: e.cardUrl, source: "erc8004", detail });
    for (const endpoint of x402Endpoints(e.card)) {
      if (budget-- <= 0) break;
      const doc = await deps.fetchJson(endpoint).catch(() => null);
      let payees = payeesInCatalogue(doc);
      if (payees.length === 0) {
        const paid = firstListedUrl(doc) ?? (/\/\.well-known\/x402$/.test(endpoint) ? null : endpoint);
        if (paid && budget-- > 0) {
          const payTo = await deps.payToOf(paid).catch(() => null);
          if (isAddress(payTo)) payees = [payTo.toLowerCase()];
        }
      }
      for (const address of payees) labels.push({ address, role: "seller", name, url: endpoint, source: "erc8004", detail: `${detail}, from the x402 catalogue its card points at` });
    }
  }
  return unique(labels);
}

/** A stranger's JSON, fetched through the guarded fetch: a card or manifest can point anywhere. */
export async function fetchStrangerJson(url: string): Promise<unknown> {
  const target = url.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${url.slice(7)}` : url;
  if (target.startsWith("data:")) {
    const [meta, data] = target.split(",", 2);
    return JSON.parse(meta!.includes("base64") ? Buffer.from(data ?? "", "base64").toString("utf8") : decodeURIComponent(data ?? ""));
  }
  const res = await safeFetch(target, { maxBytes: 300_000, timeoutMs: 8000 });
  if (res.status !== 200) throw new Error(`${url} answered ${res.status}`);
  return JSON.parse(res.body.toString("utf8"));
}

/** Every agent in the registry, with its card when it can be read. Eight at a time: many cards sit on slow gateways. */
async function readRegistry(client: PublicClient, log: Logger): Promise<RegistryEntry[]> {
  const reader = viemRegistryReader(client, ERC8004_IDENTITY_REGISTRY.arc!);
  const { agents } = await scanRegistry(reader, 5000, 250);
  const entries: RegistryEntry[] = new Array(agents.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < agents.length; i = next++) {
      const a = agents[i]!;
      const uri = await reader.tokenURI(a.agentId).catch(() => null);
      const card = uri ? await fetchStrangerJson(uri).catch(() => null) : null;
      entries[i] = { id: Number(a.agentId), owner: a.owner, wallet: a.wallet, card, cardUrl: uri && /^https:\/\//.test(uri) ? uri.slice(0, 300) : null };
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  log.info({ agents: entries.length, cards: entries.filter((e) => e.card).length }, "erc-8004 registry read for labels");
  return entries;
}

/** Replace one source's labels, in one transaction, so a reader never sees the source half written. */
export async function replaceLabels(db: Db, source: LabelSource, labels: readonly AddressLabel[]): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM address_labels WHERE source = $1", [source]);
    if (labels.length > 0) {
      await client.query(
        `INSERT INTO address_labels (address, role, name, url, source, detail)
         SELECT * FROM unnest($1::bytea[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) ON CONFLICT DO NOTHING`,
        [labels.map((l) => Buffer.from(l.address.slice(2), "hex")), labels.map((l) => l.role), labels.map((l) => l.name), labels.map((l) => l.url), labels.map((l) => l.source), labels.map((l) => l.detail)],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface LabelerOptions {
  db: Db;
  log: Logger;
  circle: CircleCatalogue | null;
  /** Our payee address and the one our facilitator settles from, when known. */
  ours: () => Promise<{ seller: string | null; facilitator: string | null }>;
  rpcUrls: readonly string[];
}

/**
 * Keeps address_labels current: the cheap sources every hour, the registry and the facilitators every
 * six. A source whose read fails keeps its last labels. Runs only once the collector created the table.
 */
export function startLabeler(opts: LabelerOptions): void {
  const { db, log } = opts;
  let runs = 0;
  const each = async (source: LabelSource, read: () => Promise<AddressLabel[]>): Promise<void> => {
    try {
      const labels = await read();
      await replaceLabels(db, source, labels);
      log.info({ source, labels: labels.length }, "address labels refreshed");
    } catch (err) {
      log.warn({ source, err: (err as Error).message }, "address labels not refreshed, keeping the last ones");
    }
  };
  const run = async (): Promise<void> => {
    const exists = await db.query<{ t: string | null }>("SELECT to_regclass('public.address_labels')::text AS t").catch(() => null);
    if (!exists?.rows[0]?.t) return;
    const slow = runs++ % 6 === 0;
    await each("ours", async () => {
      const o = await opts.ours();
      const sellers = await db.query<{ pay_to: string }>("SELECT pay_to FROM facilitator_sellers").catch(() => ({ rows: [] as Array<{ pay_to: string }> }));
      return unique([
        ...(isAddress(o.seller) ? [{ address: o.seller.toLowerCase(), role: "seller" as const, name: "CRA AGENT", url: "https://api.cra-agent.tech/.well-known/x402", source: "ours" as const, detail: "CRA AGENT's own paid routes" }] : []),
        ...(isAddress(o.facilitator) ? [{ address: o.facilitator.toLowerCase(), role: "facilitator" as const, name: "CRA AGENT facilitator", url: "https://api.cra-agent.tech/facilitator/supported", source: "ours" as const, detail: null }] : []),
        ...sellers.rows.filter((r) => isAddress(r.pay_to)).map((r) => ({ address: r.pay_to.toLowerCase(), role: "seller" as const, name: "Seller registered with CRA AGENT's facilitator", url: "https://cra-agent.tech/register", source: "ours" as const, detail: null })),
      ]);
    });
    // Circle's catalogue lives in memory; before its first read there is nothing to replace the old labels with.
    const items = opts.circle?.items() ?? [];
    if (items.length > 0) await each("circle", async () => labelsFromCircle(items));
    await each("market", async () => {
      const rows = await db.query<{ url: string; host: string; name: string | null; description: string | null; pay_to: string }>("SELECT url, host, name, description, pay_to FROM market_listings WHERE NOT hidden AND fails < 48");
      return labelsFromMarket(rows.rows);
    });
    if (!slow) return;
    await each("facilitator", () => labelsFromFacilitators(fetchStrangerJson));
    const rpc = opts.rpcUrls[0];
    if (rpc) {
      await each("erc8004", async () => {
        const client = createPublicClient({ chain: arc, transport: http(rpc, { timeout: 20_000 }) }) as PublicClient;
        const entries = await readRegistry(client, log);
        return labelsFromRegistry(entries, { fetchJson: fetchStrangerJson, payToOf: async (url) => (await probe(url, ARC)).payTo });
      });
    }
  };
  const loop = async (): Promise<void> => {
    await run().catch((err) => log.warn({ err: (err as Error).message }, "labeler run failed"));
    setTimeout(() => void loop(), 3_600_000).unref();
  };
  // Give Circle's catalogue a moment to load, so the first run has it.
  setTimeout(() => void loop(), 30_000).unref();
}

/** Labels for a set of addresses, from the table, grouped by address. */
export async function labelsFor(db: Db, addresses: readonly Buffer[]): Promise<Map<string, AddressLabel[]>> {
  const out = new Map<string, AddressLabel[]>();
  if (addresses.length === 0) return out;
  const exists = await db.query<{ t: string | null }>("SELECT to_regclass('public.address_labels')::text AS t");
  if (!exists.rows[0]?.t) return out;
  const rows = await db.query<{ address: Buffer; role: LabelRole; name: string; url: string | null; source: LabelSource; detail: string | null }>(
    "SELECT address, role, name, url, source, detail FROM address_labels WHERE address = ANY($1::bytea[]) ORDER BY source, name",
    [addresses],
  );
  for (const r of rows.rows) {
    const address = `0x${r.address.toString("hex")}`;
    const list = out.get(address) ?? [];
    list.push({ address, role: r.role, name: r.name, url: r.url, source: r.source, detail: r.detail });
    out.set(address, list);
  }
  return out;
}
