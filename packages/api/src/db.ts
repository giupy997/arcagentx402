import pg from "pg";

const { Pool, types } = pg;
types.setTypeParser(20, (v) => v);
types.setTypeParser(1700, (v) => v);

export function createPool(url: string): pg.Pool {
  // JIT compiles every aggregate afresh and costs more than it saves on queries this small.
  return new Pool({ connectionString: url, max: 8, idleTimeoutMillis: 30_000, statement_timeout: 20_000, options: "-c jit=off" });
}
export type Db = pg.Pool;
export const hex = (b: Buffer | null): string | null => (b ? `0x${b.toString("hex")}` : null);
