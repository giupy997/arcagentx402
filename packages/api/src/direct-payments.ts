/**
 * Payments on Arc made by signed authorization (EIP-3009), as the collector indexes them: how x402
 * settles a payment one transfer at a time, when Circle Gateway is not batching it. Raw counts from
 * the chain and nothing ranked yet. A wallet paying itself, or one funder running many payers, is not
 * told apart yet, so these numbers are activity, not demand, and the answer says so.
 */
import { formatUsdc6, usdc6 } from "@cra-agent/accounting";
import { hex, type Db } from "./db.js";

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
  /** Who submits them. A relayer is usually a facilitator; ours is named when the API knows its address. */
  relayers: Array<{ address: string; payments: number; share: number; label: string | null }>;
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
  if (!exists.rows[0]?.t) return { ...base, indexed: null, all: empty, last24h: empty, perDay: [], relayers: [], otherTokens: 0 };

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  type T = { n: string; payers: string; payees: string; relayers: string; amount: string | null };
  const tally = `count(*) AS n, count(DISTINCT payer) AS payers, count(DISTINCT payee) AS payees, count(DISTINCT relayer) AS relayers, sum(amount) AS amount`;
  const [state, all, day, perDay, relayers, other] = await Promise.all([
    db.query<{ value: { from?: number; until?: number; cursor?: number } }>("SELECT value FROM collector_state WHERE key = 'direct_payments'"),
    db.query<T>(`SELECT ${tally} FROM direct_payments WHERE token = $1`, [USDC]),
    db.query<T>(`SELECT ${tally} FROM direct_payments WHERE token = $1 AND "timestamp" > $2`, [USDC, now - DAY]),
    db.query<T & { d: string }>(`SELECT "timestamp" / ${DAY} AS d, ${tally} FROM direct_payments WHERE token = $1 AND "timestamp" > $2 GROUP BY 1 ORDER BY 1`, [USDC, now - 14 * DAY]),
    db.query<{ relayer: Buffer; n: string }>("SELECT relayer, count(*) AS n FROM direct_payments WHERE token = $1 GROUP BY relayer ORDER BY 2 DESC LIMIT 10", [USDC]),
    db.query<{ n: string }>("SELECT count(*) AS n FROM direct_payments WHERE token <> $1", [USDC]),
  ]);

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
      return { address, payments: Number(r.n), share: total ? Number((Number(r.n) / total).toFixed(4)) : 0, label: opts.labels?.get(address) ?? null };
    }),
    otherTokens: Number(other.rows[0]?.n ?? 0),
  };
}
