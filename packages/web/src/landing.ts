import { fmtGwei, fmtSec, fmtUsdc, getJson, type Fees, type Network } from "./api.js";

const set = (id: string, v: string) => { const e = document.getElementById(id); if (e) e.textContent = v; };

async function refresh(): Promise<void> {
  try {
    const [n, f] = await Promise.all([getJson<Network>("/v1/network"), getJson<Fees>("/v1/fees?window=60")]);
    const dot = document.getElementById("netdot");
    if (dot) dot.className = `dot ${(n.collector.lastBlockAgeSeconds ?? 9999) < 60 ? "ok" : "warn"}`;
    set("netlabel", `Arc ${n.network} live · x402 · USDC`);
    set("s-fee", fmtGwei(f.current?.baseFeeGwei));
    set("s-fee-next", fmtGwei(f.current?.nextBaseFeeGwei));
    set("s-transfer", fmtUsdc(f.costNow?.erc20TransferUsdc));
    if (n.finality.p50Seconds !== null) set("s-fin", fmtSec(n.finality.p50Seconds, 1));
  } catch {
    /* landing stays static if the API is down */
  }
}
void refresh();
setInterval(() => void refresh(), 15_000);
