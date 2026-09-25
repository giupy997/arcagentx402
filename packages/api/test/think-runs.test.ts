import { describe, expect, it } from "vitest";
import { runView, spentFrom, STALE_MS, type ThinkRunRow } from "../src/think-runs.js";

const T0 = new Date("2026-09-25T14:00:00Z");
const row = (over: Partial<ThinkRunRow> = {}): ThinkRunRow => ({
  id: "7",
  agent: "0xe5a67b7ddf06A6e63A8e0423195aA3b76002cF2B",
  network: "eip155:5042",
  task: "When did Arc mainnet go live?",
  model: "anthropic/claude-haiku-4.5",
  brain_url: "https://nano.blockrun.ai/api/v1/chat/completions",
  brain_name: "BlockRun.AI",
  budget_usdc: "0.050000",
  ceiling_usdc: "0.010000",
  policy: { perPaymentCapUsdc: "0.01" },
  status: "running",
  phase: { kind: "buy", url: "https://api.exa.ai/search", method: "POST", seller: "Exa", priceUsd: "0.007" },
  phase_at: new Date(T0.getTime() + 9_000),
  steps: [
    { kind: "think", detail: "I need a web search.", costUsdc: "0.003026", ledgerId: "1", tx: "c9229599-ff5b-4f65-ae0a-e75085fdf83b", atMs: 3100, ms: 3050 },
    { kind: "search", detail: '"web search": 6 results', costUsdc: "0", ledgerId: null, query: "web search", results: [{ seller: "Exa", what: "Search the web", priceUsd: "0.007" }], atMs: 3400 },
    { kind: "think", detail: "Exa will do.", costUsdc: "0.00467", ledgerId: "2", tx: "af0156fb", atMs: 8900 },
    { kind: "fetch", detail: "GET https://api.dexscreener.com/token-boosts/top/v1 -> 200", costUsdc: "0", ledgerId: null, url: "https://api.dexscreener.com/token-boosts/top/v1", method: "GET", seller: "DexScreener", status: 200, atMs: 9000 },
    { kind: "nonsense", detail: "dropped" },
  ],
  answer: null,
  spent: null,
  error: null,
  started_at: T0,
  finished_at: null,
  ...over,
});

describe("a thinking run as the page reads it", () => {
  it("while it runs: the call that is out, the bill so far from its steps, and nothing checked yet", () => {
    const v = runView(row(), T0.getTime() + 10_000);
    expect(v.status).toBe("running");
    expect(v.phase).toMatchObject({ kind: "buy", seller: "Exa" });
    expect(v.steps.map((s) => s.kind)).toEqual(["think", "search", "think", "fetch"]);
    expect(v.spent).toEqual({ thinkingUsdc: "0.007696", toolsUsdc: "0", totalUsdc: "0.007696", thoughts: 2, purchases: 0 });
    expect(v.paid).toEqual([{ seller: "BlockRun.AI", role: "brain", payments: 2, usdc: "0.007696" }]);
    // It read DexScreener's answer (free, 200): what it says next rests on that, not on the model alone.
    expect(v.checked).toBe(true);
    expect(runView(row({ steps: (row().steps as unknown[]).slice(0, 3) }), T0.getTime() + 10_000).checked).toBe(false);
    expect(v.budgetUsdc).toBe("0.05");
  });

  it("a run left running with nothing new for ten minutes died with its process", () => {
    const v = runView(row(), T0.getTime() + 9_000 + STALE_MS + 1);
    expect(v.status).toBe("interrupted");
    expect(v.phase).toBeNull();
  });

  it("once answered: the recorded bill, who was paid for what, and an answer that rests on a purchase", () => {
    const steps = [
      ...(row().steps as unknown[]).slice(0, 4),
      { kind: "buy", detail: "POST https://api.exa.ai/search -> 200", costUsdc: "0.007", ledgerId: "3", tx: "cfc8afb6", url: "https://api.exa.ai/search", method: "POST", seller: "Exa", status: 200, atMs: 11_000 },
      { kind: "think", detail: "Done.", costUsdc: "0.004871", ledgerId: "4", atMs: 15_000 },
    ];
    const spent = { thinkingUsdc: "0.012567", toolsUsdc: "0.007", totalUsdc: "0.019567", thoughts: 3, purchases: 1 };
    const v = runView(row({ status: "answered", steps, spent, answer: "16 September 2026.", phase: null, finished_at: new Date(T0.getTime() + 15_500) }), T0.getTime() + 60_000);
    expect(v.spent).toEqual(spent);
    expect(spentFrom(v.steps)).toEqual(spent);
    expect(v.paid).toEqual([
      { seller: "BlockRun.AI", role: "brain", payments: 3, usdc: "0.012567" },
      { seller: "Exa", role: "tool", payments: 1, usdc: "0.007" },
    ]);
    expect(v.checked).toBe(true);
    expect(v.steps[3]).toMatchObject({ kind: "fetch", seller: "DexScreener", costUsdc: "0" });
    expect(v.steps[4]).toMatchObject({ kind: "buy", seller: "Exa", status: 200, tx: "cfc8afb6" });
  });
});
