import { ApiUnavailable, ago, fmtInt, getJson, short } from "./api.js";
import { initChrome } from "./menu.js";

initChrome();

interface Lane {
  note: string;
  solana: { payTo: string | null; usdcWaiting: string | null; balanceAt: number | null };
  payments: { count: number; volumeUsdc: string; payers: number; first: number | null; last: number | null };
  arc: { payTo: string | null; movedUsdc: string; moves: number; lastMove: number | null; floatUsdc: string | null };
  route: { provider: string; status: "open" | "closed" | "unknown"; checkedAt: number; quote: { amountOut: string; feeUsdc: string; etaSeconds: number } | null; detail: string | null; requestId: string | null } | null;
  recent: Array<{ at: number; payer: string | null; amountUsdc: string; tx: string | null; route: string | null }>;
}

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string | null | undefined) => (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const usd = (s: string | null) => (s === null ? "—" : `$${Number(s).toFixed(Number(s) < 1 ? 4 : 2)}`);
let offline = false;

async function refresh(): Promise<void> {
  try {
    const d = await getJson<Lane>("/v1/lane");
    const dot = document.getElementById("netdot");
    if (dot) dot.className = "dot ok";
    $("l-count").textContent = fmtInt(d.payments.count);
    $("l-vol").textContent = usd(d.payments.volumeUsdc);
    $("l-payers").textContent = fmtInt(d.payments.payers);
    const r = d.route;
    $("l-route").innerHTML = !r ? "—" : r.status === "open" ? '<span class="status"><span class="dot ok"></span>open</span>' : r.status === "closed" ? '<span class="status"><span class="dot warn"></span>no solver yet</span>' : '<span class="status"><span class="dot bad"></span>not answering</span>';
    $("l-route-note").innerHTML = !r
      ? "not configured"
      : r.status === "open" && r.quote
        ? `Eco quotes 1 USDC → ${esc(r.quote.amountOut)}, fee $${esc(r.quote.feeUsdc)}, about ${r.quote.etaSeconds} s<br>checked ${ago(r.checkedAt)}`
        : `Eco Routes, asked for a real Solana → Arc quote<br>“${esc(r.detail ?? "")}” · checked ${ago(r.checkedAt)}`;
    $("l-waiting").textContent = usd(d.solana.usdcWaiting);
    $("l-waiting-note").textContent = d.solana.payTo ? `${short(d.solana.payTo, 4)} on Solana${d.solana.balanceAt ? `, read ${ago(d.solana.balanceAt)}` : ""}` : "no Solana address configured";
    $("l-moved").textContent = usd(d.arc.movedUsdc);
    $("l-moved-note").textContent = d.arc.moves ? `${d.arc.moves} moves, last ${ago(d.arc.lastMove!)}` : "nothing yet: the road is not open";
    $("l-float").textContent = d.arc.floatUsdc === null ? "$0" : usd(d.arc.floatUsdc);
    $("l-last").textContent = d.payments.last ? ago(d.payments.last) : "—";
    $("l-last-note").textContent = d.payments.first ? `first one ${ago(d.payments.first)}` : "";
    $("lane-table").innerHTML = d.recent.length
      ? `<table class="data"><thead><tr><th>When</th><th class="num">Amount</th><th>Payer</th><th>Bought</th><th>Transaction</th></tr></thead><tbody>${d.recent
          .map((p) => `<tr><td>${ago(p.at)}</td><td class="num">$${esc(p.amountUsdc)}</td><td class="mono">${esc(p.payer ? short(p.payer, 4) : "—")}</td><td class="mono">${esc(p.route?.replace(/^\/v1\/(paid|direct)/, "") ?? "—")}</td><td class="mono">${p.tx ? `<a href="https://solscan.io/tx/${esc(p.tx)}" rel="noopener">${esc(short(p.tx, 6))}</a>` : "—"}</td></tr>`)
          .join("")}</tbody></table>`
      : '<div class="empty">No payment from Solana yet.</div>';
    $("lane-note").textContent = `${fmtInt(d.payments.count)} payments`;
  } catch (err) {
    if (err instanceof ApiUnavailable && !offline) {
      offline = true;
      document.querySelector(".tiles")?.classList.add("hidden");
      document.querySelector(".charts")?.classList.add("hidden");
      $("offline").classList.remove("hidden");
    }
  }
}

void refresh();
setInterval(() => { if (!offline) void refresh(); }, 30_000);
