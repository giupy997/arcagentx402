import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { sumUsdc6, toSqlNumeric, usdc6, type Usdc6 } from "@cra-agent/accounting";

export type PaymentStatus = "quoted" | "rejected" | "signed" | "settled" | "failed";
export type RailKind = "nanopayment" | "escrow";

export interface PaymentRecord {
  readonly id: number;
  readonly at: Date;
  readonly agentId: string;
  readonly rail: RailKind;
  readonly url: string;
  readonly host: string;
  readonly method: string;
  readonly network: string;
  readonly scheme: string;
  readonly asset: string;
  readonly payTo: string;
  readonly amount: Usdc6;
  status: PaymentStatus;
  reason: string | null;
  httpStatus: number | null;
  latencyMs: number | null;
  txHash: string | null;
  payer: string | null;
  settledAt: Date | null;
  meta: Record<string, unknown> | null;
  /** The on-chain transaction that actually moved the money, once the batch settles. */
  settlementTx: string | null;
  settledOnchainAt: Date | null;
}

export type NewPayment = Omit<PaymentRecord, "id" | "at" | "reason" | "httpStatus" | "latencyMs" | "txHash" | "payer" | "settledAt" | "meta" | "settlementTx" | "settledOnchainAt"> &
  Partial<Pick<PaymentRecord, "reason" | "httpStatus" | "latencyMs" | "txHash" | "payer" | "meta">>;
export type PaymentPatch = Partial<Pick<PaymentRecord, "status" | "reason" | "httpStatus" | "latencyMs" | "txHash" | "payer" | "settledAt" | "meta" | "settlementTx" | "settledOnchainAt">>;

export interface Exposure {
  readonly payTo: string;
  readonly open: Usdc6;
  readonly count: number;
}

/** Ledger contract. Amounts that count as "spent": signed + settled (a signed authorization is a commitment). */
export interface Ledger {
  record(p: NewPayment): Promise<PaymentRecord>;
  update(id: number, patch: PaymentPatch): Promise<void>;
  spentSince(agentId: string, since: Date, payTo?: string): Promise<Usdc6>;
  countSince(agentId: string, since: Date): Promise<number>;
  recent(agentId: string, limit: number): Promise<PaymentRecord[]>;
  /** Settled payments whose on-chain settlement has not been matched yet. */
  awaitingProof(agentId: string, limit: number): Promise<PaymentRecord[]>;
  /** Open exposure per counterparty: signed, not yet settled or failed. Phase 2 reads this in real time. */
  exposure(): Promise<Exposure[]>;
  close(): Promise<void>;
}

const SPENT: ReadonlySet<PaymentStatus> = new Set(["signed", "settled"]);

export class MemoryLedger implements Ledger {
  private rows: PaymentRecord[] = [];
  private nextId = 1;
  async record(p: NewPayment): Promise<PaymentRecord> {
    const rec: PaymentRecord = {
      id: this.nextId++, at: new Date(), reason: null, httpStatus: null, latencyMs: null, txHash: null, payer: null, settledAt: null, meta: null, settlementTx: null, settledOnchainAt: null, ...p,
      payTo: p.payTo.toLowerCase(),
    };
    this.rows.push(rec);
    return rec;
  }
  async update(id: number, patch: PaymentPatch): Promise<void> {
    const r = this.rows.find((x) => x.id === id);
    if (r) Object.assign(r, patch);
  }
  async spentSince(agentId: string, since: Date, payTo?: string): Promise<Usdc6> {
    const pt = payTo?.toLowerCase();
    return sumUsdc6(this.rows.filter((r) => r.agentId === agentId && r.at >= since && SPENT.has(r.status) && (pt === undefined || r.payTo === pt)).map((r) => r.amount));
  }
  async countSince(agentId: string, since: Date): Promise<number> {
    return this.rows.filter((r) => r.agentId === agentId && r.at >= since && SPENT.has(r.status)).length;
  }
  async recent(agentId: string, limit: number): Promise<PaymentRecord[]> {
    return this.rows.filter((r) => r.agentId === agentId).slice(-limit).reverse();
  }
  async awaitingProof(agentId: string, limit: number): Promise<PaymentRecord[]> {
    return this.rows.filter((r) => r.agentId === agentId && r.status === "settled" && r.settlementTx === null).slice(-limit).reverse();
  }
  async exposure(): Promise<Exposure[]> {
    const m = new Map<string, { open: bigint; count: number }>();
    for (const r of this.rows) {
      if (r.status !== "signed") continue;
      const e = m.get(r.payTo) ?? { open: 0n, count: 0 };
      e.open += r.amount;
      e.count++;
      m.set(r.payTo, e);
    }
    return [...m.entries()].map(([payTo, e]) => ({ payTo, open: usdc6(e.open), count: e.count }));
  }
  async close(): Promise<void> {}
}

const { Pool, types } = pg;
types.setTypeParser(20, (v) => v);
types.setTypeParser(1700, (v) => v);

interface Row {
  id: string; at: Date; agent_id: string; rail: RailKind; url: string; host: string; method: string; network: string; scheme: string; asset: string; pay_to: string;
  amount_usdc6: string; status: PaymentStatus; reason: string | null; http_status: number | null; latency_ms: number | null; tx_hash: string | null; payer: string | null; settled_at: Date | null; meta: Record<string, unknown> | null;
  settlement_tx: string | null; settled_onchain_at: Date | null;
}
const fromRow = (r: Row): PaymentRecord => ({
  id: Number(r.id), at: r.at, agentId: r.agent_id, rail: r.rail, url: r.url, host: r.host, method: r.method, network: r.network, scheme: r.scheme, asset: r.asset, payTo: r.pay_to,
  amount: usdc6(BigInt(r.amount_usdc6)), status: r.status, reason: r.reason, httpStatus: r.http_status, latencyMs: r.latency_ms, txHash: r.tx_hash, payer: r.payer, settledAt: r.settled_at, meta: r.meta,
  settlementTx: r.settlement_tx ?? null, settledOnchainAt: r.settled_onchain_at ?? null,
});

export class PgLedger implements Ledger {
  private readonly pool: pg.Pool;
  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 4 });
  }
  /** Idempotent. */
  async migrate(): Promise<void> {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");
    for (const f of ["001_ledger.sql", "002_settlement.sql"]) await this.pool.query(readFileSync(join(dir, f), "utf8"));
  }
  async record(p: NewPayment): Promise<PaymentRecord> {
    const r = await this.pool.query<Row>(
      `INSERT INTO rail_payments (agent_id, rail, url, host, method, network, scheme, asset, pay_to, amount_usdc6, status, reason, http_status, latency_ms, tx_hash, payer, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [p.agentId, p.rail, p.url, p.host, p.method, p.network, p.scheme, p.asset, p.payTo.toLowerCase(), toSqlNumeric(p.amount), p.status, p.reason ?? null, p.httpStatus ?? null, p.latencyMs ?? null, p.txHash ?? null, p.payer ?? null, p.meta ? JSON.stringify(p.meta) : null],
    );
    return fromRow(r.rows[0]!);
  }
  async update(id: number, patch: PaymentPatch): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.reason !== undefined) add("reason", patch.reason);
    if (patch.httpStatus !== undefined) add("http_status", patch.httpStatus);
    if (patch.latencyMs !== undefined) add("latency_ms", patch.latencyMs);
    if (patch.txHash !== undefined) add("tx_hash", patch.txHash);
    if (patch.payer !== undefined) add("payer", patch.payer);
    if (patch.settledAt !== undefined) add("settled_at", patch.settledAt);
    if (patch.meta !== undefined) add("meta", patch.meta ? JSON.stringify(patch.meta) : null);
    if (patch.settlementTx !== undefined) add("settlement_tx", patch.settlementTx);
    if (patch.settledOnchainAt !== undefined) add("settled_onchain_at", patch.settledOnchainAt);
    if (sets.length === 0) return;
    vals.push(id);
    await this.pool.query(`UPDATE rail_payments SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
  }
  async spentSince(agentId: string, since: Date, payTo?: string): Promise<Usdc6> {
    const r = await this.pool.query<{ s: string | null }>(
      `SELECT sum(amount_usdc6) AS s FROM rail_payments WHERE agent_id = $1 AND at >= $2 AND status IN ('signed','settled') AND ($3::text IS NULL OR pay_to = $3)`,
      [agentId, since, payTo?.toLowerCase() ?? null],
    );
    return usdc6(BigInt(r.rows[0]?.s ?? "0"));
  }
  async countSince(agentId: string, since: Date): Promise<number> {
    const r = await this.pool.query<{ n: string }>("SELECT count(*) AS n FROM rail_payments WHERE agent_id = $1 AND at >= $2 AND status IN ('signed','settled')", [agentId, since]);
    return Number(r.rows[0]?.n ?? 0);
  }
  async recent(agentId: string, limit: number): Promise<PaymentRecord[]> {
    const r = await this.pool.query<Row>("SELECT * FROM rail_payments WHERE agent_id = $1 ORDER BY id DESC LIMIT $2", [agentId, limit]);
    return r.rows.map(fromRow);
  }
  async awaitingProof(agentId: string, limit: number): Promise<PaymentRecord[]> {
    const r = await this.pool.query<Row>(
      "SELECT * FROM rail_payments WHERE agent_id = $1 AND status = 'settled' AND settlement_tx IS NULL ORDER BY id DESC LIMIT $2",
      [agentId, limit],
    );
    return r.rows.map(fromRow);
  }
  async exposure(): Promise<Exposure[]> {
    const r = await this.pool.query<{ pay_to: string; open: string; n: string }>("SELECT pay_to, sum(amount_usdc6) AS open, count(*) AS n FROM rail_payments WHERE status = 'signed' GROUP BY pay_to ORDER BY 2 DESC");
    return r.rows.map((x) => ({ payTo: x.pay_to, open: usdc6(BigInt(x.open)), count: Number(x.n) }));
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}
