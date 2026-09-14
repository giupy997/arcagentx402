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

let stopped = false;
async function refresh(): Promise<void> {
  if (stopped) return;
  try {
    const [n, f] = await Promise.all([getJson<Network>("/v1/network"), getJson<Fees>("/v1/fees?window=60")]);
    if (f.current) set("s-fee", fmtGwei(f.current.baseFeeGwei));
    if (f.costNow) set("s-transfer", fmtUsdc(f.costNow.erc20TransferUsdc));
    if (n.finality.p50Seconds !== null) set("s-fin", fmtSec(n.finality.p50Seconds, 1));
  } catch (err) {
    // No API behind this host (static hosting): keep the documented values in the page.
    if (err instanceof ApiUnavailable) stopped = true;
  }
}
void refresh();
setInterval(() => void refresh(), 15_000);
