/**
 * Check a spend receipt in the browser.
 *
 * The checks are the router's own (packages/router/src/receipt.ts), bundled into /js/receipt-check.js: the wallet
 * key's signature, the arithmetic of the limits, the post-quantum signature, and then Arc's answer on that last
 * one, asked with a read-only call from this page straight to an Arc endpoint. The receipt is never sent to us.
 */
import { initChrome } from "./menu.js";

initChrome();

interface Check { ok: boolean; detail: string }
interface Report { wallet: Check; limits: Check; postQuantum: Check | null; arc: (Check & { answered: boolean; endpoint: string | null }) | null; valid: boolean }
interface Signed { domain: { chainId: number }; message: Record<string, string>; postQuantum?: { scheme: string; publicKey: string; signature: string } }
interface Checker {
  findSignedReceipt(raw: unknown): Signed | null;
  inspectReceipt(signed: Signed, opts: { arcRpcUrls: readonly string[] }): Promise<Report>;
}

// Public Arc endpoints that answer a browser. Tried in order; any one of them is Arc.
const ARC_RPCS: Record<number, readonly string[]> = {
  5042: ["https://rpc.blockdaemon.mainnet.arc.io", "https://rpc.drpc.mainnet.arc.io", "https://rpc.mainnet.arc.io", "https://rpc.quicknode.mainnet.arc.io"],
  5042002: ["https://rpc.testnet.arc.network"],
};
const EXPLORER: Record<number, string> = { 5042: "https://explorer.arc.io" };

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};

/** USDC base units as dollars, exact: "21300" is $0.0213. */
function usdc(units: string | undefined): string {
  if (!units || !/^\d+$/.test(units)) return "?";
  const whole = units.length > 6 ? units.slice(0, -6) : "0";
  const frac = units.padStart(7, "0").slice(-6).replace(/0+$/, "");
  return `$${whole}${frac ? `.${frac}` : ""}`;
}

let checker: Promise<Checker> | null = null;
/** The bundle is the only heavy thing on the page, so it is fetched when someone first checks a receipt. */
function loadChecker(): Promise<Checker> {
  const url = "/js/receipt-check.js";
  checker ??= import(url) as Promise<Checker>;
  return checker;
}

function say(text: string, bad = false): void {
  const s = $("v-status");
  s.textContent = text;
  s.style.color = bad ? "#b3261e" : "";
}

function line(title: string, check: Check | null, absent: string): HTMLLIElement {
  const li = el("li");
  li.className = check === null ? "" : check.ok ? "ok" : "bad";
  li.append(el("b", `${check === null ? "–" : check.ok ? "✓" : "✗"} ${title}`), el("br"), el("span", check === null ? absent : check.detail));
  return li;
}

function facts(signed: Signed): void {
  const m = signed.message;
  const chain = Number(signed.domain.chainId);
  const rows: Array<[string, string, string?]> = [
    ["Agent", m.agent ?? "?"],
    ["Paid for", m.resource ?? "?"],
    ["Paid to", m.payTo ?? "?"],
    ["Network", m.network ?? "?"],
    ["Amount", usdc(m.amount)],
    ["Status", m.status ?? "?"],
    ["Settlement", m.settlementId || "none", /^0x[0-9a-fA-F]{64}$/.test(m.settlementId ?? "") && EXPLORER[chain] ? `${EXPLORER[chain]}/tx/${m.settlementId}` : undefined],
    ["Limits in force", `${usdc(m.perPaymentCap)} a payment · ${usdc(m.dailyCap)} a day · ${usdc(m.perSellerCap)} a seller a day`],
    ["Spent before this", `${usdc(m.spentTodayBefore)} that day · ${usdc(m.spentWithSellerBefore)} with this seller`],
    ["Issued", /^\d+$/.test(m.issuedAt ?? "") ? new Date(Number(m.issuedAt) * 1000).toISOString().replace(".000Z", " UTC").replace("T", " ") : "?"],
  ];
  const table = el("table", undefined, "data");
  for (const [k, v, href] of rows) {
    const tr = el("tr");
    const td = el("td", undefined, "mono");
    if (href) {
      const a = el("a", v);
      a.href = href;
      a.rel = "noopener";
      td.append(a);
    } else td.textContent = v;
    td.style.wordBreak = "break-all";
    tr.append(el("th", k), td);
    table.append(tr);
  }
  $("v-facts").replaceChildren(table);
}

async function check(): Promise<void> {
  const text = $<HTMLTextAreaElement>("v-input").value.trim();
  $("v-result").classList.add("hidden");
  $("v-facts-card").classList.add("hidden");
  if (!text) return say("Paste a receipt first, or load the sample.", true);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return say("That is not JSON. Paste the receipt as cra-agent printed it.", true);
  }
  say("Checking…");
  $<HTMLButtonElement>("v-check").disabled = true;
  try {
    const lib = await loadChecker();
    const signed = lib.findSignedReceipt(raw);
    if (!signed) return say("There is no signed receipt in that JSON: it needs a domain, a message and a signature.", true);
    const chain = Number(signed.domain.chainId);
    const report = await lib.inspectReceipt(signed, { arcRpcUrls: ARC_RPCS[chain] ?? [] });
    const arcHost = report.arc?.endpoint ? new URL(report.arc.endpoint).host : null;
    const arc: Check | null = report.arc && { ok: report.arc.ok, detail: arcHost ? `${report.arc.detail} (asked ${arcHost}, a read-only call to 0x1800…0004)` : report.arc.detail };
    $("v-checks").replaceChildren(
      line("Wallet signature (secp256k1)", report.wallet, ""),
      line("Limits", report.limits, ""),
      line("Post-quantum signature (SLH-DSA-SHA2-128s)", report.postQuantum, "this receipt has none: it is signed once, by the wallet key"),
      line("Arc's own check of the post-quantum signature", arc, report.postQuantum ? (ARC_RPCS[chain] ? "not asked: the signature above does not hold" : "not asked: this receipt is not for Arc mainnet or testnet") : "nothing to ask Arc about"),
    );
    const verdict = $("v-verdict");
    verdict.textContent = report.valid ? (report.postQuantum ? (report.arc?.answered ? "Valid: both signatures hold, and Arc agrees." : "Valid: both signatures hold. Arc could not be reached to confirm.") : "Valid, signed once.") : "Not valid.";
    verdict.style.color = report.valid ? "var(--good)" : "#b3261e";
    $("v-result").classList.remove("hidden");
    facts(signed);
    $("v-facts-card").classList.remove("hidden");
    say("");
  } catch (err) {
    say(`Could not check it: ${(err as Error).message.slice(0, 160)}`, true);
  } finally {
    $<HTMLButtonElement>("v-check").disabled = false;
  }
}

async function sample(): Promise<void> {
  say("Loading the sample…");
  try {
    const res = await fetch("/receipt-sample.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    $<HTMLTextAreaElement>("v-input").value = await res.text();
    await check();
  } catch (err) {
    say(`The sample did not load: ${(err as Error).message}`, true);
  }
}

$("v-check").addEventListener("click", () => void check());
$("v-sample").addEventListener("click", () => void sample());
// A link to the page with the sample already checked: cra-agent.tech/verify#sample
const fromLink = (): void => void (location.hash === "#sample" && sample());
window.addEventListener("hashchange", fromLink);
fromLink();
