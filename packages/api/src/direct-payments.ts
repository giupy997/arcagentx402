/**
 * Payments on Arc made by signed authorization (EIP-3009), as the collector indexes them: how x402
 * settles a payment one transfer at a time, when Circle Gateway is not batching it. Raw counts from
 * the chain and nothing ranked yet. A wallet paying itself, or one funder running many payers, is not
 * told apart yet, so these numbers are activity, not demand, and the answer says so.
 */
import { formatUsdc6, usdc6 } from "@cra-agent/accounting";
import { hex, type Db } from "./db.js";
import { labelsFor, type AddressLabel } from "./labels.js";

const USDC = Buffer.from("3600000000000000000000000000000000000000", "hex");
const DAY = 86_400;

export interface DirectTally {
  payments: number;
  payers: number;
  payees: number;
  relayers: number;
  usdc: string;
}

export interface DirectPaymentsSummary {
  network: string;
  what: string;
  note: string;
  /**
   * The blocks the index covers: from where it began to the last block collected. While the one-time
   * fill of blocks read before extraction existed is running, `missing` says which ones are not in yet.
   */
  indexed: { fromBlock: number; fromTime: number | null; toBlock: number | null; toTime: number | null; missing: { fromBlock: number; toBlock: number } | null } | null;
  all: DirectTally;
  last24h: DirectTally;
  perDay: Array<{ day: string; payments: number; payers: number; payees: number; usdc: string }>;
  /** Who submits them. A relayer is usually a facilitator, named when something public says which. */
  relayers: Array<{ address: string; payments: number; share: number; label: string | null }>;
  /**
   * Who receives the most, with what is known about each. alsoPays: the address pays others too, which a
   * seller rarely does and a wallet in a ring of wallets paying each other always does.
   */
  payees: Array<{ address: string; payments: number; payers: number; usdc: string; alsoPays: boolean; labels: Array<Pick<AddressLabel, "name" | "role" | "source" | "url">> }>;
  /** Authorizations on other tokens (EURC and others), left out of the USDC figures above. */
  otherTokens: number;
}

const WHAT = "Payments on Arc made by signed authorization (EIP-3009): how x402 settles a payment one transfer at a time, when Circle Gateway is not batching it. Every one is a log on chain, and only USDC is counted here.";
const NOTE = "Raw activity from the chain, not demand: a wallet can pay itself, and one funder can run many payers, and neither is told apart yet. Payments batched through Circle Gateway are not here, because a batch settles as one transfer.";

const usdc = (raw: string | null): string => formatUsdc6(usdc6(BigInt(raw ?? "0")));
const empty: DirectTally = { payments: 0, payers: 0, payees: 0, relayers: 0, usdc: "0" };

export async function directPaymentsSummary(db: Db, opts: { network: string; labels?: ReadonlyMap<string, string>; now?: number }): Promise<DirectPaymentsSummary> {
  const base = { network: opts.network, what: WHAT, note: NOTE };
  const exists = await db.query<{ t: string | null }>("SELECT to_regclass('public.direct_payments')::text AS t");
  if (!exists.rows[0]?.t) return { ...base, indexed: null, all: empty, last24h: empty, perDay: [], relayers: [], payees: [], otherTokens: 0 };

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  type T = { n: string; payers: string; payees: string; relayers: string; amount: string | null };
  const tally = `count(*) AS n, count(DISTINCT payer) AS payers, count(DISTINCT payee) AS payees, count(DISTINCT relayer) AS relayers, sum(amount) AS amount`;
  const [state, all, day, perDay, relayers, other, payees] = await Promise.all([
    db.query<{ value: { from?: number; until?: number; cursor?: number } }>("SELECT value FROM collector_state WHERE key = 'direct_payments'"),
    db.query<T>(`SELECT ${tally} FROM direct_payments WHERE token = $1`, [USDC]),
    db.query<T>(`SELECT ${tally} FROM direct_payments WHERE token = $1 AND "timestamp" > $2`, [USDC, now - DAY]),
    db.query<T & { d: string }>(`SELECT "timestamp" / ${DAY} AS d, ${tally} FROM direct_payments WHERE token = $1 AND "timestamp" > $2 GROUP BY 1 ORDER BY 1`, [USDC, now - 14 * DAY]),
    db.query<{ relayer: Buffer; n: string }>("SELECT relayer, count(*) AS n FROM direct_payments WHERE token = $1 GROUP BY relayer ORDER BY 2 DESC LIMIT 10", [USDC]),
    db.query<{ n: string }>("SELECT count(*) AS n FROM direct_payments WHERE token <> $1", [USDC]),
    db.query<{ payee: Buffer; n: string; payers: string; amount: string | null; also_pays: boolean }>(
      `SELECT p.payee, count(*) AS n, count(DISTINCT p.payer) AS payers, sum(p.amount) AS amount,
              EXISTS (SELECT 1 FROM direct_payments q WHERE q.payer = p.payee AND q.token = $1) AS also_pays
         FROM direct_payments p WHERE p.token = $1 GROUP BY p.payee ORDER BY 2 DESC LIMIT 15`,
      [USDC],
    ),
  ]);
  const known = await labelsFor(db, [...relayers.rows.map((r) => r.relayer), ...payees.rows.map((r) => r.payee)]);
  const nameOf = (address: string, roles: readonly AddressLabel["role"][]): string | null =>
    opts.labels?.get(address) ?? (known.get(address) ?? []).filter((l) => roles.includes(l.role)).sort((a, b) => roles.indexOf(a.role) - roles.indexOf(b.role))[0]?.name ?? null;

  const s = state.rows[0]?.value;
  let indexed: DirectPaymentsSummary["indexed"] = null;
  if (typeof s?.from === "number" && typeof s.until === "number" && typeof s.cursor === "number") {
    const top = await db.query<{ number: string; timestamp: string }>('SELECT number, "timestamp" FROM blocks ORDER BY number DESC LIMIT 1');
    const first = await db.query<{ timestamp: string }>('SELECT "timestamp" FROM blocks WHERE number = $1', [s.from]);
    indexed = {
      fromBlock: s.from,
      fromTime: first.rows[0] ? Number(first.rows[0].timestamp) : null,
      toBlock: top.rows[0] ? Number(top.rows[0].number) : null,
      toTime: top.rows[0] ? Number(top.rows[0].timestamp) : null,
      missing: s.cursor < s.until ? { fromBlock: s.cursor, toBlock: s.until - 1 } : null,
    };
  }
  const toTally = (t: T | undefined): DirectTally => (t ? { payments: Number(t.n), payers: Number(t.payers), payees: Number(t.payees), relayers: Number(t.relayers), usdc: usdc(t.amount) } : empty);
  const total = Number(all.rows[0]?.n ?? 0);
  return {
    ...base,
    indexed,
    all: toTally(all.rows[0]),
    last24h: toTally(day.rows[0]),
    perDay: perDay.rows.map((r) => ({ day: new Date(Number(r.d) * DAY * 1000).toISOString().slice(0, 10), payments: Number(r.n), payers: Number(r.payers), payees: Number(r.payees), usdc: usdc(r.amount) })),
    relayers: relayers.rows.map((r) => {
      const address = hex(r.relayer)!;
      return { address, payments: Number(r.n), share: total ? Number((Number(r.n) / total).toFixed(4)) : 0, label: nameOf(address, ["facilitator", "agent"]) };
    }),
    payees: payees.rows.map((r) => {
      const address = hex(r.payee)!;
      return { address, payments: Number(r.n), payers: Number(r.payers), usdc: usdc(r.amount), alsoPays: r.also_pays, labels: (known.get(address) ?? []).map(({ name, role, source, url }) => ({ name, role, source, url })) };
    }),
    otherTokens: Number(other.rows[0]?.n ?? 0),
  };
}

export interface DirectService {
  /** The payee address, and every label public sources give it. */
  address: string;
  labels: Array<Pick<AddressLabel, "name" | "role" | "source" | "url" | "detail">>;
  payments: number;
  payers: number;
  usdc: string;
  last24h: { payments: number; payers: number };
  lastPaidAt: number;
}

/**
 * The known sellers that direct payments reach: payees some public source names as a seller, with how
 * many payments and how many distinct payers each had. A seller paid only through Circle Gateway does
 * not show here, however busy it is: its payments settle in batches.
 */
export async function directServices(db: Db, opts: { network: string; now?: number }): Promise<{ network: string; note: string; services: DirectService[] }> {
  const note = "Sellers named by a public source (Circle's catalogue, the CRA market, the ERC-8004 registry, our own), with the direct payments each received. Payers are distinct addresses, not people: one funder can run many. Sellers paid through Circle Gateway settle in batches and are not counted here.";
  const tables = await db.query<{ p: string | null; l: string | null }>("SELECT to_regclass('public.direct_payments')::text AS p, to_regclass('public.address_labels')::text AS l");
  if (!tables.rows[0]?.p || !tables.rows[0]?.l) return { network: opts.network, note, services: [] };
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const rows = await db.query<{ payee: Buffer; n: string; payers: string; amount: string | null; n24: string; payers24: string; last_at: string }>(
    `SELECT p.payee, count(*) AS n, count(DISTINCT p.payer) AS payers, sum(p.amount) AS amount,
            count(*) FILTER (WHERE p."timestamp" > $2) AS n24, count(DISTINCT p.payer) FILTER (WHERE p."timestamp" > $2) AS payers24,
            max(p."timestamp") AS last_at
       FROM direct_payments p
      WHERE p.token = $1 AND p.payee IN (SELECT address FROM address_labels WHERE role = 'seller')
      GROUP BY p.payee ORDER BY 3 DESC, 2 DESC LIMIT 100`,
    [USDC, now - DAY],
  );
  const known = await labelsFor(db, rows.rows.map((r) => r.payee));
  return {
    network: opts.network,
    note,
    services: rows.rows.map((r) => {
      const address = hex(r.payee)!;
      return {
        address,
        labels: (known.get(address) ?? []).filter((l) => l.role === "seller").map(({ name, role, source, url, detail }) => ({ name, role, source, url, detail })),
        payments: Number(r.n),
        payers: Number(r.payers),
        usdc: usdc(r.amount),
        last24h: { payments: Number(r.n24), payers: Number(r.payers24) },
        lastPaidAt: Number(r.last_at),
      };
    }),
  };
}
