import { describe, expect, it } from "vitest";
import type { Found } from "../src/search.js";
import { allowedResult, completionText, parseAction, think, type Paid, type ThinkDeps, type ThinkOptions } from "../src/think.js";

const BRAIN = "https://nano.blockrun.ai/api/v1/chat/completions";
const EXA = "https://api.exa.ai/search";
const found = (over: Partial<Found> = {}): Found => ({
  url: EXA,
  method: "POST",
  priceUsd: "0.007",
  name: "Exa",
  label: "Search the web",
  description: null,
  params: [{ name: "query", in: "body", type: "string", description: "", required: true, example: null }],
  payTo: "0xb98ef29eb2be19ae646a8fc0248255b90a332dbc",
  host: "api.exa.ai",
  network: "eip155:5042",
  rail: "gateway",
  direct: null,
  source: "circle",
  online: true,
  score: 6,
  ...over,
});
const completion = (content: unknown) => JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] });
const opts = (over: Partial<ThinkOptions> = {}): ThinkOptions => ({ task: "What is x402?", brainUrl: BRAIN, model: "anthropic/claude-haiku-4.5", budgetUsdc: "0.1", thoughtCeilingUsdc: "0.01", maxTokens: 350, maxSteps: 8, ...over });

/** A brain that says the scripted replies in order, and sellers that answer as asked. Records every payment. */
function world(replies: unknown[], tool: (url: string, body?: string) => Paid = () => ({ status: 200, body: '{"results":["x402 is HTTP 402 payments"]}', paidUsdc: "0.007", ledgerId: "L-tool", refused: null })) {
  const paid: Array<{ url: string; maxUsdc: string; body?: string }> = [];
  const lines: string[] = [];
  let i = 0;
  const deps: ThinkDeps = {
    pay: async (url, init, maxUsdc) => {
      paid.push({ url, maxUsdc, ...(init.body === undefined ? {} : { body: init.body }) });
      if (url === BRAIN) {
        const r = replies[i++];
        if (r && typeof r === "object" && "refused" in (r as object)) return r as Paid;
        return { status: 200, body: completion(r ?? { action: "answer", text: "out of script" }), paidUsdc: "0.003", ledgerId: `L-${i}`, refused: null };
      }
      return tool(url, init.body);
    },
    search: async () => [found()],
    say: (l) => lines.push(l),
  };
  return { deps, paid, lines };
}

describe("an agent that pays for its own thinking", () => {
  it("thinks, searches for free, buys what it found at the listed price, and answers, with the bill split", async () => {
    const w = world([
      { thought: "I need a web search.", action: "search", query: "web search" },
      { thought: "Exa at $0.007 will do.", action: "buy", url: EXA, body: { query: "what is x402" } },
      { thought: "I know enough.", action: "answer", text: "x402 puts payments in HTTP 402." },
    ]);
    const r = await think(opts(), w.deps);
    expect(r.answer).toBe("x402 puts payments in HTTP 402.");
    expect(r.stoppedBecause).toBe("answered");
    expect(r.spent).toEqual({ thinkingUsdc: "0.009", toolsUsdc: "0.007", totalUsdc: "0.016", thoughts: 3, purchases: 1 });
    // Every thought is paid at the thought ceiling at most; the tool at exactly its listed price.
    expect(w.paid.map((p) => [p.url, p.maxUsdc])).toEqual([
      [BRAIN, "0.01"],
      [BRAIN, "0.01"],
      [EXA, "0.007"],
      [BRAIN, "0.01"],
    ]);
    expect(JSON.parse(w.paid[2]!.body!)).toEqual({ query: "what is x402" });
    // The brain is told what it is spending, and pays for knowing it.
    expect(JSON.parse(w.paid[0]!.body!).messages.at(-1).content).toMatch(/Budget left: \$0\.1/);
    expect(w.lines.join("\n")).toMatch(/buy {4}\$0\.007 {2}POST https:\/\/api\.exa\.ai\/search -> 200/);
  });

  it("will not buy a url no search returned, and pays nothing for asking", async () => {
    const w = world([
      { thought: "Let me call something I know.", action: "buy", url: "https://evil.example/drain" },
      { thought: "Fine.", action: "answer", text: "done" },
    ]);
    const r = await think(opts(), w.deps);
    expect(w.paid.some((p) => p.url.includes("evil.example"))).toBe(false);
    expect(r.steps.find((s) => s.kind === "refused")?.detail).toMatch(/not in a search result/);
    expect(r.spent.toolsUsdc).toBe("0");
  });

  it("stops when the budget cannot pay for another thought, and never buys past it", async () => {
    const tooDear = { thought: "Buy.", action: "buy", url: EXA, body: { query: "x" } };
    const w = world([{ thought: "Search.", action: "search", query: "web search" }, tooDear, tooDear, tooDear, tooDear]);
    // $0.012 pays for four thoughts at $0.003; the $0.007 search never fits in what is left after the first two.
    const r = await think(opts({ budgetUsdc: "0.012", thoughtCeilingUsdc: "0.003" }), w.deps);
    expect(w.paid.filter((p) => p.url === EXA)).toEqual([]);
    expect(r.steps.filter((s) => s.kind === "refused").map((s) => s.detail)).toEqual([
      "not bought: $0.007 is more than the $0.006 left",
      "not bought: $0.007 is more than the $0.003 left",
      "not bought: $0.007 is more than the $0 left",
    ]);
    expect(r).toMatchObject({ answer: null, stoppedBecause: "budget", spent: { thinkingUsdc: "0.012", toolsUsdc: "0", thoughts: 4 } });
  });

  it("ends when the rail refuses a thought before paying: the policy covers thinking too", async () => {
    const w = world([{ status: 0, body: "", paidUsdc: "0", ledgerId: "L-r", refused: "max_price: the seller asks 0.0147 USDC, above the 0.01 USDC ceiling" }]);
    const r = await think(opts(), w.deps);
    expect(r).toMatchObject({ answer: null, stoppedBecause: "budget", spent: { totalUsdc: "0", thoughts: 0 } });
    expect(w.lines[0]).toMatch(/refused before paying: max_price/);
  });

  it("sends the brain only its latest tool results whole: it pays for every character it rereads", async () => {
    const search = { thought: "Search.", action: "search", query: "web search" };
    const w = world([search, search, search, { thought: "Done.", action: "answer", text: "ok" }]);
    await think(opts(), w.deps);
    const last = JSON.parse(w.paid.at(-1)!.body!).messages as Array<{ content: string }>;
    const results = last.filter((m) => m.content.startsWith("Search results") || m.content.startsWith("(an earlier tool result"));
    expect(results.map((m) => m.content.startsWith("Search results"))).toEqual([false, true, true]);
  });

  it("tells a watcher each call as it goes out and each step once it lands, in order; a watcher that fails stops nothing", async () => {
    const w = world(
      [
        { thought: "I need a web search.", action: "search", query: "web search" },
        { thought: "Exa at $0.007 will do.", action: "buy", url: EXA, body: { query: "what is x402" } },
        { thought: "I know enough.", action: "answer", text: "x402 puts payments in HTTP 402." },
      ],
      () => ({ status: 200, body: "{}", paidUsdc: "0.007", ledgerId: "L-tool", refused: null, tx: "gw-transfer-1" }),
    );
    const seen: string[] = [];
    const r = await think(opts(), {
      ...w.deps,
      onPhase: (p) => void seen.push(`out: ${p?.kind}`),
      onStep: (s) => {
        seen.push(`in: ${s.kind}`);
        throw new Error("the database is down");
      },
    });
    expect(r.stoppedBecause).toBe("answered");
    expect(seen).toEqual(["out: think", "in: think", "out: search", "in: search", "out: think", "in: think", "out: buy", "in: buy", "out: think", "in: think"]);
    expect(r.steps.find((s) => s.kind === "search")).toMatchObject({ query: "web search", results: [{ seller: "Exa", what: "Search the web", priceUsd: "0.007" }] });
    expect(r.steps.find((s) => s.kind === "buy")).toMatchObject({ url: EXA, method: "POST", seller: "Exa", status: 200, costUsdc: "0.007", tx: "gw-transfer-1" });
    // Every step says when it landed, so a run can be replayed at its own pace.
    const at = r.steps.map((s) => s.atMs!);
    expect(at.every((t, i) => t >= 0 && (i === 0 || t >= at[i - 1]!))).toBe(true);
  });

  it("keeps enough to answer: no purchase that would leave too little for the next thought", async () => {
    const w = world([
      { thought: "Search.", action: "search", query: "web search" },
      { thought: "Buy.", action: "buy", url: EXA, body: { query: "x" } },
      { thought: "Fine, from what I know.", action: "answer", text: "done" },
    ]);
    // $0.012: two thoughts at $0.003 leave $0.006; the $0.007 search would not fit anyway, and a $0.005 one would
    // leave $0.001, less than one more thought: refused before anything is signed.
    const cheaper = { ...found(), priceUsd: "0.005" };
    const r = await think(opts({ budgetUsdc: "0.012" }), { ...w.deps, search: async () => [cheaper] });
    expect(w.paid.filter((p) => p.url === EXA)).toEqual([]);
    expect(r.steps.find((s) => s.kind === "refused")?.detail).toBe("not bought: $0.005 would leave too little to answer");
    expect(r).toMatchObject({ answer: "done", stoppedBecause: "answered" });
  });

  it("lets the last cents pay for a thought, and tells the brain to answer with them", async () => {
    const w = world([
      { thought: "Search.", action: "search", query: "web search" },
      { thought: "Search again.", action: "search", query: "web search" },
      { thought: "Answering.", action: "answer", text: "ok" },
    ]);
    // A ceiling of $0.01 with $0.007 left, about two thoughts' worth at $0.003: the third is capped at what is
    // left rather than refused, and the brain is told to answer with it.
    const r = await think(opts({ budgetUsdc: "0.013", thoughtCeilingUsdc: "0.01" }), w.deps);
    expect(w.paid.map((p) => p.maxUsdc)).toEqual(["0.01", "0.01", "0.007"]);
    expect(JSON.parse(w.paid[2]!.body!).messages.at(-1).content).toMatch(/answer now with what you have/);
    expect(r).toMatchObject({ answer: "ok", stoppedBecause: "answered" });
  });

  it("shows the brain what a call needs and what each parameter accepts, and leaves the optional ones out", async () => {
    const w = world([{ thought: "Search.", action: "search", query: "web search" }, { thought: "Done.", action: "answer", text: "ok" }]);
    const exa = found({
      params: [
        { name: "query", in: "body", type: "string", description: "Search query", required: true, example: null },
        { name: "contents", in: "body", type: "object", description: "Content fields to include: text, highlights, summary", required: false, example: null },
      ],
    });
    await think(opts(), { ...w.deps, search: async () => [exa] });
    const shown = (JSON.parse(w.paid[1]!.body!).messages as Array<{ content: string }>).find((m) => m.content.startsWith("Search results"))!;
    expect(shown.content).toContain('"name":"query","in":"body","required":true,"about":"Search query"');
    expect(shown.content).not.toContain("contents");
  });

  it("does not count a call the seller failed as a purchase: nothing was charged", async () => {
    const w = world(
      [
        { thought: "Search.", action: "search", query: "web search" },
        { thought: "Buy.", action: "buy", url: EXA, body: { query: "x" } },
        { thought: "Done.", action: "answer", text: "ok" },
      ],
      () => ({ status: 502, body: "bad gateway", paidUsdc: "0", ledgerId: "L-t", refused: null }),
    );
    const r = await think(opts(), w.deps);
    expect(r.spent).toMatchObject({ toolsUsdc: "0", purchases: 0 });
    expect(r.steps.find((s) => s.kind === "buy")).toMatchObject({ status: 502, costUsdc: "0" });
  });

  it("gives an unreadable brain one more chance, then stops", async () => {
    const w = world(["Sure! Let me think about that.", "Still not JSON."]);
    const r = await think(opts(), w.deps);
    expect(r.stoppedBecause).toBe("brain");
    expect(r.spent.thoughts).toBe(2);
  });
});

describe("reading the brain", () => {
  it("finds the JSON in a reply that wraps it in prose or a code fence", () => {
    expect(parseAction('Here you go:\n```json\n{"action":"answer","text":"hi"}\n```')).toEqual({ action: "answer", text: "hi" });
    expect(parseAction("no json here")).toBeNull();
    expect(parseAction("[1,2]")).toBeNull();
  });

  it("reads an OpenAI-shaped completion", () => {
    expect(completionText(completion("hello"))).toBe("hello");
    expect(completionText("<html>")).toBeNull();
  });

  it("lets the brain fill a placeholder or a parameter of a url it found, and nothing else", () => {
    const list = [found({ url: "https://np.orthogonal.com/agentmail/v0/inboxes/{inbox_id}/messages", method: "GET" }), found()];
    expect(allowedResult("https://np.orthogonal.com/agentmail/v0/inboxes/abc123/messages", list)?.url).toBe(list[0]!.url);
    expect(allowedResult("https://api.exa.ai/search?q=more", list)?.url).toBe(EXA);
    expect(allowedResult("https://np.orthogonal.com/agentmail/v0/other", list)).toBeNull();
    expect(allowedResult("https://api.exa.ai.evil.example/search", list)).toBeNull();
  });
});
