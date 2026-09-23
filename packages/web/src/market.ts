/**
 * The market page: a search over everything payable on Arc, what is listed here, and a field to add
 * an endpoint. The page writes nothing about a listing: every cell comes from the API, which read it
 * from the endpoint, or from Circle's catalogue for the entries that come from there.
 */
import { API_BASE, ApiUnavailable, ago, getJson, short } from "./api.js";
import { initChrome } from "./menu.js";

initChrome();

interface Listing {
  url: string;
  host: string;
  name: string | null;
  description: string | null;
  priceUsd: string;
  payTo: string;
  rail: string;
  networks?: string[];
  routes: Array<{ pattern: string; priceUsd: string; description: string | null }> | null;
  online: boolean;
  addedAt: number;
  checkedAt: number;
}
interface Market { network: string; note?: string; listings: Listing[] }
interface Found {
  url: string;
  method: string;
  priceUsd: string;
  name: string;
  label: string | null;
  description: string | null;
  params: Array<{ name: string; required: boolean }>;
  rail: string;
  source: string;
}
interface SearchAnswer { count: number; searched?: { ownRoutes: number; marketListings: number; circleCatalogue?: number }; results: Found[] }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string | null | undefined) => (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const EXPLORER = "https://explorer.arc.io";
const RAIL: Record<string, string> = { gateway: "agents (Circle Gateway)", direct: "agents and browser wallets" };
const CHAIN: Record<string, string> = { "eip155:5042": "Arc", "eip155:8453": "Base", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "Solana", "eip155:5042002": "Arc testnet", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "Solana devnet" };
/** "Arc: agents and browser wallets · Solana, Base" */
const whoCanPay = (l: Listing): string => {
  const others = (l.networks ?? []).filter((n) => !n.startsWith("eip155:5042")).map((n) => CHAIN[n] ?? n);
  return `Arc: ${RAIL[l.rail] ?? l.rail}${others.length ? ` · also ${others.join(", ")}` : ""}`;
};

/** Only an https address becomes a link, and it never passes our page as its referrer. */
const link = (url: string, text: string): string => (/^https:\/\//i.test(url) ? `<a href="${esc(url)}" rel="noopener noreferrer nofollow ugc" target="_blank">${esc(text)}</a>` : esc(text));

function row(l: Listing): string {
  const more = l.routes && l.routes.length > 1 ? `<div class="sub">${l.routes.length} priced paths, from $${esc([...l.routes].sort((a, b) => Number(a.priceUsd) - Number(b.priceUsd))[0]!.priceUsd)}</div>` : "";
  return `<tr><td><b>${esc(l.name ?? l.host)}</b><div class="sub mono">${link(l.url, l.host)}</div></td><td>${esc(l.description ?? "—")}${more}</td><td class="num">$${esc(l.priceUsd)}</td><td>${esc(whoCanPay(l))}</td><td class="mono"><a href="${EXPLORER}/address/${esc(l.payTo)}" rel="noopener">${esc(short(l.payTo))}</a></td><td>${
    l.online ? '<span class="status"><span class="dot ok"></span>answers</span>' : '<span class="status"><span class="dot bad"></span>not answering</span>'
  }<div class="sub">checked ${ago(l.checkedAt)}</div></td></tr>`;
}

async function refresh(): Promise<void> {
  try {
    const d = await getJson<Market>("/v1/market");
    const dot = document.getElementById("netdot");
    if (dot) dot.className = "dot ok";
    $("market-note").textContent = d.note ?? "";
    $("market-table").innerHTML = d.listings.length
      ? `<table class="data"><thead><tr><th>Who</th><th>What it says it sells</th><th class="num">Price of this call</th><th>Who can pay, where</th><th>Paid to</th><th>Status</th></tr></thead><tbody>${d.listings.map(row).join("")}</tbody></table>`
      : '<div class="empty">Nothing listed yet. Be the first: add an endpoint below.</div>';
    $("market-count").textContent = `${d.listings.length} listed`;
  } catch (err) {
    if (err instanceof ApiUnavailable) {
      document.querySelector(".charts")?.classList.add("hidden");
      $("offline").classList.remove("hidden");
    }
  }
}

const LISTED_BY: Record<string, string> = { "cra-agent": "CRA AGENT", market: "this market", circle: "Circle's catalogue" };

function foundRow(r: Found): string {
  const needs = r.params.filter((p) => p.required).map((p) => p.name);
  const what = r.label ?? r.description ?? r.name;
  return `<tr><td><b>${esc(what)}</b>${r.label && r.description ? `<div class="sub">${esc(r.description)}</div>` : ""}</td><td>${esc(r.name)}<div class="sub">listed by ${esc(LISTED_BY[r.source] ?? r.source)}</div></td><td class="num">$${esc(r.priceUsd)}</td><td class="call"><span class="tag">${esc(r.method)}</span> ${esc(r.url)}<div class="sub">${needs.length ? `needs ${esc(needs.join(", "))} · ` : ""}${r.rail === "gateway" ? "agents, through Circle Gateway" : "agents and browser wallets"}</div></td></tr>`;
}

/** The same search an agent runs. The words stay in the address, so a search can be shared. */
async function find(q: string): Promise<void> {
  const count = $("s-count");
  const out = $("s-results");
  const words = q.trim();
  if (words.length < 2) {
    count.textContent = "Write what you need in a few words.";
    out.innerHTML = "";
    return;
  }
  count.textContent = "Searching…";
  try {
    const d = await getJson<SearchAnswer>(`/v1/market/search?q=${encodeURIComponent(words)}&limit=20`);
    const s = d.searched;
    const where = s ? ` in ${s.ownRoutes} CRA AGENT routes, ${s.marketListings} market listings${s.circleCatalogue ? ` and ${s.circleCatalogue} endpoints from Circle's catalogue` : ""}` : "";
    count.textContent = `${d.count ? `${d.count} found` : "Nothing found"}${where}.`;
    out.innerHTML = d.count ? `<table class="data"><thead><tr><th>What it does</th><th>Seller</th><th class="num">Price per call</th><th>Call</th></tr></thead><tbody>${d.results.map(foundRow).join("")}</tbody></table>` : "";
    $("s-circle-note").classList.toggle("hidden", !d.results.some((r) => r.source === "circle"));
    const here = new URL(location.href);
    here.searchParams.set("q", words);
    history.replaceState(null, "", here);
  } catch {
    count.textContent = "Could not reach the search. Try again in a moment.";
  }
}

async function add(): Promise<void> {
  const button = $<HTMLButtonElement>("m-add");
  const out = $("m-result");
  const url = $<HTMLInputElement>("m-url").value.trim();
  if (!url) {
    out.textContent = "Paste the address first.";
    return;
  }
  button.disabled = true;
  out.textContent = "Calling it without paying, to see what it asks for…";
  try {
    const res = await fetch(`${API_BASE}/v1/market`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
    const body = (await res.json().catch(() => ({}))) as { error?: string; listing?: { priceUsd: string; payTo: string; rail: string } };
    out.textContent = res.ok && body.listing ? `Listed. It charges $${body.listing.priceUsd} per call, paid to ${short(body.listing.payTo)}.` : `Not listed: ${body.error ?? `the API answered ${res.status}`}.`;
    if (res.ok) void refresh();
  } catch {
    out.textContent = "Could not reach the API. Try again in a moment.";
  } finally {
    button.disabled = false;
  }
}

$("m-add").addEventListener("click", () => void add());
$("s-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void find($<HTMLInputElement>("s-q").value);
});
for (const b of document.querySelectorAll<HTMLButtonElement>("#s-examples button")) {
  b.addEventListener("click", () => {
    $<HTMLInputElement>("s-q").value = b.textContent ?? "";
    void find(b.textContent ?? "");
  });
}
const asked = new URLSearchParams(location.search).get("q");
if (asked) {
  $<HTMLInputElement>("s-q").value = asked.slice(0, 200);
  void find(asked);
}
void refresh();
setInterval(() => void refresh(), 60_000);
