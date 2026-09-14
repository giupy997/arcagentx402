import { ago, fmtGwei, fmtInt, fmtSec, fmtUsdc, getJson, setNetPill, type Fees, type Network } from "./api.js";

const $ = (id: string) => document.getElementById(id)!;

async function refresh(): Promise<void> {
  try {
    const [n, f] = await Promise.all([getJson<Network>("/v1/network"), getJson<Fees>("/v1/fees?window=60")]);
    setNetPill(n);
    $("s-head").textContent = fmtInt(n.chainHead ?? n.head?.number ?? null);
    $("s-head-sub").textContent = n.lagBlocks !== null && n.lagBlocks > 20 ? `collector ${fmtInt(n.lagBlocks)} blocks behind` : `${n.blockTimeSeconds ?? "—"} s blocks`;
    $("s-fee").textContent = fmtGwei(f.current?.baseFeeGwei);
    $("s-fee-sub").textContent = f.current?.nextBaseFeeGwei !== null && f.current?.nextBaseFeeGwei !== undefined ? `next block ${fmtGwei(f.current.nextBaseFeeGwei)}` : "";
    $("s-cost").textContent = fmtUsdc(f.costNow?.erc20TransferUsdc);
    $("s-fin").textContent = fmtSec(n.finality.p50Seconds, 1);
    $("s-deploys").textContent = fmtInt(n.totals.deploys);
  } catch {
    setNetPill(null, true);
  }
}
void refresh();
setInterval(() => void refresh(), 10_000);
