import { ApiUnavailable, ago, fmtCompact, fmtGwei, fmtInt, fmtPct, fmtSec, fmtUsdc, getJson, setNetPill, short, timeHM, type Activity, type Deploys, type Fees, type Network, type Rpc } from "./api.js";
import { barChart, columnChart, lineChart, tableTwin } from "./charts.js";
import { initChrome } from "./menu.js";

initChrome();

const $ = (id: string) => document.getElementById(id)!;
const viz = (cardId: string) => document.querySelector<HTMLElement>(`#${cardId} .viz`)!;
let windowMinutes = 60;
let inFlight = false;

const OP_LABEL: Record<string, string> = { native_transfer: "Native transfer", erc20_transfer: "ERC-20 transfer", contract_call: "Contract call", deploy: "Contract deploy" };
const esc = (s: string | null | undefined) => (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

function markStale(): void {
  document.querySelectorAll<HTMLElement>(".viz").forEach((v) => v.classList.add("stale"));
}

async function refresh(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  markStale();
  try {
    const [n, f, a, d, r] = await Promise.all([
      getJson<Network>("/v1/network"),
      getJson<Fees>(`/v1/fees?window=${windowMinutes}`),
      getJson<Activity>(`/v1/activity?window=${windowMinutes}`),
      getJson<Deploys>("/v1/deploys?limit=25"),
      getJson<Rpc>("/v1/rpc"),
    ]);
    setNetPill(n);
    renderTiles(n, f, a);
    renderFee(f);
    renderUtil(f);
    renderTpm(a);
    renderOps(f);
    renderRpc(r, n);
    renderDeploys(d);
    renderEmitters(a);
    renderSelectors(a);
    $("meta").textContent = `updated ${new Date().toLocaleTimeString()} · ${fmtInt(n.totals.blocks)} blocks · ${fmtCompact(n.totals.transactions)} transactions collected`;
    $("collector-note").textContent = n.collector.gapsOpen > 0 ? `${n.collector.gapsOpen} gap(s) being backfilled` : "no gaps";
  } catch (err) {
    if (err instanceof ApiUnavailable) {
      showOffline();
      return;
    }
    setNetPill(null, true);
    $("meta").textContent = `error: ${(err as Error).message}`;
    document.querySelectorAll<HTMLElement>(".viz").forEach((v) => v.classList.remove("stale"));
  } finally {
    inFlight = false;
  }
}

function renderTiles(n: Network, f: Fees, a: Activity): void {
  $("t-cost").textContent = fmtUsdc(f.costNow?.erc20TransferUsdc);
  $("t-cost-native").textContent = fmtUsdc(f.costNow?.nativeTransferUsdc);
  $("t-fee-gwei").textContent = fmtGwei(f.current?.baseFeeGwei);
  $("t-fee-next").textContent = fmtGwei(f.current?.nextBaseFeeGwei);
  $("t-head").textContent = fmtInt(n.chainHead ?? n.head?.number ?? null);
  $("t-head-sub").textContent = n.lagBlocks !== null && n.lagBlocks > 20 ? `collector catching up: ${fmtInt(n.lagBlocks)} blocks behind` : n.head ? `block ${ago(n.head.timestamp)}` : "";
  $("t-bt").textContent = fmtSec(n.blockTimeSeconds, 2);
  $("t-tps").textContent = n.txPerSecond === null ? "—" : n.txPerSecond.toFixed(1);
  $("t-tps-sub").textContent = `${fmtCompact(a.txCount)} in ${labelWindow()}`;
  $("t-fin").textContent = fmtSec(n.finality.p50Seconds, 1);
  $("t-fin-sub").textContent = n.finality.samples > 0 ? `p95 ${fmtSec(n.finality.p95Seconds, 1)} · ${fmtInt(n.finality.samples)} blocks` : "no live samples yet";
  $("t-fail").textContent = fmtPct(a.failureRate);
  $("t-fail-sub").textContent = `of transactions in ${labelWindow()}`;
  $("t-deploys").textContent = fmtInt(n.totals.deploys);
  $("t-deploys-sub").textContent = "since block zero";
}

const labelWindow = () => (windowMinutes === 60 ? "the last hour" : windowMinutes === 360 ? "the last 6 hours" : "the last 24 hours");

function renderFee(f: Fees): void {
  const pts = f.series.map((p) => ({ x: p.t, y: p.baseFeeGwei, label: timeHM(p.t) }));
  lineChart(viz("c-fee"), { points: pts, yFormat: (v) => `${v < 100 ? v.toFixed(v % 1 ? 1 : 0) : Math.round(v)}`, xFormat: (v) => timeHM(v), yMin: 0, floor: { value: f.floorGwei, label: "floor 20 gwei" } });
  tableTwin($("c-fee"), ["Minute", "Base fee (gwei)", "Blocks"], f.series.map((p) => [timeHM(p.t), p.baseFeeGwei.toFixed(2), p.blocks]), [1, 2]);
}

function renderUtil(f: Fees): void {
  const pts = f.series.map((p) => ({ x: p.t, y: p.utilization * 100, label: timeHM(p.t) }));
  lineChart(viz("c-util"), { points: pts, area: true, yMin: 0, yFormat: (v) => `${v.toFixed(v < 10 ? 1 : 0)}%`, xFormat: (v) => timeHM(v), color: "var(--series-3)" });
  tableTwin($("c-util"), ["Minute", "Utilisation", "Blocks"], f.series.map((p) => [timeHM(p.t), `${(p.utilization * 100).toFixed(2)}%`, p.blocks]), [1, 2]);
}

function renderTpm(a: Activity): void {
  $("c-tpm-sub").textContent = `${fmtCompact(a.txCount)} transactions in ${labelWindow()}`;
  columnChart(viz("c-tpm"), { columns: a.txPerMinute.map((p) => ({ x: p.t, value: p.txs, label: timeHM(p.t) })), format: (v) => fmtCompact(v), xFormat: (v) => timeHM(v) });
  tableTwin($("c-tpm"), ["Minute", "Transactions", "Blocks"], a.txPerMinute.map((p) => [timeHM(p.t), p.txs, p.blocks]), [1, 2]);
}

function renderOps(f: Fees): void {
  const rows = f.byOperation.filter((o) => o.avgFeeUsdc !== null);
  barChart(viz("c-ops"), {
    bars: rows.map((o) => ({ label: OP_LABEL[o.op] ?? o.op, value: Number(o.avgFeeUsdc), sub: `${fmtInt(o.count)} tx` })),
    format: (v) => fmtUsdc(String(v)),
  });
  tableTwin($("c-ops"), ["Operation", "Transactions", "Average fee"], rows.map((o) => [OP_LABEL[o.op] ?? o.op, o.count, fmtUsdc(o.avgFeeUsdc)]), [1, 2]);
}

function renderRpc(r: Rpc, n: Network): void {
  const best = Math.max(...r.map((e) => e.maxLatest ?? 0), 0);
  const rows = r
    .map((e) => {
      const errRate = e.probes > 0 ? e.probeErrors / e.probes : 0;
      const lag = e.maxLatest === null ? null : best - e.maxLatest;
      const cls = errRate > 0.3 || (lag !== null && lag > 50) ? "bad" : errRate > 0.05 || (lag !== null && lag > 10) || e.callErrors > 20 ? "warn" : "ok";
      const label = cls === "ok" ? "healthy" : cls === "warn" ? "degraded" : "failing";
      return `<tr><td class="mono">${esc(e.endpoint.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</td><td><span class="status"><span class="dot ${cls}"></span>${label}</span></td><td class="num">${e.rttAvgMs}</td><td class="num">${e.rttP95Ms}</td><td class="num">${lag === null ? "—" : lag}</td><td class="num">${fmtPct(errRate, 0)}</td><td class="num">${e.callErrors}</td></tr>`;
    })
    .join("");
  $("rpc-table").innerHTML = r.length
    ? `<table class="data"><thead><tr><th>Endpoint</th><th>Status</th><th class="num">RTT avg (ms)</th><th class="num">RTT p95 (ms)</th><th class="num">Head lag (blocks)</th><th class="num">Probe errors</th><th class="num">Call errors</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<div class="empty">No probes yet${n.collector.lastBlockAgeSeconds === null ? " — collector starting" : ""}.</div>`;
}

function renderDeploys(d: Deploys): void {
  const rows = d.recent
    .map(
      (x) =>
        `<tr><td class="num">${fmtInt(x.blockNumber)}</td><td>${ago(x.timestamp)}</td><td class="mono"><a href="https://testnet.arcscan.app/address/${x.address}" rel="noopener">${short(x.address)}</a></td><td>${x.label ? `<span class="tag">${esc(x.protocol)}</span> ${esc(x.label)}` : '<span class="tag">unlabeled</span>'}</td><td class="mono">${short(x.deployer)}</td><td class="num">${x.runtimeCodeSize === null ? "—" : fmtCompact(x.runtimeCodeSize)}</td><td>${x.success ? "ok" : '<span class="status"><span class="dot bad"></span>failed</span>'}</td></tr>`,
    )
    .join("");
  const perHour = d.perHour.reduce((s, p) => s + p.deploys, 0);
  $("deploys-table").innerHTML = d.recent.length
    ? `<div class="sub" style="margin-bottom:6px">${fmtInt(perHour)} deploys in the last 24 h</div><table class="data"><thead><tr><th class="num">Block</th><th>When</th><th>Address</th><th>Label</th><th>Deployer</th><th class="num">Code (bytes)</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="empty">No deploys collected yet.</div>';
}

function renderEmitters(a: Activity): void {
  const rows = a.topLogEmitters.map((e) => `<tr><td class="mono">${short(e.address)}</td><td>${e.label ? `<span class="tag">${esc(e.protocol)}</span> ${esc(e.label)}` : '<span class="tag">unlabeled</span>'}</td><td class="num">${fmtInt(e.count)}</td></tr>`).join("");
  $("emitters-table").innerHTML = rows ? `<table class="data"><thead><tr><th>Address</th><th>Label</th><th class="num">Logs</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No logs in this window.</div>';
}

function renderSelectors(a: Activity): void {
  const rows = a.topSelectors.map((s) => `<tr><td class="mono">${esc(s.selector)}</td><td>${s.name ? esc(s.name) : '<span class="tag">unknown</span>'}</td><td class="num">${fmtInt(s.count)}</td></tr>`).join("");
  $("selectors-table").innerHTML = rows ? `<table class="data"><thead><tr><th>Selector</th><th>Function</th><th class="num">Calls</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No calls in this window.</div>';
}

let offline = false;
function showOffline(): void {
  if (offline) return;
  offline = true;
  document.querySelector(".tiles")?.classList.add("hidden");
  document.querySelector(".charts")?.classList.add("hidden");
  document.querySelector(".filters")?.classList.add("hidden");
  $("offline").classList.remove("hidden");
  document.getElementById("dash-footer")?.classList.add("hidden");
  $("meta").textContent = "";
  const dot = document.getElementById("netdot");
  const label = document.getElementById("netlabel");
  if (dot) dot.className = "dot";
  if (label) label.textContent = "Arc · live data soon";
}

document.querySelectorAll<HTMLButtonElement>("#window button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll<HTMLButtonElement>("#window button").forEach((x) => x.setAttribute("aria-pressed", "false"));
    b.setAttribute("aria-pressed", "true");
    windowMinutes = Number(b.dataset.w);
    void refresh();
  });
});

void refresh();
setInterval(() => { if (!offline) void refresh(); }, 5_000);
