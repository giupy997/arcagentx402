import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { RpcPool, detectBatchLimit } from "../src/rpc/pool.js";

const log = pino({ level: "silent" });

type Handler = (body: unknown) => { status?: number; json?: unknown; text?: string } | Promise<{ status?: number; json?: unknown; text?: string }>;

function mockFetch(handlers: Record<string, Handler>) {
  const calls: Record<string, number> = {};
  const f = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls[u] = (calls[u] ?? 0) + 1;
    const h = handlers[u];
    if (!h) throw new TypeError("fetch failed");
    const r = await h(JSON.parse(String(init?.body)));
    const status = r.status ?? 200;
    const body = r.text ?? JSON.stringify(r.json);
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  });
  return { f, calls };
}

const okResult = (body: unknown, result: unknown) => {
  const arr = Array.isArray(body) ? body : [body];
  const out = arr.map((m: { id: number }) => ({ jsonrpc: "2.0", id: m.id, result }));
  return { json: Array.isArray(body) ? out : out[0] };
};

describe("RpcPool failover", () => {
  let realFetch: typeof fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("uses the first endpoint when healthy", async () => {
    const { f, calls } = mockFetch({ "https://a/": (b) => okResult(b, "0x1"), "https://b/": (b) => okResult(b, "0x1") });
    globalThis.fetch = f as unknown as typeof fetch;
    const pool = new RpcPool(["https://a/", "https://b/"], { timeoutMs: 1000, lagTolerance: 20, log });
    const r = await pool.call("eth_blockNumber", []);
    expect(r.endpoint).toBe("https://a/");
    expect(calls["https://b/"]).toBeUndefined();
  });

  it("fails over to the second endpoint on HTTP 5xx and puts the first in cooldown", async () => {
    const { f, calls } = mockFetch({ "https://a/": () => ({ status: 502, text: "bad gateway" }), "https://b/": (b) => okResult(b, "0x2") });
    globalThis.fetch = f as unknown as typeof fetch;
    const errors: unknown[] = [];
    const pool = new RpcPool(["https://a/", "https://b/"], { timeoutMs: 1000, lagTolerance: 20, log, onError: (e) => errors.push(e) });
    const r = await pool.call("eth_blockNumber", []);
    expect(r.endpoint).toBe("https://b/");
    expect(calls["https://a/"]).toBe(1);
    expect(pool.endpoints[0]!.consecutiveFailures).toBe(1);
    expect(pool.endpoints[0]!.cooldownUntil).toBeGreaterThan(Date.now());
    expect(errors).toHaveLength(1);
    // Next call skips the cooling endpoint entirely
    const r2 = await pool.call("eth_blockNumber", []);
    expect(r2.endpoint).toBe("https://b/");
    expect(calls["https://a/"]).toBe(1);
  });

  it("treats rate-limit JSON-RPC errors as endpoint failures and retries elsewhere", async () => {
    const { f } = mockFetch({
      "https://a/": (b) => ({ json: (Array.isArray(b) ? b : [b]).map((m: { id: number }) => ({ jsonrpc: "2.0", id: m.id, error: { code: -32005, message: "rate limited" } })) }),
      "https://b/": (b) => okResult(b, "0x3"),
    });
    globalThis.fetch = f as unknown as typeof fetch;
    const pool = new RpcPool(["https://a/", "https://b/"], { timeoutMs: 1000, lagTolerance: 20, log });
    const r = await pool.batch([
      { method: "eth_getBlockByNumber", params: ["0x1", true] },
      { method: "eth_getBlockReceipts", params: ["0x1"] },
    ]);
    expect(r.endpoint).toBe("https://b/");
    expect(r.outcomes.every((o) => o.ok)).toBe(true);
  });

  it("returns non-retryable JSON-RPC errors as outcomes without failing over", async () => {
    const { f, calls } = mockFetch({
      "https://a/": (b) => ({ json: { jsonrpc: "2.0", id: (b as { id: number }).id, error: { code: -32602, message: "invalid params" } } }),
      "https://b/": (b) => okResult(b, "0x3"),
    });
    globalThis.fetch = f as unknown as typeof fetch;
    const pool = new RpcPool(["https://a/", "https://b/"], { timeoutMs: 1000, lagTolerance: 20, log });
    const r = await pool.call("eth_getLogs", [{}]);
    expect(r.endpoint).toBe("https://a/");
    expect(r.outcome.ok).toBe(false);
    expect(calls["https://b/"]).toBeUndefined();
  });

  it("deprioritises a lagging endpoint", async () => {
    const { f } = mockFetch({ "https://a/": (b) => okResult(b, "0x1"), "https://b/": (b) => okResult(b, "0x1") });
    globalThis.fetch = f as unknown as typeof fetch;
    const pool = new RpcPool(["https://a/", "https://b/"], { timeoutMs: 1000, lagTolerance: 20, log });
    pool.recordHead("https://a/", 1000);
    pool.recordHead("https://b/", 1050);
    const r = await pool.call("eth_blockNumber", []);
    expect(r.endpoint).toBe("https://b/");
  });

  it("throws after exhausting attempts when every endpoint is down", async () => {
    const { f } = mockFetch({});
    globalThis.fetch = f as unknown as typeof fetch;
    const pool = new RpcPool(["https://a/", "https://b/"], { timeoutMs: 200, lagTolerance: 20, log, maxAttempts: 3 });
    await expect(pool.call("eth_blockNumber", [])).rejects.toThrow();
    expect(pool.endpoints.every((e) => e.totalFailures > 0)).toBe(true);
  });

  it("disables endpoints with a mismatched chain id (startup guard)", () => {
    const { f } = mockFetch({});
    globalThis.fetch = f as unknown as typeof fetch;
    const pool = new RpcPool(["https://a/"], { timeoutMs: 200, lagTolerance: 20, log });
    pool.disable("https://a/", "chain id mismatch");
    expect(pool.candidates()).toHaveLength(0);
    expect(pool.healthy()).toBe(false);
  });
});

describe("batch limits", () => {
  it("parses provider messages", () => {
    expect(detectBatchLimit('HTTP 500: [{"id":274,"jsonrpc":"2.0","error":{"message":"Batch of more than 3 requests are not allowed"}}]')).toBe(3);
    expect(detectBatchLimit("exceeds maximum batch size (10)")).toBe(10);
    expect(detectBatchLimit("batch too large")).toBe(1);
    expect(detectBatchLimit("execution reverted")).toBeNull();
  });

  it("learns the limit, then chunks on that endpoint when it is the only one", async () => {
    let realFetch = globalThis.fetch;
    const sizes: number[] = [];
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const arr = Array.isArray(body) ? body : [body];
      sizes.push(arr.length);
      if (arr.length > 3) return new Response('[{"jsonrpc":"2.0","id":1,"error":{"message":"Batch of more than 3 requests are not allowed"}}]', { status: 500 });
      const out = arr.map((m: { id: number }) => ({ jsonrpc: "2.0", id: m.id, result: "0x1" }));
      return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const pool = new RpcPool(["https://only/"], { timeoutMs: 1000, lagTolerance: 20, log });
      const calls = Array.from({ length: 8 }, (_, i) => ({ method: "eth_blockNumber", params: [i] }));
      const r = await pool.batch(calls);
      expect(r.outcomes).toHaveLength(8);
      expect(r.outcomes.every((o) => o.ok)).toBe(true);
      expect(pool.endpoints[0]!.maxBatch).toBe(3);
      expect(sizes).toEqual([8, 3, 3, 2]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
