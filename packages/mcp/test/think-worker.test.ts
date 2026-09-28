import { describe, expect, it } from "vitest";
import type { ThinkResult } from "../src/think.js";
import { thinkWorker, type WorkerOptions } from "../src/think-worker.js";

const done = (over: Partial<ThinkResult> = {}): ThinkResult => ({ answer: "42", stoppedBecause: "answered", steps: [], spent: { thinkingUsdc: "0.009", toolsUsdc: "0.004", totalUsdc: "0.013", thoughts: 3, purchases: 1 }, ...over });
const post = (body: unknown) => new Request("http://127.0.0.1:8793/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function worker(over: Partial<WorkerOptions> = {}) {
  const runs: Array<{ task: string; budget: string; deadline: number }> = [];
  const handle = thinkWorker({
    maxBudgetUsdc: "0.095",
    maxMs: 150_000,
    now: () => 1_000_000,
    available: async () => "1.5",
    run: async (task, budget, deadline) => {
      runs.push({ task, budget, deadline });
      return done();
    },
    ...over,
  });
  return { handle, runs };
}

describe("the thinking agent, hired through the API", () => {
  it("runs a task within the budget it is given and a deadline of its own, and says what the run spent", async () => {
    const w = worker();
    const res = await w.handle(post({ task: "  What moved EURC today?  ", budgetUsdc: "0.095" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ answer: "42", spent: { totalUsdc: "0.013" } });
    expect(w.runs).toEqual([{ task: "What moved EURC today?", budget: "0.095", deadline: 1_150_000 }]);
  });

  it("refuses before running: a bad task, a budget over its limit, or a wallet that could not pay for the run", async () => {
    const w = worker();
    expect((await w.handle(post({ task: "hi", budgetUsdc: "0.05" }))).status).toBe(400);
    expect((await w.handle(post({ task: "x".repeat(501), budgetUsdc: "0.05" }))).status).toBe(400);
    expect((await w.handle(post({ task: "What is x402?", budgetUsdc: "0.2" }))).status).toBe(400);
    expect((await w.handle(post({ task: "What is x402?", budgetUsdc: "0" }))).status).toBe(400);
    expect((await w.handle(post({ task: "What is x402?", budgetUsdc: "1e3" }))).status).toBe(400);
    const poor = worker({ available: async () => "0.02" });
    const res = await poor.handle(post({ task: "What is x402?", budgetUsdc: "0.05" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/\$0\.02, less than the \$0\.05/);
    expect([...w.runs, ...poor.runs]).toHaveLength(0);
  });

  it("does one task at a time: a second one is told at once, and runs once the first is done", async () => {
    let finish: (r: ThinkResult) => void = () => {};
    const w = worker({ run: () => new Promise((resolve) => (finish = resolve)) });
    const first = w.handle(post({ task: "What is x402?", budgetUsdc: "0.05" }));
    await new Promise((r) => setTimeout(r, 0));
    const second = await w.handle(post({ task: "What is Arc?", budgetUsdc: "0.05" }));
    expect(second.status).toBe(429);
    expect((await (await w.handle(new Request("http://127.0.0.1:8793/health"))).json())).toEqual({ ok: true, busy: true });
    finish(done());
    expect((await first).status).toBe(200);
    expect((await (await w.handle(new Request("http://127.0.0.1:8793/health"))).json())).toEqual({ ok: true, busy: false });
  });

  it("answers 500 when a run throws, and is free for the next one", async () => {
    const w = worker({ run: async () => { throw new Error("database is down"); } });
    const res = await w.handle(post({ task: "What is x402?", budgetUsdc: "0.05" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/database is down/);
    expect((await (await w.handle(new Request("http://127.0.0.1:8793/health"))).json()).busy).toBe(false);
  });
});
