/**
 * Solana Lane: what came in on Solana, what is waiting there, what moved on to Arc, and whether the road
 * to Arc is open.
 *
 * Everything shown is measured, not planned. The road is Eco Routes, asked for a real quote every hour
 * with our own addresses. A move is a deposit into Eco's Portal on Solana signed by our wallet (the sell
 * command's `sweep`), read back from Solana: a solver burns it through Circle's CCTP and it is minted on
 * Arc to our seller address. The balances shown are read from the chains.
 */
import type { Hono } from "hono";
import type { Logger } from "pino";
import type { Db } from "./db.js";

const SOLANA_RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_ARC = "0x3600000000000000000000000000000000000000";
const ECO_QUOTES = "https://api.eco.com/v1/quotes";
const SOLANA_CHAIN_ID = 1399811149;
const ARC_CHAIN_ID = 5042;
/** Eco's Portal program on Solana. */
export const ECO_PORTAL = "EcooswwC1NggsckZyF5SeAL9WsgJs3UhPbrqY1apV73F";

export interface LaneMove {
  readonly signature: string;
  readonly at: number;
  readonly amountUsdc6: bigint;
}

type ParsedTx = {
  blockTime?: number | null;
  meta?: { err: unknown; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null;
  transaction?: { signatures?: string[]; message?: { instructions?: Array<{ programId?: string }> } };
} | null;
type TokenBalance = { mint: string; owner?: string; uiTokenAmount: { amount: string } };

/** A deposit of `owner`'s USDC into Eco's Portal, from a transaction as getTransaction (jsonParsed) returns it. */
export function moveFrom(tx: ParsedTx, owner: string): LaneMove | null {
  if (!tx?.meta || tx.meta.err !== null) return null;
  if (!(tx.transaction?.message?.instructions ?? []).some((i) => i.programId === ECO_PORTAL)) return null;
  const held = (list: TokenBalance[] | undefined) => (list ?? []).filter((b) => b.mint === USDC_SOLANA && b.owner === owner).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
  const out = held(tx.meta.preTokenBalances) - held(tx.meta.postTokenBalances);
  const signature = tx.transaction?.signatures?.[0];
  return out > 0n && signature ? { signature, at: tx.blockTime ?? 0, amountUsdc6: out } : null;
}

async function solanaCall<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(SOLANA_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
  const d = (await res.json()) as { result?: T; error?: { message?: string } };
  if (d.error || d.result === undefined) throw new Error(d.error?.message ?? `${method}: no result`);
  return d.result;
}

/** Our wallet's deposits into Eco's Portal. Transactions already read are not read again: each signature once. */
function laneMoves(owner: string) {
  const seen = new Map<string, LaneMove | null>();
  return async (): Promise<LaneMove[]> => {
    const sigs = await solanaCall<Array<{ signature: string; err: unknown }>>("getSignaturesForAddress", [owner, { limit: 100 }]);
    for (const s of sigs) {
      if (seen.has(s.signature)) continue;
      if (s.err !== null) {
        seen.set(s.signature, null);
        continue;
      }
      const tx = await solanaCall<ParsedTx>("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]).catch(() => undefined);
      if (tx !== undefined) seen.set(s.signature, moveFrom(tx, owner));
    }
    return [...seen.values()].filter((m): m is LaneMove => m !== null).sort((a, b) => b.at - a.at);
  };
}

interface RouteCheck {
  provider: "eco";
  /** open: a solver quoted the pair. closed: every solver refused. unknown: Eco did not answer. */
  status: "open" | "closed" | "unknown";
  checkedAt: number;
  /** For 1 USDC: what would arrive, the fee, and how long Eco expects it to take. */
  quote: { amountOut: string; feeUsdc: string; etaSeconds: number } | null;
  detail: string | null;
  requestId: string | null;
}

async function checkRoute(solanaFrom: string, arcTo: string): Promise<RouteCheck> {
  const at = Math.floor(Date.now() / 1000);
  try {
    const res = await fetch(ECO_QUOTES, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "exact-in", source: { chainId: SOLANA_CHAIN_ID, token: USDC_SOLANA, amount: "1000000", funder: solanaFrom }, destination: { chainId: ARC_CHAIN_ID, token: USDC_ARC, recipient: arcTo }, refundRecipient: solanaFrom, dappId: "cra-agent" }),
      signal: AbortSignal.timeout(20_000),
    });
    const d = (await res.json()) as { id?: string; destination?: { amountOut?: string }; fees?: Array<{ amount?: string }>; steps?: Array<{ estimatedDurationSec?: number }>; title?: string; detail?: string; requestId?: string };
    if (d.id && d.destination?.amountOut) {
      const fee = (d.fees ?? []).reduce((s, f) => s + Number(f.amount ?? 0), 0);
      return { provider: "eco", status: "open", checkedAt: at, quote: { amountOut: (Number(d.destination.amountOut) / 1e6).toFixed(6), feeUsdc: (fee / 1e6).toFixed(6), etaSeconds: (d.steps ?? []).reduce((s, x) => s + (x.estimatedDurationSec ?? 0), 0) }, detail: null, requestId: d.id };
    }
    return { provider: "eco", status: "closed", checkedAt: at, quote: null, detail: d.detail ?? d.title ?? `HTTP ${res.status}`, requestId: d.requestId ?? null };
  } catch (err) {
    return { provider: "eco", status: "unknown", checkedAt: at, quote: null, detail: (err as Error).message.slice(0, 120), requestId: null };
  }
}

async function solanaUsdcBalance(owner: string): Promise<string | null> {
  try {
    const res = await fetch(SOLANA_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [owner, { mint: USDC_SOLANA }, { encoding: "jsonParsed" }] }), signal: AbortSignal.timeout(8000) });
    const d = (await res.json()) as { result?: { value?: Array<{ account: { data: { parsed: { info: { tokenAmount: { uiAmountString: string } } } } } }> } };
    const v = d.result?.value ?? [];
    return v.length ? v.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.uiAmountString), 0).toFixed(6) : "0";
  } catch {
    return null;
  }
}

export function mountLane(app: Hono, db: Db, log: Logger): void {
  const solanaPayTo = process.env.SOLANA_SELLER_ADDRESS ?? null;
  const arcPayTo = process.env.SELLER_ADDRESS ?? null;
  let route: RouteCheck | null = null;
  let balance: { at: number; value: string | null } | null = null;
  const readMoves = solanaPayTo ? laneMoves(solanaPayTo) : null;
  let moves: { at: number; list: LaneMove[] } | null = null;

  app.get("/v1/lane", async (c) => {
    const now = Date.now();
    if (solanaPayTo && arcPayTo && (!route || now / 1000 - route.checkedAt > 3600)) {
      route = await checkRoute(solanaPayTo, arcPayTo);
      log.info({ status: route.status, requestId: route.requestId }, "solana lane: route checked");
    }
    if (solanaPayTo && (!balance || now - balance.at > 60_000)) balance = { at: now, value: await solanaUsdcBalance(solanaPayTo) };
    if (readMoves && (!moves || now - moves.at > 300_000)) moves = { at: now, list: await readMoves().catch((err: unknown) => (log.warn({ err: (err as Error).message }, "solana lane: moves not read"), moves?.list ?? [])) };
    const moved = moves?.list ?? [];
    const exists = await db.query<{ t: string | null }>("SELECT to_regclass('public.settlements')::text AS t");
    const [agg, recent] = exists.rows[0]?.t
      ? await Promise.all([
          db.query<{ n: string; vol: string; payers: string; first: string | null; last: string | null }>(
            "SELECT count(*) AS n, coalesce(sum(amount_usdc6), 0) AS vol, count(DISTINCT payer) AS payers, extract(epoch FROM min(at))::bigint AS first, extract(epoch FROM max(at))::bigint AS last FROM settlements WHERE rail = 'solana' AND outcome = 'settled'",
          ),
          db.query<{ at: string; payer: string | null; amount_usdc6: string; tx: string | null; route: string | null }>("SELECT extract(epoch FROM at)::bigint AS at, payer, amount_usdc6, tx, route FROM settlements WHERE rail = 'solana' AND outcome = 'settled' ORDER BY at DESC LIMIT 50"),
        ])
      : [{ rows: [{ n: "0", vol: "0", payers: "0", first: null, last: null }] }, { rows: [] }];
    const a = agg.rows[0]!;
    return c.json({
      note: "Both halves of the lane are live. Buyers pay on Solana and sellers are paid there; what a seller earned moves on to its wallet on Arc through Eco Routes, a solver burning the USDC with Circle's CCTP so it is minted on Arc. The sell command does it in one step, checking Eco's quote before it signs: npx @cra-agent/seller sweep. Moves shown are our own wallet's deposits into Eco's Portal, read from Solana.",
      solana: { payTo: solanaPayTo, usdcWaiting: balance?.value ?? null, balanceAt: balance ? Math.floor(balance.at / 1000) : null },
      payments: { count: Number(a.n), volumeUsdc: (Number(a.vol) / 1e6).toFixed(6), payers: Number(a.payers), first: a.first ? Number(a.first) : null, last: a.last ? Number(a.last) : null },
      arc: {
        payTo: arcPayTo,
        movedUsdc: (Number(moved.reduce((t, m) => t + m.amountUsdc6, 0n)) / 1e6).toFixed(6),
        moves: moved.length,
        lastMove: moved[0]?.at ?? null,
        floatUsdc: null,
        recentMoves: moved.slice(0, 20).map((m) => ({ at: m.at, amountUsdc: (Number(m.amountUsdc6) / 1e6).toFixed(6), solanaTx: m.signature })),
      },
      route,
      recent: recent.rows.map((r) => ({ at: Number(r.at), payer: r.payer, amountUsdc: (Number(r.amount_usdc6) / 1e6).toFixed(6), tx: r.tx, route: r.route })),
    });
  });
}
