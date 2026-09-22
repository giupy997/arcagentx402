import { ApiUnavailable, ago, fmtInt, getJson, short } from "./api.js";
import { initChrome } from "./menu.js";

initChrome();

interface Tally { settled: number; failed: number; notCharged: number; volumeUsdc: string; payers: number }
interface Payment { at: number; rail: string; outcome: string; payer: string | null; who: "self-test" | "ours" | "external"; amountUsdc: string; tx: string | null; route: string | null; reason: string | null }
interface Settlements {
  note: string;
  since: number | null;
  all: Tally;
  external: Tally;
  recent: Payment[];
  facilitator: { ok: boolean; signer: string | null; gasUsdc: string | null } | null;
}

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string | null | undefined) => (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const EXPLORERS: Record<string, string> = { direct: "https://explorer.arc.io", gateway: "https://explorer.arc.io", base: "https://basescan.org", solana: "https://solscan.io" };
let offline = false;

function showOffline(): void {
  if (offline) return;
  offline = true;
  document.querySelector(".tiles")?.classList.add("hidden");
  document.querySelector(".charts")?.classList.add("hidden");
  $("offline").classList.remove("hidden");
}

const OUTCOME: Record<string, string> = {
  settled: '<span class="status"><span class="dot ok"></span>settled</span>',
  failed: '<span class="status"><span class="dot bad"></span>failed</span>',
  not_charged: '<span class="status"><span class="dot warn"></span>not charged</span>',
};

/** Only a real hash is a link. A batched payment carries a transfer id, which no explorer knows. */
function proof(p: Payment): string {
  if (!p.tx) return esc(p.reason ?? "—");
  // A Solana signature is base58 and long; an EVM hash is 0x and 64 hex digits. Anything else is a transfer id.
  if (p.rail === "solana" && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(p.tx)) return `<a href="${EXPLORERS.solana}/tx/${esc(p.tx)}" rel="noopener">${esc(short(p.tx, 8))}</a>`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(p.tx)) return `<span title="${esc(p.tx)}">${esc(short(p.tx, 8))}</span>`;
  return `<a href="${EXPLORERS[p.rail] ?? EXPLORERS.direct}/tx/${esc(p.tx)}" rel="noopener">${esc(short(p.tx, 8))}</a>`;
}

async function refresh(): Promise<void> {
  try {
    const d = await getJson<Settlements>("/v1/settlements");
    const dot = document.getElementById("netdot");
    if (dot) dot.className = "dot ok";
    const attempts = d.all.settled + d.all.failed;
    $("s-settled").textContent = fmtInt(d.all.settled);
    $("s-ext").textContent = fmtInt(d.external.settled);
    $("s-since").textContent = d.since ? `counting since ${new Date(d.since * 1000).toISOString().slice(0, 10)}` : "nothing recorded yet";
    $("s-rate").textContent = attempts ? `${((d.all.settled / attempts) * 100).toFixed(attempts < 100 ? 0 : 1)}%` : "—";
    $("s-failed").textContent = fmtInt(d.all.failed);
    $("s-nc").textContent = fmtInt(d.all.notCharged);
    $("s-vol").textContent = `$${d.all.volumeUsdc}`;
    $("s-vol-ext").textContent = `$${d.external.volumeUsdc} from wallets that are not ours`;
    $("s-payers").textContent = fmtInt(d.all.payers);
    $("s-payers-ext").textContent = `${fmtInt(d.external.payers)} not ours`;
    const f = d.facilitator;
    $("s-fac").innerHTML = f ? (f.ok ? '<span class="status"><span class="dot ok"></span>up</span>' : '<span class="status"><span class="dot bad"></span>down</span>') : "—";
    $("s-fac-note").textContent = f?.gasUsdc ? `$${f.gasUsdc} of gas left · ${short(f.signer)}` : f ? "not answering" : "direct rail off";
    const last = d.recent[0];
    $("s-last").textContent = last ? ago(last.at) : "—";
    $("s-last-note").textContent = last ? `${last.who} · ${last.rail}` : "";
    $("pay-table").innerHTML = d.recent.length
      ? `<table class="data"><thead><tr><th>When</th><th>Result</th><th>Rail</th><th class="num">Amount</th><th>Payer</th><th>Whose</th><th>Bought</th><th>Transaction</th></tr></thead><tbody>${d.recent
          .map(
            (p) =>
              `<tr><td>${ago(p.at)}</td><td>${OUTCOME[p.outcome] ?? esc(p.outcome)}</td><td><span class="tag">${esc(p.rail)}</span></td><td class="num">$${esc(p.amountUsdc)}</td><td class="mono">${esc(p.payer ?? "—")}</td><td>${
                p.who === "external" ? "external" : `<span class="tag">${p.who}</span>`
              }</td><td class="mono">${esc(p.route?.replace(/^\/v1\/(paid|direct)/, "") ?? "—")}</td><td class="mono">${proof(p)}</td></tr>`,
          )
          .join("")}</tbody></table>`
      : '<div class="empty">No payments recorded yet. <a href="/try">Make the first one from your wallet.</a></div>';
    $("status-note").textContent = `${fmtInt(attempts + d.all.notCharged)} payments recorded`;
  } catch (err) {
    if (err instanceof ApiUnavailable) showOffline();
  }
}

void refresh();
setInterval(() => { if (!offline) void refresh(); }, 15_000);
