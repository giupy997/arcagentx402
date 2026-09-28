/**
 * The thinking agent, hired: a server on this machine that runs one task at a time for whoever the API sold
 * it to, with this process's wallet and spending policy, and answers with what the run found and spent.
 *
 * It listens on 127.0.0.1 only, like the facilitator. The public side is the API's /v1/upto/think: it takes
 * the buyer's payment first, an authorization for a ceiling, then asks here, then charges what the run spent
 * plus its fee. Nothing here knows who the buyer is. The wallet's own daily limit bounds what anyone can make
 * it spend, paid or not.
 */
import { createServer, type Server } from "node:http";
import { compareUsdc6, parseUsdc6 } from "@cra-agent/accounting";
import type { ThinkResult } from "./think.js";

export interface WorkerOptions {
  /** One task, within a budget in USDC, ending by the deadline (epoch milliseconds). */
  run(task: string, budgetUsdc: string, deadline: number): Promise<ThinkResult>;
  /** What the wallet can spend right now, in USDC. A run is refused, before it starts, when that is less than its budget. */
  available(): Promise<string>;
  /** The most one run may be given. */
  maxBudgetUsdc: string;
  /** How long a run may take, in milliseconds. The caller should wait a little longer than this. */
  maxMs: number;
  log?: (event: string, data: Record<string, unknown>) => void;
  now?: () => number;
}

const AMOUNT = /^\d{1,6}(\.\d{1,6})?$/;
export const TASK_MAX_CHARS = 500;

export function thinkWorker(o: WorkerOptions): (req: Request) => Promise<Response> {
  const log = o.log ?? (() => {});
  const now = o.now ?? Date.now;
  let busy = false;
  return async (req) => {
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path === "/health") return Response.json({ ok: true, busy });
    if (req.method !== "POST" || path !== "/run") return Response.json({ error: "not found" }, { status: 404 });
    // One at a time: a second buyer is told at once, before anything is spent, and the API does not charge them.
    if (busy) return Response.json({ error: "busy: the agent is working on another task" }, { status: 429 });
    const b = (await req.json().catch(() => null)) as { task?: unknown; budgetUsdc?: unknown } | null;
    const task = typeof b?.task === "string" ? b.task.trim() : "";
    if (task.length < 3 || task.length > TASK_MAX_CHARS) return Response.json({ error: `task: between 3 and ${TASK_MAX_CHARS} characters` }, { status: 400 });
    const budget = typeof b?.budgetUsdc === "string" && AMOUNT.test(b.budgetUsdc) ? b.budgetUsdc : null;
    if (!budget || parseUsdc6(budget) === 0n || compareUsdc6(parseUsdc6(budget), parseUsdc6(o.maxBudgetUsdc)) > 0) return Response.json({ error: `budgetUsdc: more than 0 and at most ${o.maxBudgetUsdc}` }, { status: 400 });
    busy = true;
    try {
      const available = await o.available().catch(() => null);
      if (available === null || compareUsdc6(parseUsdc6(available), parseUsdc6(budget)) < 0) {
        log("run.refused", { reason: "wallet", available, budget });
        return Response.json({ error: available === null ? "could not read the agent's wallet" : `the agent's wallet has $${available}, less than the $${budget} this run may spend` }, { status: 503 });
      }
      const started = now();
      const r = await o.run(task, budget, started + o.maxMs);
      log("run.done", { stoppedBecause: r.stoppedBecause, spentUsdc: r.spent.totalUsdc, thoughts: r.spent.thoughts, purchases: r.spent.purchases, ms: now() - started });
      return Response.json(r);
    } catch (err) {
      log("run.failed", { error: (err as Error).message.slice(0, 200) });
      return Response.json({ error: `the run failed: ${(err as Error).message.slice(0, 160)}` }, { status: 500 });
    } finally {
      busy = false;
    }
  };
}

/** The handler on 127.0.0.1:port, and nowhere else. */
export function serveLocal(handler: (req: Request) => Promise<Response>, port: number, onListening?: () => void): Server {
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      if (body && body.length > 16_384) {
        res.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error: "body too large" }));
        return;
      }
      const r = await handler(new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, { method: req.method ?? "GET", headers: { "content-type": String(req.headers["content-type"] ?? "application/json") }, ...(body && req.method !== "GET" ? { body } : {}) }));
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" }).end(await r.text());
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: (err as Error).message.slice(0, 160) }));
    }
  });
  server.listen(port, "127.0.0.1", onListening);
  return server;
}
