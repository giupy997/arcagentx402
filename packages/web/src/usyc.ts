import { ApiUnavailable, ago, getJson, short } from "./api.js";
import { lineChart, tableTwin } from "./charts.js";
import { initChrome } from "./menu.js";

initChrome();

interface Usyc {
  price: { usd: string; exact: string; round: number; updatedAt: number; oracle: string } | null;
  growth: { annualized7d: number | null; annualized30d: number | null; sinceFirstRound: { annualized: number; days: number; fromUsd: string } | null };
  supplyOnArc: string;
  history: Array<{ round: number; at: number; usd: string }>;
  contracts: { token: string; teller: string; entitlements: string; oracle: string };
  readAt: number;
}

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string | null | undefined) => (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(2)}%`);
const day = (unix: number) => new Date(unix * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const EXPLORER = "https://explorer.arc.io";
let offline = false;

async function refresh(): Promise<void> {
  try {
    const d = await getJson<Usyc>("/v1/usyc");
    const dot = document.getElementById("netdot");
    if (dot) dot.className = "dot ok";
    $("u-price").textContent = d.price ? `$${d.price.usd}` : "—";
    $("u-price-note").innerHTML = d.price ? `oracle round ${d.price.round}<br>published ${ago(d.price.updatedAt)}` : "no price yet";
    $("u-7d").textContent = pct(d.growth.annualized7d);
    $("u-30d").textContent = pct(d.growth.annualized30d);
    $("u-supply").textContent = Number(d.supplyOnArc).toLocaleString("en-US", { maximumFractionDigits: 2 });
    $("u-supply-note").textContent = Number(d.supplyOnArc) === 0 ? "nobody has minted on Arc yet: the first mint shows up here" : "USYC minted on Arc and not yet redeemed";
    const s = d.growth.sinceFirstRound;
    $("u-since").textContent = s ? pct(s.annualized) : "—";
    $("u-since-note").textContent = s ? `a year, over ${Math.round(s.days)} days, from $${s.fromUsd}` : "";

    $("u-last").textContent = d.price ? ago(d.price.updatedAt) : "—";
    const pts = d.history.map((h) => ({ x: h.at, y: Number(h.usd), label: day(h.at) }));
    lineChart(document.querySelector<HTMLElement>("#c-usyc .viz")!, { points: pts, area: true, yFormat: (v) => `$${v.toFixed(4)}`, xFormat: (v) => day(v), color: "var(--series-2)" });
    tableTwin($("c-usyc"), ["Round", "Published", "Price"], [...d.history].reverse().map((h) => [h.round, new Date(h.at * 1000).toISOString().slice(0, 16).replace("T", " "), `$${h.usd}`]), [0, 2]);

    const rows: Array<[string, string]> = [["USYC token", d.contracts.token], ["Teller (mint and redeem)", d.contracts.teller], ["Entitlements (allowlist)", d.contracts.entitlements], ["Price oracle", d.contracts.oracle]];
    $("u-contracts").innerHTML = `<table class="data"><tbody>${rows.map(([name, a]) => `<tr><td>${esc(name)}</td><td class="mono"><a href="${EXPLORER}/address/${esc(a)}" rel="noopener">${esc(short(a, 8))}</a></td></tr>`).join("")}</tbody></table>`;
    $("u-read").textContent = `read ${ago(d.readAt)}`;
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
setInterval(() => { if (!offline) void refresh(); }, 300_000);
