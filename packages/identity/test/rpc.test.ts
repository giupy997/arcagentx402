import { describe, expect, it } from "vitest";
import { mergeRpcLists, parseRpcList, pickRpcUrl, redactRpcUrl } from "../src/rpc.js";

type Kind = "ok" | "wrong-chain" | "down" | "hangs" | "http-500" | "rate-limited" | { head: number } | { delayMs: number };

/** A fake network: each url maps to what it does when asked. Counts what is still in flight. */
function net(behaviour: Record<string, Kind>) {
  const stats = { inFlight: 0, calls: 0 };
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    stats.calls++;
    const kind = behaviour[String(input)]!;
    const method = (JSON.parse(String(init?.body)) as { method: string }).method;
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const wait = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        stats.inFlight++;
        const done = (fn: () => void) => () => { stats.inFlight--; fn(); };
        const t = setTimeout(done(resolve), ms);
        init?.signal?.addEventListener("abort", done(() => { clearTimeout(t); reject(new DOMException("aborted", init.signal?.reason?.name ?? "AbortError")); }));
      });
    if (kind === "down") throw new TypeError("fetch failed");
    if (kind === "http-500") return reply({}, 500);
    if (kind === "rate-limited") return reply({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limit exceeded" } });
    if (kind === "hangs") await wait(60_000);
    if (typeof kind === "object" && "delayMs" in kind) await wait(kind.delayMs);
    if (method === "eth_chainId") return reply({ jsonrpc: "2.0", id: 1, result: kind === "wrong-chain" ? "0x1" : "0x13b2" }); // 5042
    const head = typeof kind === "object" && "head" in kind ? kind.head : 1_000_000;
    return reply({ jsonrpc: "2.0", id: 1, result: `0x${head.toString(16)}` });
  }) as typeof fetch;
  return { doFetch, stats };
}
const fast = { timeoutMs: 300, graceMs: 80, retries: 0 };

describe("picking an endpoint that answers", () => {
  it("skips a dead endpoint and takes a live one", async () => {
    const { doFetch } = net({ "https://a": "down", "https://b": "ok" });
    expect(await pickRpcUrl(["https://a", "https://b"], 5042, { ...fast, fetch: doFetch })).toBe("https://b");
  });

  it("refuses an endpoint that answers for another chain", async () => {
    const { doFetch } = net({ "https://a": "wrong-chain", "https://b": "ok" });
    expect(await pickRpcUrl(["https://a", "https://b"], 5042, { ...fast, fetch: doFetch })).toBe("https://b");
  });

  it("treats a rate limit and an HTTP error as not answering", async () => {
    const { doFetch } = net({ "https://a": "rate-limited", "https://b": "http-500", "https://c": "ok" });
    expect(await pickRpcUrl(["https://a", "https://b", "https://c"], 5042, { ...fast, fetch: doFetch })).toBe("https://c");
  });

  it("keeps the operator's order: a slightly slower first choice still wins", async () => {
    // The own node answers in 40 ms, the public one at once. Fastest-wins would hand over the public one.
    const { doFetch } = net({ "https://own-node": { delayMs: 20 }, "https://public": "ok" });
    expect(await pickRpcUrl(["https://own-node", "https://public"], 5042, { ...fast, fetch: doFetch })).toBe("https://own-node");
  });

  it("does not wait long for a first choice that hangs", async () => {
    const { doFetch } = net({ "https://a": "hangs", "https://b": "ok" });
    const started = Date.now();
    expect(await pickRpcUrl(["https://a", "https://b"], 5042, { ...fast, fetch: doFetch })).toBe("https://b");
    expect(Date.now() - started).toBeLessThan(250); // the grace, not the timeout
  });

  it("passes over a node that answers but has fallen behind the chain", async () => {
    const { doFetch } = net({ "https://stalled": { head: 900_000 }, "https://b": { head: 1_000_000 } });
    expect(await pickRpcUrl(["https://stalled", "https://b"], 5042, { ...fast, fetch: doFetch })).toBe("https://b");
  });

  it("cancels the losers, so nothing keeps the process alive", async () => {
    const { doFetch, stats } = net({ "https://a": "ok", "https://b": "hangs" });
    await pickRpcUrl(["https://a", "https://b"], 5042, { ...fast, fetch: doFetch });
    await new Promise((r) => setTimeout(r, 20));
    expect(stats.inFlight).toBe(0);
  });

  it("tries again before giving up, because a rate limit clears", async () => {
    let round = 0;
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (JSON.parse(String(init?.body)) as { method: string }).method;
      if (method === "eth_chainId") round++;
      if (round === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: method === "eth_chainId" ? "0x13b2" : "0x10" }));
    }) as typeof fetch;
    expect(await pickRpcUrl(["https://a"], 5042, { timeoutMs: 300, retries: 1, retryDelayMs: 10, fetch: flaky })).toBe("https://a");
  });

  it("says why when nothing answers, without printing a key", async () => {
    const { doFetch } = net({ "https://host.example/v2/SECRETKEY": "down", "https://b": "wrong-chain" });
    const err = await pickRpcUrl(["https://host.example/v2/SECRETKEY", "https://b"], 5042, { ...fast, fetch: doFetch }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/no RPC endpoint answered.*fetch failed.*chain id 0x1/);
    expect((err as Error).message).not.toContain("SECRETKEY");
    await expect(pickRpcUrl([], 5042)).rejects.toThrow(/no RPC endpoint to try/);
  });
});

describe("the endpoint list", () => {
  it("splits on commas and ignores blanks", () => {
    expect(parseRpcList(" https://a , ,https://b,")).toEqual(["https://a", "https://b"]);
    expect(parseRpcList(undefined)).toEqual([]);
  });

  it("puts configured endpoints first and adds the public ones after, each once", () => {
    // The case that started this: one configured endpoint that drops connections must not be the only one.
    expect(mergeRpcLists(["https://rpc.mainnet.arc.io"], ["https://b", "https://rpc.mainnet.arc.io/", "https://c"])).toEqual(["https://rpc.mainnet.arc.io", "https://b", "https://c"]);
  });

  it("hides the path and the query, where provider keys live", () => {
    expect(redactRpcUrl("https://arc-mainnet.g.alchemy.com/v2/abc123")).toBe("https://arc-mainnet.g.alchemy.com/…");
    expect(redactRpcUrl("https://rpc.mainnet.arc.io/")).toBe("https://rpc.mainnet.arc.io");
    expect(redactRpcUrl("https://x.example/?key=abc")).toBe("https://x.example/…");
    expect(redactRpcUrl("not a url")).toBe("(unparseable url)");
  });
});
