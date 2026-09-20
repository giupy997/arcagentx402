/**
 * Buy one API call from a browser wallet, over x402, settled on Arc.
 *
 * No library: the protocol is three steps and they fit on a page. The API answers 402 with its
 * requirements in a header, the wallet signs an EIP-3009 authorization (EIP-712 typed data), and
 * the same request goes out again with that signature in a header. The page never sees a key and
 * never sends a transaction: the facilitator submits the transfer and pays its gas.
 */
import { API_BASE } from "./api.js";
import { initChrome } from "./menu.js";

initChrome();

const ARC = { chainIdHex: "0x13b2", caip2: "eip155:5042", chainId: 5042 };
const ARC_PARAMS = {
  chainId: ARC.chainIdHex,
  chainName: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: ["https://rpc.blockdaemon.mainnet.arc.io", "https://rpc.quicknode.mainnet.arc.io"],
  blockExplorerUrls: ["https://explorer.arc.io"],
};
const USDC = "0x3600000000000000000000000000000000000000";
const EXPLORER = "https://explorer.arc.io";

interface Eip1193 { request(args: { method: string; params?: unknown[] }): Promise<unknown> }
interface Accept { scheme: string; network: string; amount: string; asset: string; payTo: string; maxTimeoutSeconds: number; extra?: { name?: string; version?: string } }
interface PaymentRequired { x402Version: number; resource: unknown; accepts: Accept[]; extensions?: unknown }
interface RouteParam { name: string; description?: string; example?: string | number; required?: boolean }
interface RouteInfo { route: string; summary: string; group?: string; label?: string; explain?: string; priceUsd?: string; params: RouteParam[]; alwaysFails: boolean }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const wallet = (): Eip1193 | null => (window as unknown as { ethereum?: Eip1193 }).ethereum ?? null;
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
const usd = (baseUnits: string) => `$${(Number(baseUnits) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

let account: string | null = null;
/** What each choice is, in plain words, shown under the menu. */
const explain = new Map<string, string>();

function step(text: string, state: "" | "ok" | "bad" = ""): HTMLLIElement {
  const li = document.createElement("li");
  li.textContent = text;
  if (state) li.className = state;
  $("steps").appendChild(li);
  return li;
}

/** One sentence on what just arrived, for someone who does not read JSON. The full answer stays below it. */
function inPlainWords(url: string, body: string): string {
  try {
    const d = JSON.parse(body) as Record<string, any>;
    const n = (v: unknown, digits: number) => Number(v).toFixed(digits);
    if (url.includes("/fx/execution")) {
      const w = d.window ?? {};
      return `Right now 1 ${d.symbol} trades for ${n(d.last?.rate, 4)} USDC on Arc. Over the last ${w.minutes} minutes: ${w.trades} real trades, average ${n(w.vwap, 4)}, worth $${w.volumeUsdc}.`;
    }
    if (url.includes("/fees/estimate")) return `A simple transfer on Arc costs about $${d.costUsdc} right now, with the network fee at ${d.baseFeeGwei} gwei.`;
    if (url.includes("/fees/forecast")) return `The network fee on Arc is ${n(d.current?.baseFeeGwei, 1)} gwei now. Sending USDC costs about $${d.costNow?.erc20TransferUsdc}, and the floor is ${d.floorGwei} gwei.`;
    if (url.includes("/rpc/health")) {
      const rows = (Array.isArray(d) ? d : []) as Array<Record<string, any>>;
      const best = [...rows].sort((a, b) => a.callErrors - b.callErrors || a.rttAvgMs - b.rttAvgMs)[0];
      return best ? `${rows.length} public access points measured. The most reliable right now is ${new URL(best.endpoint).host}: ${best.callErrors} failed calls, ${best.rttAvgMs} ms on average.` : "Measurements for the public access points.";
    }
    if (url.includes("/arc/wallet")) return `This ${d.type} holds ${d.usdc} USDC${d.cra === undefined ? "" : ` and ${d.cra} CRA`}, and has sent ${d.transactionsSent} transactions.`;
    if (url.includes("/arc/token")) return `${d.name ?? "Unnamed token"} (${d.symbol ?? "no ticker"}): ${d.totalSupply ?? "unknown"} in existence, ${d.decimals} decimals.`;
    if (url.includes("/arc/tx")) return `This transaction ${d.status === "success" ? "went through" : d.status === "reverted" ? "failed" : "is still pending"}. It was a ${d.kind}, cost $${d.feeUsdc} in fees, and moved tokens ${(d.transfers ?? []).length} time(s).`;
    if (url.includes("/web/extract")) return `“${d.title ?? "Untitled page"}”: ${d.words} words of clean text, ${(d.headings ?? []).length} headings.`;
    if (url.includes("/web/check")) return `The site is ${d.up ? "up" : "down"}: it answered ${d.status} in ${d.totalMs} ms after ${(d.redirects ?? []).length} redirect(s). ${(d.missingSecurityHeaders ?? []).length} of 6 common security settings are missing.`;
    if (url.includes("/packages/npm")) return `${d.name} is at version ${d.latest}, licence ${d.license ?? "unknown"}, ${Number(d.weeklyDownloads ?? 0).toLocaleString("en-US")} downloads a week.${d.deprecated ? " Its authors marked it as deprecated." : ""}`;
    if (url.includes("/packages/pypi")) return `${d.name} is at version ${d.latest}, needs Python ${d.requiresPython ?? "any"}, and has ${(d.advisories ?? []).length} known security problem(s) in this version.`;
    if (url.includes("/packages/vulns")) return `${d.count} known security problem(s) for ${d.name}${d.version ? ` ${d.version}` : ", counting every version ever published"}.`;
    if (url.includes("/domains/dns")) return d.exists ? `${d.name} points to ${(d.records?.A ?? []).map((r: { value: string }) => r.value).join(", ") || "no IPv4 address"}. Signed answers (DNSSEC): ${d.dnssec ? "yes" : "no"}.` : `${d.name} does not exist in the DNS.`;
    if (url.includes("/domains/whois")) return d.registered ? `${d.domain} was registered through ${d.registrar ?? "an unnamed registrar"} on ${String(d.createdAt).slice(0, 10)} and expires on ${String(d.expiresAt).slice(0, 10)}.` : `${d.domain} has no registration record: it looks free.`;
    if (url.includes("/currency/convert")) return `${d.amount} ${d.from} is ${d.result} ${d.to}, at the official reference rate of ${d.date}.`;
    if (url.includes("/currency/rates")) return `${Object.keys(d.rates ?? {}).length} official reference rates against ${d.base}, as of ${d.date}.`;
    if (url.includes("/wiki/search")) return `${(d.results ?? []).length} Wikipedia articles found. The best match is “${d.results?.[0]?.title ?? "none"}”.`;
    if (url.includes("/wiki/summary")) return String(d.summary ?? "").slice(0, 240) + (String(d.summary ?? "").length > 240 ? "…" : "");
    if (url.includes("/wiki/article")) return `“${d.title}”: ${Number(d.characters).toLocaleString("en-US")} characters of plain text${d.truncated ? ", cut at our limit" : ""}.`;
    if (url.includes("/deploys/history")) return `${(d.recent ?? []).length} of the most recent contracts deployed on Arc, newest first.`;
  } catch {
    /* not JSON: nothing to summarise */
  }
  return "The full answer is below.";
}

async function loadRoutes(): Promise<void> {
  const sel = $<HTMLSelectElement>("route");
  try {
    const res = await fetch(`${API_BASE}/v1/direct`);
    const info = (await res.json()) as { settlement: string; routes?: RouteInfo[] };
    if (info.settlement !== "direct" || !info.routes) throw new Error("direct settlement is off on this API");
    const params = new Map<string, RouteParam[]>();
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const r of info.routes) {
      const path = r.route.replace("GET ", "");
      const opt = document.createElement("option");
      opt.value = path;
      opt.textContent = `${r.label ?? r.summary}${r.priceUsd && !r.alwaysFails ? `, $${r.priceUsd}` : ""}`;
      explain.set(path, `${r.explain ?? r.summary}${r.priceUsd ? (r.alwaysFails ? " It would cost nothing even if it worked differently: a failed call is never charged." : ` Costs $${r.priceUsd}.`) : ""}`);
      params.set(path, r.params);
      const name = r.group ?? "Other";
      let group = groups.get(name);
      if (!group) {
        group = document.createElement("optgroup");
        group.label = name;
        groups.set(name, group);
        sel.appendChild(group);
      }
      group.appendChild(opt);
    }
    // Lead with the one people understand at a glance.
    const fx = [...sel.options].find((o) => o.value.includes("/fx/execution"));
    if (fx) sel.value = fx.value;
    const show = () => {
      $("route-note").textContent = explain.get(sel.value) ?? "";
      // One field per thing the route can be asked, filled with an example that works as it is.
      const box = $("route-params");
      box.innerHTML = "";
      for (const p of params.get(sel.value) ?? []) {
        const label = document.createElement("label");
        label.className = "field";
        const name = document.createElement("span");
        name.textContent = `${p.name}${p.required ? "" : " (optional)"}`;
        const input = document.createElement("input");
        input.type = "text";
        input.name = p.name;
        input.spellcheck = false;
        input.autocomplete = "off";
        // Asking about a wallet, the interesting one is the visitor's own.
        input.value = p.name === "address" && sel.value.endsWith("/arc/wallet") && account ? account : p.example === undefined ? "" : String(p.example);
        if (p.description) input.title = p.description;
        const hint = document.createElement("small");
        hint.textContent = p.description ?? "";
        label.append(name, input, hint);
        box.appendChild(label);
      }
    };
    sel.addEventListener("change", show);
    show();
  } catch (err) {
    $("route-note").textContent = `Could not load the routes: ${(err as Error).message}`;
  }
}

async function showBalance(): Promise<void> {
  const w = wallet();
  if (!w || !account) return;
  try {
    const data = `0x70a08231${account.slice(2).toLowerCase().padStart(64, "0")}`;
    const raw = (await w.request({ method: "eth_call", params: [{ to: USDC, data }, "latest"] })) as string;
    const balance = Number(BigInt(raw)) / 1e6;
    $("balance").textContent = balance > 0 ? `${balance.toFixed(4)} USDC on Arc. A call costs a fraction of a cent.` : "This wallet has no USDC on Arc. You need a few cents of USDC on Arc mainnet to try a paid call.";
  } catch {
    $("balance").textContent = "";
  }
}

async function connect(): Promise<void> {
  const w = wallet();
  if (!w) {
    $("account").textContent = "No browser wallet found. Install one (MetaMask, Rabby, Coinbase Wallet) and reload.";
    return;
  }
  try {
    const accounts = (await w.request({ method: "eth_requestAccounts" })) as string[];
    account = accounts[0] ?? null;
    // The wallet route asks about an address: now that there is one, make it the visitor's.
    if ($<HTMLSelectElement>("route").value.endsWith("/arc/wallet")) $("route").dispatchEvent(new Event("change"));
    try {
      await w.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC.chainIdHex }] });
    } catch (err) {
      // 4902: the wallet has never heard of Arc. Offer to add it, then it becomes the active chain.
      if ((err as { code?: number }).code === 4902) await w.request({ method: "wallet_addEthereumChain", params: [ARC_PARAMS] });
      else throw err;
    }
    $("account").textContent = account ? short(account) : "";
    $<HTMLButtonElement>("pay").disabled = !account;
    await showBalance();
  } catch (err) {
    $("account").textContent = `Not connected: ${(err as Error).message ?? "request rejected"}`;
  }
}

async function pay(): Promise<void> {
  const w = wallet();
  if (!w || !account) return;
  const button = $<HTMLButtonElement>("pay");
  button.disabled = true;
  $("steps").innerHTML = "";
  $("result-card").classList.add("hidden");
  const query = [...$("route-params").querySelectorAll<HTMLInputElement>("input")]
    .filter((i) => i.value.trim() !== "")
    .map((i) => `${encodeURIComponent(i.name)}=${encodeURIComponent(i.value.trim())}`)
    .join("&");
  const url = `${API_BASE}${$<HTMLSelectElement>("route").value}${query ? `?${query}` : ""}`;
  const started = performance.now();
  let thinking = 0;
  try {
    const first = await fetch(url, { headers: { accept: "application/json" } });
    if (first.status !== 402) throw new Error(`expected 402 Payment Required, got ${first.status}`);
    const header = first.headers.get("PAYMENT-REQUIRED");
    if (!header) throw new Error("the API did not say what it wants to be paid");
    const required = JSON.parse(unb64(header)) as PaymentRequired;
    const accept = required.accepts.find((a) => a.network === ARC.caip2 && a.scheme === "exact");
    if (!accept?.extra?.name || !accept.extra.version) throw new Error("no direct payment option on Arc for this route");
    step(`402: the API asks ${usd(accept.amount)} in USDC, paid to ${short(accept.payTo)}`, "ok");

    const nonce = `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    const authorization = {
      from: account,
      to: accept.payTo,
      value: accept.amount,
      validAfter: "0",
      validBefore: String(Math.floor(Date.now() / 1000) + accept.maxTimeoutSeconds),
      nonce,
    };
    const typed = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      domain: { name: accept.extra.name, version: accept.extra.version, chainId: ARC.chainId, verifyingContract: accept.asset },
      message: authorization,
    };
    const waiting = step("Waiting for your signature in the wallet…");
    const askedAt = performance.now();
    const signature = (await w.request({ method: "eth_signTypedData_v4", params: [account, JSON.stringify(typed)] })) as string;
    thinking = performance.now() - askedAt; // the time you spent reading the wallet is not the rail's
    waiting.textContent = "Signed. That signature can move this amount to this address, once, before it expires.";
    waiting.className = "ok";

    const payload = { x402Version: required.x402Version, resource: required.resource, accepted: accept, payload: { authorization, signature }, ...(required.extensions ? { extensions: required.extensions } : {}) };
    const second = await fetch(url, { headers: { accept: "application/json", "PAYMENT-SIGNATURE": b64(JSON.stringify(payload)) } });
    const took = ((performance.now() - started - thinking) / 1000).toFixed(1);
    const settleHeader = second.headers.get("PAYMENT-RESPONSE");
    const settle = settleHeader ? (JSON.parse(unb64(settleHeader)) as { success?: boolean; transaction?: string }) : null;
    const text = await second.text();

    if (second.ok && settle?.success && settle.transaction) {
      const li = step("", "ok");
      li.append(`Paid and delivered in ${took} s. Settlement: `);
      const a = document.createElement("a");
      a.href = `${EXPLORER}/tx/${settle.transaction}`;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = `${settle.transaction.slice(0, 14)}…`;
      li.append(a, ". You paid no gas.");
    } else if (second.status >= 500) {
      step(`The handler failed with ${second.status}, so the authorization was never used: you were not charged.`, "ok");
    } else {
      step(`Not settled (HTTP ${second.status}). Nothing was charged.`, "bad");
    }
    $("result-sub").textContent = second.ok ? inPlainWords(url, text) : `HTTP ${second.status}`;
    let shown = text;
    try { shown = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not json, show as is */ }
    $("result").textContent = shown.slice(0, 6000);
    $("result-card").classList.remove("hidden");
    void showBalance();
  } catch (err) {
    const e = err as { code?: number; message?: string };
    step(e.code === 4001 ? "You declined the signature. Nothing was signed and nothing was charged." : `Stopped: ${e.message ?? "unknown error"}. Nothing was charged.`, "bad");
  } finally {
    button.disabled = false;
  }
}

$("connect").addEventListener("click", () => void connect());
$("pay").addEventListener("click", () => void pay());
void loadRoutes();
