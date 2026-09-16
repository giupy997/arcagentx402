import { ApiUnavailable, fmtInt, getJson, short, timeHM, ago } from "./api.js";
import { columnChart, tableTwin } from "./charts.js";
import { initChrome } from "./menu.js";

initChrome();

interface TokenEvent { kind: "burn" | "payout"; blockNumber: number; timestamp: number; txHash: string | null; from: string | null; to: string | null; amount: string; amountFormatted: string }
interface Token {
  token: { address: string; distributor: string; symbol: string; decimals: number } | null;
  burned: { totalFormatted: string; supplyShare: number | null; events: number; last24hFormatted: string; lastAt: number | null };
  payouts: { totalUsdc: string; last24hUsdc: string; events: number; recipients: number; lastAt: number | null };
  perHour: Array<{ t: number; burned: string; burnedFormatted: string; payoutUsdc: string }>;
  recent: TokenEvent[];
}

const $ = (id: string) => document.getElementById(id)!;
const viz = (card: string) => document.querySelector<HTMLElement>(`#${card} .viz`)!;
const esc = (s: string | null | undefined) => (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const EXPLORER = "https://explorer.arc.io";
let offline = false;

function showOffline(): void {
  if (offline) return;
  offline = true;
  document.querySelector(".tiles")?.classList.add("hidden");
  document.querySelector(".charts")?.classList.add("hidden");
  $("offline").classList.remove("hidden");
}

async function refresh(): Promise<void> {
  try {
    const d = await getJson<Token>("/v1/token");
    const dot = document.getElementById("netdot");
    if (dot) dot.className = "dot ok";
    if (!d.token) {
      $("token-note").textContent = "token watcher not configured";
      return;
    }
    $("t-burned").textContent = `${d.burned.totalFormatted} CRA`;
    $("t-burned-pct").textContent = d.burned.supplyShare === null ? "—" : `${d.burned.supplyShare.toFixed(2)}%`;
    $("t-burn-last").textContent = d.burned.lastAt ? ago(d.burned.lastAt) : "—";
    $("t-burn-24").textContent = `${d.burned.last24hFormatted} CRA`;
    $("t-burn-n").textContent = `${fmtInt(d.burned.events)} burns recorded`;
    $("t-pay").textContent = `$${d.payouts.totalUsdc}`;
    $("t-pay-n").textContent = `${fmtInt(d.payouts.events)} payouts recorded`;
    $("t-pay-24").textContent = `$${d.payouts.last24hUsdc}`;
    $("t-pay-last").textContent = d.payouts.lastAt ? `last ${ago(d.payouts.lastAt)}` : "";
    $("t-recipients").textContent = fmtInt(d.payouts.recipients);

    const burnCols = d.perHour.map((p) => ({ x: p.t, value: Number(p.burned) / 1e18, label: timeHM(p.t) }));
    columnChart(viz("c-burn"), { columns: burnCols, format: (v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v))), xFormat: (v) => timeHM(v) });
    tableTwin($("c-burn"), ["Hour", "CRA burned"], d.perHour.map((p) => [timeHM(p.t), p.burnedFormatted]), [1]);

    const payCols = d.perHour.map((p) => ({ x: p.t, value: Number(p.payoutUsdc), label: timeHM(p.t) }));
    columnChart(viz("c-pay"), { columns: payCols, format: (v) => `$${v < 10 ? v.toFixed(2) : Math.round(v)}`, xFormat: (v) => timeHM(v), color: "var(--series-3)" });
    tableTwin($("c-pay"), ["Hour", "USDC paid out"], d.perHour.map((p) => [timeHM(p.t), `$${p.payoutUsdc}`]), [1]);

    $("events-table").innerHTML = d.recent.length
      ? `<table class="data"><thead><tr><th>When</th><th>Event</th><th class="num">Amount</th><th>To</th><th>Transaction</th></tr></thead><tbody>${d.recent
          .map(
            (e) =>
              `<tr><td>${ago(e.timestamp)}</td><td>${e.kind === "burn" ? '<span class="tag">burn</span>' : '<span class="tag">payout</span>'}</td><td class="num">${
                e.kind === "burn" ? `${e.amountFormatted} CRA` : `$${e.amountFormatted}`
              }</td><td class="mono">${esc(short(e.to))}</td><td class="mono"><a href="${EXPLORER}/tx/${esc(e.txHash)}" rel="noopener">${esc(short(e.txHash, 8))}</a></td></tr>`,
          )
          .join("")}</tbody></table>`
      : '<div class="empty">No events recorded yet.</div>';
    $("token-note").textContent = `${fmtInt(d.burned.events + d.payouts.events)} events recorded`;
  } catch (err) {
    if (err instanceof ApiUnavailable) showOffline();
  }
}

void refresh();
setInterval(() => { if (!offline) void refresh(); }, 15_000);
