import { ApiUnavailable, fmtGwei, fmtSec, fmtUsdc, getJson, type Fees, type Network } from "./api.js";
import { scrambleText, startHero, typeTerminal } from "./hero.js";
import { initChrome } from "./menu.js";

initChrome();

const hero = document.querySelector<HTMLElement>(".hero");
const title = document.getElementById("title");
if (hero) startHero(hero);
if (title) {
  const text = title.dataset.text ?? title.textContent ?? "";
  const go = () => scrambleText(title, text);
  document.fonts?.ready.then(go, go) ?? go();
}
const term = document.getElementById("term");
if (term) typeTerminal(term);

const set = (id: string, v: string) => { const e = document.getElementById(id); if (e) e.textContent = v; };

interface Summary {
  collected: { blocks: number; transactions: number; deploys: number };
  head: { number: number | null; lagBlocks: number | null; lastBlockAgeSeconds: number | null };
  pairs: Array<{ symbol: string; rate: number | null; trades: number; volumeUsdc: string }>;
  forSale: { routes: number; fromUsd: number; toUsd: number };
}

const compact = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const money = (raw: string): string => {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? `$${compact(Math.round(n))}` : `$${raw}`;
};

/** The live figures under the hero. It says how far behind it is rather than hiding it. */
async function refreshLive(): Promise<void> {
  const box = document.getElementById("live-tiles");
  if (!box) return;
  const s = await getJson<Summary>("/v1/summary");
  set("l-blocks", compact(s.collected.blocks));
  const lag = s.head.lagBlocks;
  set("l-head", s.head.number === null ? "\u00a0" : lag !== null && lag > 200 ? `head ${s.head.number.toLocaleString("en-US")}, ${compact(lag)} behind` : `head ${s.head.number.toLocaleString("en-US")}, following live`);
  set("l-txs", compact(s.collected.transactions));
  const trades = s.pairs.reduce((a, p) => a + p.trades, 0);
  const volume = s.pairs.reduce((a, p) => a + Number(p.volumeUsdc.replace(/,/g, "")), 0);
  set("l-swaps", compact(trades));
  set("l-volume", `${money(String(volume))} traded, ${s.pairs.map((p) => p.symbol).join(" and ")}`);
  set("l-deploys", compact(s.collected.deploys));
  set("l-routes", String(s.forSale.routes));
  set("l-prices", `$${s.forSale.fromUsd} to $${s.forSale.toUsd} a call`);
}

let stopped = false;
async function refresh(): Promise<void> {
  if (stopped) return;
  try {
    const [n, f] = await Promise.all([getJson<Network>("/v1/network"), getJson<Fees>("/v1/fees?window=60")]);
    if (f.current) set("s-fee", fmtGwei(f.current.baseFeeGwei));
    if (f.costNow) set("s-transfer", fmtUsdc(f.costNow.erc20TransferUsdc));
    if (n.finality.p50Seconds !== null) set("s-fin", fmtSec(n.finality.p50Seconds, 1));
    await refreshLive();
  } catch (err) {
    // No API behind this host (static hosting): keep the documented values in the page.
    if (err instanceof ApiUnavailable) {
      stopped = true;
      document.getElementById("live")?.classList.add("hidden");
    }
  }
}
void refresh();
setInterval(() => void refresh(), 30_000);
