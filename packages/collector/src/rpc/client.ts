import type { JsonRpcCall, JsonRpcErrorShape } from "./types.js";

export class RpcError extends Error {
  override readonly name = "RpcError";
  constructor(
    message: string,
    readonly endpoint: string,
    readonly method: string,
    readonly code: number | null,
    readonly retryable: boolean,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface RpcResult<T = unknown> {
  ok: true;
  result: T;
}
export interface RpcFailure {
  ok: false;
  error: JsonRpcErrorShape;
}
export type RpcOutcome<T = unknown> = RpcResult<T> | RpcFailure;

const USER_AGENT = "arc-rail-collector/0.0.1";

/** JSON-RPC error codes we treat as transient (retry on same or other endpoint). */
export function isRetryableRpcCode(code: number): boolean {
  // -32005 limit exceeded (Infura/Alchemy), -32603 internal, -32000 generic server error,
  // -32012 "requested range too large" is NOT retryable, -32601/-32602 are not.
  return code === -32005 || code === -32603 || code === -32000 || code === 429 || code === -32016;
}

interface TransportOptions {
  timeoutMs: number;
}

let nextId = 1;

async function post(endpoint: string, body: unknown, opts: TransportOptions): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": USER_AGENT, accept: "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500 || res.status === 408;
      throw new RpcError(`HTTP ${res.status}: ${text.slice(0, 200)}`, endpoint, "http", res.status, retryable);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new RpcError(`non-JSON response: ${text.slice(0, 200)}`, endpoint, "http", null, true);
    }
  } catch (err) {
    if (err instanceof RpcError) throw err;
    const e = err as Error & { cause?: { code?: string } };
    const msg = e.name === "AbortError" ? `timeout after ${opts.timeoutMs}ms` : `${e.message}${e.cause?.code ? ` (${e.cause.code})` : ""}`;
    throw new RpcError(msg, endpoint, "http", null, true);
  } finally {
    clearTimeout(timer);
  }
}

function toOutcome(endpoint: string, method: string, msg: unknown): RpcOutcome {
  if (!msg || typeof msg !== "object") {
    throw new RpcError("malformed JSON-RPC envelope", endpoint, method, null, true);
  }
  const m = msg as { result?: unknown; error?: JsonRpcErrorShape };
  if (m.error) return { ok: false, error: m.error };
  return { ok: true, result: m.result };
}

/** Single JSON-RPC call. Throws RpcError for transport problems; returns error outcome for JSON-RPC errors. */
export async function rpcCall<T = unknown>(endpoint: string, call: JsonRpcCall, opts: TransportOptions): Promise<RpcOutcome<T>> {
  const id = nextId++;
  const msg = await post(endpoint, { jsonrpc: "2.0", id, method: call.method, params: call.params }, opts);
  return toOutcome(endpoint, call.method, msg) as RpcOutcome<T>;
}

/** Batched JSON-RPC. Results are returned in the same order as `calls` (matched by id). */
export async function rpcBatch(endpoint: string, calls: readonly JsonRpcCall[], opts: TransportOptions): Promise<RpcOutcome[]> {
  if (calls.length === 0) return [];
  const base = nextId;
  nextId += calls.length;
  const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: base + i, method: c.method, params: c.params }));
  const msg = await post(endpoint, body, opts);
  if (!Array.isArray(msg)) {
    // Some gateways answer a batch with a single error object (e.g. batch too large / rate limited).
    const single = msg as { error?: JsonRpcErrorShape };
    if (single?.error) {
      throw new RpcError(`batch rejected: ${single.error.message}`, endpoint, "batch", single.error.code, isRetryableRpcCode(single.error.code) || true);
    }
    throw new RpcError("batch response is not an array", endpoint, "batch", null, true);
  }
  const byId = new Map<number, unknown>();
  for (const item of msg) {
    const it = item as { id?: number };
    if (typeof it?.id === "number") byId.set(it.id, item);
  }
  return calls.map((c, i) => {
    const item = byId.get(base + i);
    if (item === undefined) throw new RpcError(`batch response missing id for ${c.method}`, endpoint, c.method, null, true);
    return toOutcome(endpoint, c.method, item);
  });
}
