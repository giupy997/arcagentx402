/**
 * The bazaar page: everything an agent can buy on Arc, searched and browsed by seller and by kind.
 * Every word about a seller comes from the API, which read it from the seller's catalogue entry or its
 * own 402; logos come from the API too, never straight from a seller's site. The address keeps the
 * search, the seller and the category, so any view can be shared.
 */
import { API_BASE, ApiUnavailable, getJson } from "./api.js";
import { initChrome } from "./menu.js";

initChrome();

type Source = "cra-agent" | "market" | "circle";
interface Seller {
  name: string;
  source: Source;
  site: string | null;
  logo: string | null;
  description: string | null;
  categories: string[];
  endpoints: number;
  priceFrom: string;
  priceTo: string;
  families: string[];
  familyCount: number;
  rail: "gateway" | "direct" | "both";
  networks: string[];
  plainNetworks: string[];
}
interface Overview {
  counts: { endpoints: number; sellers: number; categories: number };
  categories: Array<{ name: string; endpoints: number; sellers: number }>;
  networks: Array<{ id: string; name: string; endpoints: number; sellers: number; plain: number }>;
  sellers: Seller[];
}
interface Found {
  url: string;
  method: string;
  priceUsd: string;
  name: string;
  label: string | null;
  description: string | null;
  params: Array<{ name: string; required: boolean; in?: string }>;
  rail: string;
  source: Source;
  category: string | null;
  site: string | null;
  networks?: string[];
  plainNetworks?: string[];
}
interface SearchAnswer {
  count: number;
  results: Found[];
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string | null | undefined) => (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const LISTED_BY: Record<Source, string> = { "cra-agent": "CRA AGENT", market: "CRA market", circle: "Circle catalogue" };
const ARC = "eip155:5042";
/** Short names for the address bar and the badges; the rest show as the API names them. */
const ALIAS: Record<string, string> = { "eip155:5042": "arc", "eip155:8453": "base", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "solana", "eip155:1": "ethereum", "eip155:137": "polygon", "eip155:42161": "arbitrum", "eip155:10": "optimism", "eip155:43114": "avalanche" };
const FROM_ALIAS = Object.fromEntries(Object.entries(ALIAS).map(([id, a]) => [a, id]));
const netName = (id: string) => overview?.networks.find((n) => n.id === id)?.name ?? id;
const host = (site: string | null) => {
  try {
    return site ? new URL(site).host.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
};

/** A seller without a logo gets its initials on a colour of its own, from the blues the site uses. */
function monogram(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/);
  const initials = (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2)).toUpperCase();
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `<span class="monogram" style="--hue:${190 + (h % 80)}">${esc(initials)}</span>`;
}

/** The seller's logo from our API, falling back to its monogram when there is none. */
function logo(s: { name: string; source: Source; logo: string | null }, size: "sm" | "lg"): string {
  if (s.source === "cra-agent") return `<span class="b-logo ${size}"><img src="/brand/logo-96.png" alt="" width="96" height="96"></span>`;
  if (!s.logo) return `<span class="b-logo ${size} failed">${monogram(s.name)}</span>`;
  return `<span class="b-logo ${size}"><img src="${esc(API_BASE + s.logo)}" alt="" loading="lazy" decoding="async">${monogram(s.name)}</span>`;
}

/** Broken logos show the monogram instead: images arrive after the markup, so this runs after each render. */
function watchLogos(root: HTMLElement): void {
  for (const img of root.querySelectorAll<HTMLImageElement>(".b-logo img")) {
    const fail = () => img.parentElement?.classList.add("failed");
    if (img.complete && img.naturalWidth === 0) fail();
    else img.addEventListener("error", fail, { once: true });
  }
}

let overview: Overview | null = null;
const logoOf = new Map<string, Seller>();
const state: { q: string; seller: string | null; category: string | null; network: string | null } = { q: "", seller: null, category: null, network: null };

/** "Arc, Base, +5 more": a list of networks by name, the first few. */
function names(list: readonly string[], max = 3): string {
  return `${list.slice(0, max).map(netName).join(", ")}${list.length > max ? `, +${list.length - max} more` : ""}`;
}

/**
 * How something takes payment, network by network: any x402 client where it takes a plain transfer,
 * Circle Gateway where it takes only Gateway's batched payment (USDC deposited in Gateway first).
 */
function howToPay(networks: readonly string[] | undefined, plain: readonly string[] | undefined): string {
  const all = networks?.length ? networks : [ARC];
  const open = new Set(plain ?? []);
  const any = all.filter((n) => open.has(n));
  const gateway = all.filter((n) => !open.has(n));
  return [any.length ? `any x402 client on ${names(any)}` : "", gateway.length ? `Circle Gateway on ${names(gateway)}` : ""].filter(Boolean).join(" · ");
}

function sellerCard(s: Seller): string {
  const price = s.priceFrom === s.priceTo ? `$${esc(s.priceFrom)}` : `$${esc(s.priceFrom)} – $${esc(s.priceTo)}`;
  const about = s.description ?? (s.familyCount > 1 ? `${s.familyCount} APIs in one place.` : null);
  const more = s.familyCount > s.families.length ? `<span class="more">+${s.familyCount - s.families.length} more</span>` : "";
  const families = s.families.length ? `<div class="families">${s.families.map((f) => `<span>${esc(f)}</span>`).join("")}${more}</div>` : "";
  const cats = s.categories.length ? `<div class="seller-cats">${s.categories.map(esc).join(" · ")}</div>` : "";
  return `<article class="seller">
    <header>${logo(s, "lg")}<div class="seller-name"><h3>${esc(s.name)}</h3><div class="sub">${s.site ? `<a href="${esc(s.site)}" rel="noopener noreferrer nofollow" target="_blank">${esc(host(s.site))}</a>` : ""}</div></div><span class="badge ${s.source}">${esc(LISTED_BY[s.source])}</span></header>
    ${about ? `<p>${esc(about)}</p>` : ""}
    ${families}${cats}
    <div class="seller-nets"><span class="b-chips-label">Pays</span> ${esc(howToPay(s.networks, s.plainNetworks))}</div>
    <footer><span class="seller-stats"><b>${s.endpoints}</b> ${s.endpoints === 1 ? "endpoint" : "endpoints"} · ${price} per call</span><button type="button" class="btn" data-seller="${esc(s.name)}">See them</button></footer>
  </article>`;
}

function hit(r: Found): string {
  const seller = logoOf.get(`${r.source}|${r.name}`);
  const needs = r.params.filter((p) => p.required).map((p) => p.name);
  const what = r.label ?? r.description ?? r.name;
  const how = esc(howToPay(r.networks, r.plainNetworks));
  return `<li class="hit">
    ${logo({ name: r.name, source: r.source, logo: seller?.logo ?? null }, "sm")}
    <div class="hit-main">
      <div class="hit-what">${esc(what)}</div>
      <div class="hit-sub">${esc(r.name)}${r.category ? ` · ${esc(r.category)}` : ""} · <span class="badge ${r.source}">${esc(LISTED_BY[r.source])}</span></div>
      <div class="hit-call"><span class="tag">${esc(r.method)}</span><code>${esc(r.url)}</code><button type="button" class="copy" data-copy="${esc(r.url)}" aria-label="Copy the address">copy</button></div>
      <div class="hit-sub">${needs.length ? `needs ${esc(needs.join(", "))} · ` : ""}${how}</div>
    </div>
    <div class="hit-price">$${esc(r.priceUsd)}<span>per call</span></div>
  </li>`;
}

function syncAddress(): void {
  const here = new URL(location.href);
  for (const [k, v] of Object.entries({ q: state.q, seller: state.seller, category: state.category, network: state.network ? (ALIAS[state.network] ?? state.network) : null })) {
    if (v) here.searchParams.set(k, v);
    else here.searchParams.delete(k);
  }
  history.replaceState(null, "", here);
}

function renderCategories(): void {
  if (!overview) return;
  const chip = (name: string | null, label: string, n: number) => `<button type="button" class="chip${state.category === name ? " on" : ""}" data-category="${esc(name ?? "")}">${esc(label)} <span>${n}</span></button>`;
  $("b-cats").innerHTML = `<span class="b-chips-label">Kinds</span>${chip(null, "All", overview.counts.endpoints)}${overview.categories.map((c) => chip(c.name, c.name, c.endpoints)).join("")}`;
  const net = (id: string | null, label: string, n: number, title: string) => `<button type="button" class="chip${state.network === id ? " on" : ""}" data-network="${esc(id ?? "")}" title="${esc(title)}">${esc(label)} <span>${n}</span></button>`;
  $("b-nets").innerHTML = `<span class="b-chips-label">Pays on</span>${net(null, "Any", overview.counts.endpoints, "every network")}${overview.networks
    .slice(0, 6)
    .map((n) => net(n.id, n.name, n.endpoints, `${n.endpoints} payable on ${n.name}: ${n.plain} from any x402 client, ${n.endpoints - n.plain} through Circle Gateway only`))
    .join("")}`;
}

/** Runs the search for the current state: words, a seller, a kind, or any mix of them. */
async function run(): Promise<void> {
  syncAddress();
  renderCategories();
  const status = $("s-status");
  const out = $("s-results");
  const words = state.q.trim();
  if (words.length < 2 && !state.seller && !state.category && !state.network) {
    status.textContent = "";
    out.innerHTML = "";
    return;
  }
  status.textContent = "Searching…";
  const params = new URLSearchParams({ limit: state.seller || state.category || state.network ? "50" : "20" });
  if (words) params.set("q", words);
  if (state.seller) params.set("seller", state.seller);
  if (state.category) params.set("category", state.category);
  if (state.network) params.set("network", state.network);
  try {
    const d = await getJson<SearchAnswer>(`/v1/market/search?${params}`);
    const filters = [state.seller ? `from ${esc(state.seller)}` : "", state.category ? `in ${esc(state.category)}` : "", state.network ? `payable on ${esc(netName(state.network))}` : ""].filter(Boolean).join(" ");
    const clear = state.seller || state.category || state.network ? ` <button type="button" class="linkish" id="s-clear">clear filters</button>` : "";
    status.innerHTML = `${d.count ? `${d.count} ${d.count === 1 ? "result" : "results"}` : "Nothing found"}${words ? ` for “${esc(words)}”` : ""}${filters ? ` ${filters}` : ""}.${clear}`;
    out.innerHTML = d.results.map(hit).join("");
    watchLogos(out);
    $("s-clear")?.addEventListener("click", () => {
      state.seller = null;
      state.category = null;
      state.network = null;
      void run();
    });
  } catch {
    status.textContent = "Could not reach the search. Try again in a moment.";
  }
}

async function load(): Promise<void> {
  try {
    overview = await getJson<Overview>("/v1/bazaar");
  } catch (err) {
    if (err instanceof ApiUnavailable) {
      document.querySelector(".charts")?.classList.add("hidden");
      $("offline").classList.remove("hidden");
    }
    return;
  }
  const dot = document.getElementById("netdot");
  if (dot) dot.className = "dot ok";
  for (const s of overview.sellers) logoOf.set(`${s.source}|${s.name}`, s);
  const { endpoints, sellers } = overview.counts;
  const onBase = overview.networks.find((n) => n.id === "eip155:8453")?.endpoints ?? 0;
  $("b-meta").textContent = `${endpoints} paid APIs from ${sellers} sellers · paid per call in USDC on Arc${onBase ? `, ${onBase} of them on Base too` : ""} · searched the same way by people and agents`;
  $("b-count").textContent = `${endpoints} endpoints, ${sellers} sellers`;
  $("b-sellers-sub").textContent = `${sellers} sellers, every one payable on Arc.`;
  $("b-logos").innerHTML = overview.sellers.slice(0, 12).map((s) => logo(s, "sm")).join("");
  watchLogos($("b-logos"));
  $("b-sellers").innerHTML = overview.sellers.map(sellerCard).join("");
  watchLogos($("b-sellers"));
  renderCategories();
}

$("s-form").addEventListener("submit", (e) => {
  e.preventDefault();
  state.q = $<HTMLInputElement>("s-q").value;
  void run();
});
$("s-examples").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button.chip");
  if (!b) return;
  state.q = b.textContent ?? "";
  $<HTMLInputElement>("s-q").value = state.q;
  void run();
});
$("b-cats").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button.chip");
  if (!b) return;
  state.category = b.dataset.category || null;
  void run();
});
$("b-nets").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button.chip");
  if (!b) return;
  state.network = b.dataset.network || null;
  void run();
});
$("b-sellers").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-seller]");
  if (!b) return;
  state.seller = b.dataset.seller ?? null;
  state.q = "";
  $<HTMLInputElement>("s-q").value = "";
  void run().then(() => $("s-form").scrollIntoView({ behavior: "smooth", block: "start" }));
});
$("s-results").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button.copy");
  if (!b?.dataset.copy) return;
  void navigator.clipboard?.writeText(b.dataset.copy).then(() => {
    b.textContent = "copied";
    setTimeout(() => (b.textContent = "copy"), 1500);
  });
});

const asked = new URLSearchParams(location.search);
state.q = (asked.get("q") ?? "").slice(0, 200);
state.seller = asked.get("seller");
state.category = asked.get("category");
const askedNetwork = asked.get("network");
state.network = askedNetwork ? (FROM_ALIAS[askedNetwork.toLowerCase()] ?? askedNetwork) : null;
$<HTMLInputElement>("s-q").value = state.q;
void load().then(() => run());
