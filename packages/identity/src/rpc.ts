/**
 * Choosing an RPC endpoint that is actually answering.
 *
 * The public Arc endpoints drop connections and rate-limit without warning. A rail that leans on
 * one of them fails a deposit or a payment for reasons that have nothing to do with the payment.
 * Several pieces downstream take a single URL (Circle's Gateway client among them), so instead of
 * a fallback transport we ask every candidate once and hand back one healthy URL.
 *
 * The list is in priority order: an operator who lists their own node first gets their own node
 * whenever it answers, not whichever public endpoint happened to be a few milliseconds faster.
 */
import type { ArcNetwork } from "./index.js";

/**
 * Public endpoints, in the order our own collector found them reliable over 24 hours to 2026-09-20,
 * 8,197 liveness probes each: blockdaemon failed none and dropped no call, quicknode failed 5 probes
 * and 8 calls, drpc 357 and 1,053, rpc.mainnet.arc.io 9 probes and 9,118 calls, almost all of them
 * rate limits. The last figure is not normalised: it was first in our list, so it took most of our
 * traffic. What holds either way is that it passed 99.9% of its probes while refusing calls, so a
 * probe cannot tell these apart and the order has to carry what the probe cannot see.
 */
export const PUBLIC_RPCS: Record<ArcNetwork, readonly string[]> = {
  arc: [
    "https://rpc.blockdaemon.mainnet.arc.io",
    "https://rpc.quicknode.mainnet.arc.io",
    "https://rpc.drpc.mainnet.arc.io",
    "https://rpc.mainnet.arc.io",
  ],
  arcTestnet: [
    "https://rpc.testnet.arc.io",
    "https://rpc.drpc.testnet.arc.io",
    "https://rpc.quicknode.testnet.arc.io",
    "https://rpc.blockdaemon.testnet.arc.io",
  ],
};

export const CHAIN_IDS: Record<ArcNetwork, number> = { arc: 5042, arcTestnet: 5042002 };

export interface PickRpcOptions {
  /** Per-probe timeout. */
  readonly timeoutMs?: number;
  /** Once a lower-priority endpoint has answered, how long a higher-priority one still gets. */
  readonly graceMs?: number;
  /** Extra rounds when nothing answered: a rate limit often clears in a moment. */
  readonly retries?: number;
  readonly retryDelayMs?: number;
  /** An endpoint this many blocks behind the best one seen is treated as not answering. */
  readonly maxLagBlocks?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/** "a, b ,c" from the environment, or nothing. */
export function parseRpcList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Configured endpoints first, then the rest, each once. */
export function mergeRpcLists(preferred: readonly string[], fallback: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of [...preferred, ...fallback]) {
    const key = url.replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

/** Provider keys live in the path or the query of an RPC URL. Errors and logs get the host only. */
export function redactRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" && u.search === "" ? u.origin : `${u.origin}/…`;
  } catch {
    return "(unparseable url)";
  }
}

type Probe = { ok: true; head: number } | { ok: false; reason: string };

async function rpc(url: string, method: string, timeoutMs: number, doFetch: typeof globalThis.fetch, cancel: AbortSignal): Promise<string> {
  const res = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    signal: AbortSignal.any([cancel, AbortSignal.timeout(timeoutMs)]),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (!body.result) throw new Error((body.error?.message ?? "no result").slice(0, 80).replace(/[^\x20-\x7e]/g, "?"));
  return body.result;
}

/** Two calls, not one: the right chain, and a head that is moving with everyone else's. */
async function probe(url: string, expectedChainId: number, timeoutMs: number, doFetch: typeof globalThis.fetch, cancel: AbortSignal): Promise<Probe> {
  try {
    const chainId = await rpc(url, "eth_chainId", timeoutMs, doFetch, cancel);
    // An endpoint for the wrong chain is worse than a dead one: it answers, and every answer is wrong.
    if (Number.parseInt(chainId, 16) !== expectedChainId) return { ok: false, reason: `chain id ${chainId}, expected ${expectedChainId}` };
    const head = Number.parseInt(await rpc(url, "eth_blockNumber", timeoutMs, doFetch, cancel), 16);
    if (!Number.isFinite(head)) return { ok: false, reason: "no block number" };
    return { ok: true, head };
  } catch (err) {
    return { ok: false, reason: (err as Error).name === "TimeoutError" ? "timed out" : ((err as Error).message || "failed").slice(0, 80) };
  }
}

async function round(candidates: readonly string[], expectedChainId: number, timeoutMs: number, graceMs: number, maxLagBlocks: number, doFetch: typeof globalThis.fetch): Promise<{ url: string } | { reasons: string[] }> {
  const cancel = new AbortController();
  const state: Array<Probe | null> = candidates.map(() => null);
  try {
    return await new Promise((resolve) => {
      let grace: ReturnType<typeof setTimeout> | null = null;
      // Healthy means answering AND keeping up: a stalled node answers every probe and is still wrong.
      const healthy = (): boolean[] => {
        const top = Math.max(-1, ...state.map((s) => (s?.ok ? s.head : -1)));
        return state.map((s) => s?.ok === true && s.head >= top - maxLagBlocks);
      };
      const decide = (final: boolean): void => {
        const ok = healthy();
        const best = ok.indexOf(true);
        const allSettled = state.every((s) => s !== null);
        if (best >= 0) {
          // Take it at once when everything ahead of it is out, and there is a second head to compare
          // with (one answer alone cannot show that it is stalled). Otherwise wait out the grace.
          const aheadAllOut = state.slice(0, best).every((s, i) => s !== null && !ok[i]);
          const comparable = allSettled || state.filter((s) => s?.ok).length >= 2;
          if ((aheadAllOut && comparable) || final) {
            if (grace) clearTimeout(grace);
            resolve({ url: candidates[best]! });
            return;
          }
          if (!grace) grace = setTimeout(() => decide(true), graceMs);
          return;
        }
        if (allSettled) {
          if (grace) clearTimeout(grace);
          resolve({ reasons: state.map((s, i) => `${redactRpcUrl(candidates[i]!)}: ${s && !s.ok ? s.reason : "behind the chain head"}`) });
        }
      };
      candidates.forEach((url, i) => {
        void probe(url, expectedChainId, timeoutMs, doFetch, cancel.signal).then((result) => {
          state[i] = result;
          decide(false);
        });
      });
    });
  } finally {
    cancel.abort(); // the losers must not keep the process alive until their own timeout
  }
}

/**
 * The highest-priority candidate that answers with the right chain id. All are asked at once, so a
 * dead first endpoint costs a short grace period rather than its full timeout.
 */
export async function pickRpcUrl(candidates: readonly string[], expectedChainId: number, opts: PickRpcOptions = {}): Promise<string> {
  if (candidates.length === 0) throw new Error("no RPC endpoint to try");
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 4000;
  const graceMs = opts.graceMs ?? 400;
  const retries = opts.retries ?? 1;
  let reasons: string[] = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 600));
    const result = await round(candidates, expectedChainId, timeoutMs, graceMs, opts.maxLagBlocks ?? 120, doFetch);
    if ("url" in result) return result.url;
    reasons = result.reasons;
  }
  throw new Error(`no RPC endpoint answered for chain ${expectedChainId}: ${reasons.join("; ")}`);
}
