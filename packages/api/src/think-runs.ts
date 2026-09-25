/**
 * Runs of the agent that pays for its own thinking, as `cra-agent think --record` keeps them: the one
 * happening now, step by step, and the ones before it. cra-agent.tech/think reads these to show a run
 * live and replay it. Every cost here was a payment in USDC on Arc from the run's own wallet.
 */
import { formatUsdc6, parseUsdc6, usdc6 } from "@cra-agent/accounting";
import type { Hono } from "hono";
import type { Db } from "./db.js";

type Status = "running" | "answered" | "budget" | "steps" | "brain" | "failed" | "interrupted";

export interface ThinkStepView {
  /** fetch: a free public API, nothing paid. */
  kind: "think" | "search" | "buy" | "fetch" | "refused";
  detail: string;
  costUsdc: string;
  atMs: number | null;
  ms: number | null;
  tx: string | null;
  url?: string;
  method?: string;
  seller?: string;
  status?: number;
  query?: string;
  results?: Array<{ seller: string; what: string; priceUsd: string }>;
}

export interface Spent { thinkingUsdc: string; toolsUsdc: string; totalUsdc: string; thoughts: number; purchases: number }

export interface ThinkRunView {
  id: number;
  agent: string;
  network: string;
  task: string;
  model: string;
  brain: { url: string; name: string | null };
  budgetUsdc: string;
  ceilingUsdc: string;
  policy: unknown;
  status: Status;
  /** The call that is out right now, while the run is going. */
  phase: unknown;
  phaseSince: number | null;
  steps: ThinkStepView[];
  answer: string | null;
  /** Whether the agent read anything to answer with, bought or free; an answer from the model alone was not checked. */
  checked: boolean;
  spent: Spent;
  /** Who was paid in this run, and how much: the brain's seller and each tool's. */
  paid: Array<{ seller: string; role: "brain" | "tool"; payments: number; usdc: string }>;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** Server time when this was read, so a page can run a clock without trusting the viewer's. */
  now: number;
}

export interface ThinkRunRow {
  id: string;
  agent: string;
  network: string;
  task: string;
  model: string;
  brain_url: string;
  brain_name: string | null;
  budget_usdc: string;
  ceiling_usdc: string;
  policy: unknown;
  status: string;
  phase: unknown;
  phase_at: Date | null;
  steps: unknown;
  answer: string | null;
  spent: Spent | null;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}

/** A run left "running" with nothing new for this long died with its process: it will not finish. */
export const STALE_MS = 10 * 60_000;
const secs = (d: Date | null): number | null => (d ? Math.floor(d.getTime() / 1000) : null);
const money = (v: unknown): string => {
  try {
    return formatUsdc6(parseUsdc6(typeof v === "string" && /^\d{1,9}(\.\d{1,6})?$/.test(v) ? v : "0"));
  } catch {
    return "0";
  }
};
const text = (v: unknown, max: number): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);

function stepOf(raw: unknown): ThinkStepView | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const kind = s.kind;
  if (kind !== "think" && kind !== "search" && kind !== "buy" && kind !== "fetch" && kind !== "refused") return null;
  const view: ThinkStepView = {
    kind,
    detail: text(s.detail, 600) ?? "",
    costUsdc: money(s.costUsdc),
    atMs: typeof s.atMs === "number" ? s.atMs : null,
    ms: typeof s.ms === "number" ? s.ms : null,
    tx: text(s.tx, 100) ?? null,
  };
  const url = text(s.url, 400);
  if (url) view.url = url;
  const method = text(s.method, 8);
  if (method) view.method = method;
  const seller = text(s.seller, 80);
  if (seller) view.seller = seller;
  if (typeof s.status === "number") view.status = s.status;
  const query = text(s.query, 200);
  if (query !== undefined) view.query = query;
  if (Array.isArray(s.results)) {
    view.results = s.results.slice(0, 5).flatMap((r) => {
      const o = r as Record<string, unknown>;
      return typeof o?.seller === "string" ? [{ seller: o.seller.slice(0, 80), what: text(o.what, 120) ?? "", priceUsd: money(o.priceUsd) }] : [];
    });
  }
  return view;
}

/** What a run spent, from its steps: a run still going has no totals yet. */
export function spentFrom(steps: readonly ThinkStepView[]): Spent {
  let thinking = usdc6(0n);
  let tools = usdc6(0n);
  let thoughts = 0;
  let purchases = 0;
  for (const s of steps) {
    if (s.kind === "think") {
      thinking = usdc6(thinking + parseUsdc6(s.costUsdc));
      thoughts++;
    } else if (s.kind === "buy" && parseUsdc6(s.costUsdc) > 0n) {
      tools = usdc6(tools + parseUsdc6(s.costUsdc));
      purchases++;
    }
  }
  return { thinkingUsdc: formatUsdc6(thinking), toolsUsdc: formatUsdc6(tools), totalUsdc: formatUsdc6(usdc6(thinking + tools)), thoughts, purchases };
}

export function runView(row: ThinkRunRow, now = Date.now()): ThinkRunView {
  const steps = (Array.isArray(row.steps) ? row.steps : []).map(stepOf).filter((s): s is ThinkStepView => s !== null);
  const lastMove = Math.max(row.started_at.getTime(), row.phase_at?.getTime() ?? 0, row.started_at.getTime() + (steps.at(-1)?.atMs ?? 0));
  let status = (["running", "answered", "budget", "steps", "brain", "failed"].includes(row.status) ? row.status : "failed") as Status;
  if (status === "running" && now - lastMove > STALE_MS) status = "interrupted";
  const brainName = row.brain_name ?? "the brain";
  const paid = new Map<string, { seller: string; role: "brain" | "tool"; payments: number; micro: bigint }>();
  for (const s of steps) {
    if (s.kind !== "think" && s.kind !== "buy") continue;
    const cost = parseUsdc6(s.costUsdc);
    if (cost === 0n) continue;
    const role = s.kind === "think" ? "brain" : "tool";
    const seller = s.kind === "think" ? brainName : s.seller ?? "a seller";
    const key = `${role}:${seller}`;
    const p = paid.get(key) ?? { seller, role, payments: 0, micro: 0n };
    p.payments++;
    p.micro += cost;
    paid.set(key, p);
  }
  const spent = status === "running" || status === "interrupted" || !row.spent ? spentFrom(steps) : row.spent;
  return {
    id: Number(row.id),
    agent: row.agent,
    network: row.network,
    task: row.task,
    model: row.model,
    brain: { url: row.brain_url, name: row.brain_name },
    budgetUsdc: money(row.budget_usdc),
    ceilingUsdc: money(row.ceiling_usdc),
    policy: row.policy,
    status,
    phase: status === "running" ? row.phase ?? null : null,
    phaseSince: status === "running" ? secs(row.phase_at) : null,
    steps,
    answer: row.answer,
    checked: steps.some((s) => (s.kind === "buy" || s.kind === "fetch") && (s.status ?? 0) >= 200 && (s.status ?? 0) < 300),
    spent,
    paid: [...paid.values()].map((p) => ({ seller: p.seller, role: p.role, payments: p.payments, usdc: formatUsdc6(usdc6(p.micro)) })),
    error: row.error,
    startedAt: secs(row.started_at)!,
    finishedAt: secs(row.finished_at),
    now: Math.floor(now / 1000),
  };
}

const COLUMNS = "id, agent, network, task, model, brain_url, brain_name, budget_usdc, ceiling_usdc, policy, status, phase, phase_at, steps, answer, spent, error, started_at, finished_at";

async function hasTable(db: Db): Promise<boolean> {
  const r = await db.query<{ t: string | null }>("SELECT to_regclass('public.think_runs')::text AS t");
  return Boolean(r.rows[0]?.t);
}

/** The run happening now if there is one, else the last one. */
export async function latestRun(db: Db): Promise<ThinkRunView | null> {
  if (!(await hasTable(db))) return null;
  const r = await db.query<ThinkRunRow>(
    `SELECT ${COLUMNS} FROM think_runs
     ORDER BY (status = 'running' AND coalesce(phase_at, started_at) > now() - interval '10 minutes') DESC, started_at DESC LIMIT 1`,
  );
  return r.rows[0] ? runView(r.rows[0]) : null;
}

export async function runById(db: Db, id: number): Promise<ThinkRunView | null> {
  if (!(await hasTable(db))) return null;
  const r = await db.query<ThinkRunRow>(`SELECT ${COLUMNS} FROM think_runs WHERE id = $1`, [id]);
  return r.rows[0] ? runView(r.rows[0]) : null;
}

export interface RunsList {
  note: string;
  totals: { runs: number; answered: number; spentUsdc: string; thoughts: number; purchases: number };
  runs: Array<Pick<ThinkRunView, "id" | "task" | "status" | "answer" | "checked" | "spent" | "startedAt" | "finishedAt"> & { sellers: string[] }>;
}

export const RUNS_NOTE = "Runs started by us, with questions we wrote, paid from CRA AGENT's own agent wallet under a spending policy. The payments are real; they are a demonstration, not customers.";

export async function listRuns(db: Db, limit: number): Promise<RunsList> {
  const empty: RunsList = { note: RUNS_NOTE, totals: { runs: 0, answered: 0, spentUsdc: "0", thoughts: 0, purchases: 0 }, runs: [] };
  if (!(await hasTable(db))) return empty;
  const [rows, agg] = await Promise.all([
    db.query<ThinkRunRow>(`SELECT ${COLUMNS} FROM think_runs ORDER BY started_at DESC LIMIT $1`, [limit]),
    db.query<{ runs: string; answered: string; spent: string | null; thoughts: string | null; purchases: string | null }>(
      `SELECT count(*) AS runs, count(*) FILTER (WHERE status = 'answered') AS answered,
              sum((spent ->> 'totalUsdc')::numeric) AS spent, sum((spent ->> 'thoughts')::int) AS thoughts, sum((spent ->> 'purchases')::int) AS purchases
       FROM think_runs`,
    ),
  ]);
  const a = agg.rows[0]!;
  return {
    note: RUNS_NOTE,
    totals: { runs: Number(a.runs), answered: Number(a.answered), spentUsdc: money(a.spent ?? "0"), thoughts: Number(a.thoughts ?? 0), purchases: Number(a.purchases ?? 0) },
    runs: rows.rows.map((row) => {
      const v = runView(row);
      return { id: v.id, task: v.task, status: v.status, answer: v.answer, checked: v.checked, spent: v.spent, startedAt: v.startedAt, finishedAt: v.finishedAt, sellers: v.paid.map((p) => p.seller) };
    }),
  };
}

type Cached = <T>(key: string, ttlMs: number, fn: () => Promise<T>) => Promise<T>;

export function mountThink(app: Hono, db: Db, cached: Cached): void {
  app.get("/v1/think/latest", async (c) => c.json({ run: await cached("think:latest", 1000, () => latestRun(db)) }));
  app.get("/v1/think/runs", async (c) => {
    const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 20) || 20));
    return c.json(await cached(`think:runs:${limit}`, 5000, () => listRuns(db, limit)));
  });
  app.get("/v1/think/runs/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id < 1) return c.json({ error: "a run id is a positive number" }, 400);
    const run = await cached(`think:run:${id}`, 1000, () => runById(db, id));
    return run ? c.json({ run }) : c.json({ error: "no such run" }, 404);
  });
}
