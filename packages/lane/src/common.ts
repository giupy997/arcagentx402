/** What every road to Arc shares: the destination, and the refusal a quote that says otherwise gets. */
export const ARC_CHAIN_ID = 5042;
export const USDC_ARC = "0x3600000000000000000000000000000000000000";
/** Arc's domain in Circle's CCTP. */
export const ARC_CCTP_DOMAIN = 26;
export const ECO_QUOTES = "https://api.eco.com/v1/quotes";

/** A quote or a wallet that does not match what was asked: nothing was signed. */
export class SweepRefused extends Error {
  override readonly name = "SweepRefused";
}

export const no = (reason: string): never => {
  throw new SweepRefused(reason);
};

/** USDC held by `owner` on Arc, in micro-USDC, read from the chain. */
export async function usdcOnArc(arcRpc: string, owner: string, fetchImpl: typeof fetch = fetch): Promise<bigint> {
  const res = await fetchImpl(arcRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC_ARC, data: `0x70a08231${owner.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"] }), signal: AbortSignal.timeout(15_000) });
  const d = (await res.json()) as { result?: string };
  return BigInt(d.result && d.result !== "0x" ? d.result : "0x0");
}

/** Waits until `owner`'s USDC on Arc has grown by at least `atLeast` over `before`, or the deadline passes. */
export async function arrivalOnArc(read: () => Promise<bigint>, before: bigint, atLeast: bigint, deadline: number): Promise<{ arrived: boolean; grew: bigint }> {
  let after = before;
  while (Date.now() < deadline) {
    after = await read().catch(() => after);
    if (after - before >= atLeast) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { arrived: after - before >= atLeast, grew: after - before };
}
