/**
 * Keeps a `think` run in Postgres while it happens, so a page can show it live and replay it later:
 * one row per run, its steps appended as they land, and the call that is out right now.
 * A write that fails is reported and skipped: the run it describes is already paying its way.
 */
import pg from "pg";
import type { Phase, Step, ThinkResult } from "./think.js";

export interface RunStart {
  agent: string;
  network: string;
  task: string;
  model: string;
  brainUrl: string;
  brainName: string | null;
  budgetUsdc: string;
  ceilingUsdc: string;
  policy: unknown;
}

export class ThinkRecorder {
  private constructor(private readonly pool: pg.Pool, readonly id: number) {}

  static async start(databaseUrl: string, run: RunStart): Promise<ThinkRecorder> {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    try {
      const exists = await pool.query<{ t: string | null }>("SELECT to_regclass('public.think_runs')::text AS t");
      if (!exists.rows[0]?.t) throw new Error("this database has no think_runs table: apply the migrations first (the collector applies them when it starts)");
      const r = await pool.query<{ id: string }>(
        `INSERT INTO think_runs (agent, network, task, model, brain_url, brain_name, budget_usdc, ceiling_usdc, policy)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [run.agent, run.network, run.task, run.model, run.brainUrl, run.brainName, run.budgetUsdc, run.ceilingUsdc, JSON.stringify(run.policy ?? null)],
      );
      return new ThinkRecorder(pool, Number(r.rows[0]!.id));
    } catch (err) {
      await pool.end().catch(() => undefined);
      throw err;
    }
  }

  /** How many runs this database holds: a server run takes the next question of its list by this count. */
  static async count(databaseUrl: string): Promise<number> {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const r = await pool.query<{ n: string }>("SELECT count(*) AS n FROM think_runs");
      return Number(r.rows[0]?.n ?? 0);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  /** The questions of the latest runs, so a timer does not ask one again too soon. */
  static async recentTasks(databaseUrl: string, limit: number): Promise<Set<string>> {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const r = await pool.query<{ task: string }>("SELECT task FROM think_runs ORDER BY started_at DESC LIMIT $1", [limit]);
      return new Set(r.rows.map((x) => x.task));
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  phase(p: Phase | null): Promise<void> {
    return this.write("UPDATE think_runs SET phase = $2, phase_at = now() WHERE id = $1", [this.id, p ? JSON.stringify(p) : null]);
  }

  step(s: Step): Promise<void> {
    return this.write("UPDATE think_runs SET steps = steps || $2::jsonb, phase = NULL, phase_at = now() WHERE id = $1", [this.id, JSON.stringify([s])]);
  }

  finish(r: ThinkResult): Promise<void> {
    return this.write("UPDATE think_runs SET status = $2, answer = $3, spent = $4, phase = NULL, finished_at = now() WHERE id = $1", [this.id, r.stoppedBecause, r.answer, JSON.stringify(r.spent)]);
  }

  fail(err: unknown): Promise<void> {
    return this.write("UPDATE think_runs SET status = 'failed', error = $2, phase = NULL, finished_at = now() WHERE id = $1", [this.id, (err as Error)?.message?.slice(0, 300) ?? String(err)]);
  }

  close(): Promise<void> {
    return this.pool.end();
  }

  private async write(sql: string, values: unknown[]): Promise<void> {
    try {
      await this.pool.query(sql, values);
    } catch (err) {
      console.error(JSON.stringify({ event: "think.record_failed", run: this.id, error: (err as Error).message.slice(0, 200) }));
    }
  }
}
