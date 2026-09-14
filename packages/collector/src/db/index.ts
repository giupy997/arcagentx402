import pg from "pg";
import type { Logger } from "../log.js";

const { Pool, types } = pg;

// Keep bigint/numeric columns as strings (no float precision loss); callers convert with BigInt().
types.setTypeParser(20, (v) => v); // int8
types.setTypeParser(1700, (v) => v); // numeric

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createDb(databaseUrl: string, log: Logger): Db {
  const pool = new Pool({ connectionString: databaseUrl, max: 12, idleTimeoutMillis: 30_000, statement_timeout: 120_000 });
  pool.on("error", (err) => log.error({ err }, "pg pool error"));
  return pool;
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** '0xabcd' -> Buffer. Accepts empty ('0x'). Throws on malformed input. */
export function hexToBytes(hex: string): Buffer {
  if (typeof hex !== "string" || !hex.startsWith("0x") || hex.length % 2 !== 0 || !/^0x[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`hexToBytes: malformed hex ${String(hex).slice(0, 40)}`);
  }
  return Buffer.from(hex.slice(2), "hex");
}

export function bytesToHex(b: Buffer | null): string | null {
  return b ? `0x${b.toString("hex")}` : null;
}

export async function getState<T = unknown>(db: Db, key: string): Promise<T | null> {
  const r = await db.query<{ value: T }>("SELECT value FROM collector_state WHERE key = $1", [key]);
  return r.rows[0]?.value ?? null;
}

export async function setState(db: Db | Tx, key: string, value: unknown): Promise<void> {
  await db.query(
    "INSERT INTO collector_state (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    [key, JSON.stringify(value)],
  );
}
