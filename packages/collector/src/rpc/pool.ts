import { redactUrl } from "../config.js";
import type { Logger } from "../log.js";
import { RpcError, isRetryableRpcCode, rpcBatch, rpcCall, type RpcOutcome } from "./client.js";
import type { JsonRpcCall } from "./types.js";

export interface EndpointState {
  readonly url: string;
  readonly name: string;
  readonly priority: number;
  consecutiveFailures: number;
  cooldownUntil: number;
  latencyEwmaMs: number;
  lastHead: number | null;
  lastHeadAt: number | null;
  totalCalls: number;
  totalFailures: number;
  disabledReason: string | null;
  /** Largest JSON-RPC batch this endpoint accepts (learned from 'batch too large' errors). */
  maxBatch: number;
}

export interface PoolOptions {
  timeoutMs: number;
  /** Endpoints whose head is more than this many blocks behind the best-known head are deprioritised. */
  lagTolerance: number;
  maxAttempts?: number;
  onError?: (e: { endpoint: string; method: string; code: number | null; message: string; durationMs: number; blockNumber?: number }) => void;
  log: Logger;
  now?: () => number;
}

export interface RequestOptions {
  /** Skip these endpoints (e.g. the one that just answered inconsistently). */
  exclude?: ReadonlySet<string>;
  /** Pin to one endpoint (used by probes). */
  only?: string;
  blockNumber?: number;
  maxAttempts?: number;
  /** Do not record JSON-RPC-level errors (e.g. expected eth_call reverts) in rpc_errors. */
  quiet?: boolean;
}

export interface RoutedOutcome<T = unknown> {
  endpoint: string;
  outcomes: RpcOutcome<T>[];
  durationMs: number;
}

const BASE_BACKOFF_MS = 200;

/** dRPC: "Batch of more than 3 requests are not allowed". Others: "batch too large", "exceeds max batch size (N)". */
export function detectBatchLimit(message: string): number | null {
  const m = /batch(?:es)? of more than (\d+)|max(?:imum)? batch (?:size|length)[^\d]{0,20}(\d+)|batch (?:size )?limit[^\d]{0,20}(\d+)/i.exec(message);
  if (m) return Number(m[1] ?? m[2] ?? m[3]);
  if (/batch (?:too large|limit exceeded|not allowed)/i.test(message)) return 1;
  return null;
}
const MAX_BACKOFF_MS = 5_000;
const MAX_COOLDOWN_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Multi-endpoint JSON-RPC router with failover, per-endpoint cooldown and head-lag awareness.
 * Deterministic preference order (config priority) unless an endpoint is failing or lagging.
 */
export class RpcPool {
  readonly endpoints: EndpointState[];
  private readonly now: () => number;

  constructor(urls: readonly string[], private readonly opts: PoolOptions) {
    this.now = opts.now ?? Date.now;
    this.endpoints = urls.map((url, i) => ({
      url,
      name: redactUrl(url),
      priority: i,
      consecutiveFailures: 0,
      cooldownUntil: 0,
      latencyEwmaMs: 0,
      lastHead: null,
      lastHeadAt: null,
      totalCalls: 0,
      totalFailures: 0,
      disabledReason: null,
      maxBatch: Number.MAX_SAFE_INTEGER,
    }));
  }

  get bestKnownHead(): number | null {
    let best: number | null = null;
    for (const e of this.endpoints) if (e.lastHead !== null && (best === null || e.lastHead > best)) best = e.lastHead;
    return best;
  }

  disable(url: string, reason: string): void {
    const e = this.endpoints.find((x) => x.url === url);
    if (e) {
      e.disabledReason = reason;
      this.opts.log.warn({ endpoint: e.name, reason }, "rpc endpoint disabled");
    }
  }

  recordHead(url: string, head: number): void {
    const e = this.endpoints.find((x) => x.url === url);
    if (!e) return;
    e.lastHead = head;
    e.lastHeadAt = this.now();
  }

  /** Ordered candidate list for the next attempt. */
  candidates(exclude?: ReadonlySet<string>, batchSize = 1): EndpointState[] {
    const t = this.now();
    const best = this.bestKnownHead;
    const usable = this.endpoints.filter((e) => !e.disabledReason && !(exclude?.has(e.url)));
    const score = (e: EndpointState): number => {
      let s = e.priority;
      if (e.cooldownUntil > t) s += 1000; // in cooldown: last resort
      if (best !== null && e.lastHead !== null && best - e.lastHead > this.opts.lagTolerance) s += 100; // lagging
      if (e.maxBatch < batchSize) s += 50; // would need chunking: prefer endpoints that take the batch whole
      return s;
    };
    return usable.sort((a, b) => score(a) - score(b));
  }

  healthy(): boolean {
    const t = this.now();
    return this.endpoints.some((e) => !e.disabledReason && e.cooldownUntil <= t);
  }

  private onSuccess(e: EndpointState, durationMs: number): void {
    e.consecutiveFailures = 0;
    e.cooldownUntil = 0;
    e.totalCalls++;
    e.latencyEwmaMs = e.latencyEwmaMs === 0 ? durationMs : e.latencyEwmaMs * 0.8 + durationMs * 0.2;
  }

  private onFailure(e: EndpointState, method: string, code: number | null, message: string, durationMs: number, blockNumber?: number): void {
    e.consecutiveFailures++;
    e.totalCalls++;
    e.totalFailures++;
    const cooldown = Math.min(MAX_COOLDOWN_MS, BASE_BACKOFF_MS * 2 ** Math.min(e.consecutiveFailures, 8));
    e.cooldownUntil = this.now() + cooldown;
    this.opts.onError?.({ endpoint: e.name, method, code, message, durationMs, ...(blockNumber !== undefined ? { blockNumber } : {}) });
    this.opts.log.warn({ endpoint: e.name, method, code, message, cooldownMs: cooldown, failures: e.consecutiveFailures }, "rpc call failed");
  }

  /**
   * Execute a batch (or single call, as a batch of one) with failover.
   * JSON-RPC level errors that are non-retryable are returned as outcomes, not thrown.
   * Throws RpcError only when every attempt on every candidate failed.
   */
  async batch<T = unknown>(calls: readonly JsonRpcCall[], ro: RequestOptions = {}): Promise<RoutedOutcome<T>> {
    const maxAttempts = ro.maxAttempts ?? this.opts.maxAttempts ?? 6;
    const method = calls[0]?.method ?? "batch";
    const tried = new Set<string>();
    let attempt = 0;
    let lastErr: RpcError | null = null;
    while (attempt < maxAttempts) {
      const cands = ro.only ? this.endpoints.filter((e) => e.url === ro.only && !e.disabledReason) : this.candidates(ro.exclude, calls.length);
      if (cands.length === 0) throw new RpcError("no usable rpc endpoints", "pool", method, null, false);
      // Within one request, prefer an endpoint we have not tried yet (fail over first, back off second).
      let fresh = cands.filter((e) => !tried.has(e.url));
      if (fresh.length === 0) {
        tried.clear();
        fresh = cands;
        await sleep(Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt) * (0.5 + Math.random()));
      }
      const e = fresh[0]!; // best-scored: healthy first, then lagging, then cooling down
      const t = this.now();
      if (e.cooldownUntil > t) await sleep(Math.min(e.cooldownUntil - t, MAX_BACKOFF_MS));
      const started = this.now();
      try {
        const outcomes = await this.execute<T>(e, calls);
        const durationMs = this.now() - started;
        // A batch where *every* item is a retryable error = endpoint problem, not request problem.
        const retryableErrs = outcomes.filter((o) => !o.ok && isRetryableRpcCode(o.error.code));
        if (retryableErrs.length > 0 && retryableErrs.length === outcomes.length) {
          const first = retryableErrs[0] as { ok: false; error: { code: number; message: string } };
          this.onFailure(e, method, first.error.code, first.error.message, durationMs, ro.blockNumber);
          lastErr = new RpcError(first.error.message, e.url, method, first.error.code, true);
          tried.add(e.url);
          attempt++;
          continue;
        }
        this.onSuccess(e, durationMs);
        for (const o of outcomes) {
          if (!o.ok && !ro.quiet) this.opts.onError?.({ endpoint: e.name, method, code: o.error.code, message: o.error.message, durationMs, ...(ro.blockNumber !== undefined ? { blockNumber: ro.blockNumber } : {}) });
        }
        return { endpoint: e.url, outcomes, durationMs };
      } catch (err) {
        const durationMs = this.now() - started;
        const re = err instanceof RpcError ? err : new RpcError(String(err), e.url, method, null, true);
        const limit = detectBatchLimit(re.message);
        if (limit !== null && calls.length > 1) {
          // Learn the limit and retry immediately (this endpoint with chunking, or a roomier one).
          e.maxBatch = Math.min(e.maxBatch, Math.max(1, limit));
          this.opts.log.warn({ endpoint: e.name, maxBatch: e.maxBatch }, "endpoint batch limit learned");
          attempt++;
          continue;
        }
        this.onFailure(e, re.method, re.code, re.message, durationMs, ro.blockNumber);
        lastErr = re;
        if (!re.retryable) throw re;
        tried.add(e.url);
        attempt++;
      }
    }
    throw lastErr ?? new RpcError("exhausted attempts", "pool", method, null, true);
  }

  /** Runs the calls on one endpoint, chunking sequentially if the endpoint's batch limit is smaller. */
  private async execute<T>(e: EndpointState, calls: readonly JsonRpcCall[]): Promise<RpcOutcome<T>[]> {
    const to = { timeoutMs: this.opts.timeoutMs };
    if (calls.length === 1) return [await rpcCall<T>(e.url, calls[0]!, to)];
    if (calls.length <= e.maxBatch) return (await rpcBatch(e.url, calls, to)) as RpcOutcome<T>[];
    const out: RpcOutcome<T>[] = [];
    for (let i = 0; i < calls.length; i += e.maxBatch) {
      const chunk = calls.slice(i, i + e.maxBatch);
      out.push(...((chunk.length === 1 ? [await rpcCall<T>(e.url, chunk[0]!, to)] : await rpcBatch(e.url, chunk, to)) as RpcOutcome<T>[]));
    }
    return out;
  }

  async call<T = unknown>(method: string, params: unknown[], ro: RequestOptions = {}): Promise<{ endpoint: string; outcome: RpcOutcome<T>; durationMs: number }> {
    const r = await this.batch<T>([{ method, params }], ro);
    return { endpoint: r.endpoint, outcome: r.outcomes[0]!, durationMs: r.durationMs };
  }

  /** Like call() but unwraps the result and throws on JSON-RPC error. */
  async callResult<T = unknown>(method: string, params: unknown[], ro: RequestOptions = {}): Promise<T> {
    const r = await this.call<T>(method, params, ro);
    if (!r.outcome.ok) throw new RpcError(r.outcome.error.message, r.endpoint, method, r.outcome.error.code, false, r.outcome.error.data);
    return r.outcome.result;
  }

  snapshot(): Array<Omit<EndpointState, "url"> & { inCooldown: boolean }> {
    const t = this.now();
    return this.endpoints.map(({ url: _url, ...rest }) => ({ ...rest, inCooldown: rest.cooldownUntil > t }));
  }
}
