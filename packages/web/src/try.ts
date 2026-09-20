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
interface RouteInfo { route: string; summary: string; label?: string; explain?: string; priceUsd?: string; params: Array<{ name: string; example?: string | number }>; alwaysFails: boolean }

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

async function loadRoutes(): Promise<void> {
  const sel = $<HTMLSelectElement>("route");
  try {
    const res = await fetch(`${API_BASE}/v1/direct`);
    const info = (await res.json()) as { settlement: string; routes?: RouteInfo[] };
    if (info.settlement !== "direct" || !info.routes) throw new Error("direct settlement is off on this API");
    for (const r of info.routes) {
      const path = r.route.replace("GET ", "");
      const query = r.params.filter((p) => p.example !== undefined).map((p) => `${p.name}=${encodeURIComponent(String(p.example))}`).join("&");
      const opt = document.createElement("option");
      opt.value = query ? `${path}?${query}` : path;
      opt.textContent = `${r.label ?? r.summary}${r.priceUsd && !r.alwaysFails ? `, $${r.priceUsd}` : ""}`;
      explain.set(opt.value, `${r.explain ?? r.summary}${r.priceUsd ? (r.alwaysFails ? " It would cost nothing even if it worked differently: a failed call is never charged." : ` Costs $${r.priceUsd}.`) : ""}`);
      sel.appendChild(opt);
    }
    // Lead with the one people understand at a glance.
    const fx = [...sel.options].find((o) => o.value.includes("/fx/execution"));
    if (fx) sel.value = fx.value;
    const show = () => { $("route-note").textContent = explain.get(sel.value) ?? ""; };
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
  const url = `${API_BASE}${$<HTMLSelectElement>("route").value}`;
  const started = performance.now();
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
    const signature = (await w.request({ method: "eth_signTypedData_v4", params: [account, JSON.stringify(typed)] })) as string;
    waiting.textContent = "Signed. That signature can move this amount to this address, once, before it expires.";
    waiting.className = "ok";

    const payload = { x402Version: required.x402Version, resource: required.resource, accepted: accept, payload: { authorization, signature }, ...(required.extensions ? { extensions: required.extensions } : {}) };
    const second = await fetch(url, { headers: { accept: "application/json", "PAYMENT-SIGNATURE": b64(JSON.stringify(payload)) } });
    const took = ((performance.now() - started) / 1000).toFixed(1);
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
    $("result-sub").textContent = `HTTP ${second.status}`;
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
