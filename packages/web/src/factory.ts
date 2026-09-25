/**
 * CRA Factory, the page: four questions in, the steps to run a paying agent out. All of it happens
 * in the browser. The logic, and what it promises about keys, is in factory-config.ts.
 */
import { hostOf, inWords, oneCommand, PRESETS, problems, sellCommand, sellInWords, sellNextSteps, sellProblems, steps, type SellInput, type Client, type FactoryInput, type Network } from "./factory-config.js";
import { initChrome } from "./menu.js";

initChrome();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);

const CLIENTS: Array<{ id: Client; label: string; explain: string }> = [
  { id: "claude-desktop", label: "Claude (desktop app)", explain: "The Claude app on your computer." },
  { id: "claude-code", label: "Claude Code", explain: "Claude in your terminal or editor." },
  { id: "cursor", label: "Cursor", explain: "The Cursor code editor." },
  { id: "terminal", label: "No AI, just a terminal", explain: "You run the payments by hand." },
];
const NETWORKS: Array<{ id: Network; label: string; explain: string }> = [
  { id: "arc", label: "Arc mainnet", explain: "Real USDC. Start with a dollar." },
  { id: "arcTestnet", label: "Arc testnet", explain: "Play money, for trying things out." },
];

let client: Client = "claude-desktop";
let network: Network = "arc";

/** A row of mutually exclusive buttons. Returns a function that marks one as chosen. */
function choices<T extends string>(box: HTMLElement, items: Array<{ id: T; label: string; explain: string }>, pick: (id: T) => void): (id: T | null) => void {
  const buttons = new Map<T, HTMLButtonElement>();
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "choice";
    b.setAttribute("role", "radio");
    const name = document.createElement("b");
    name.textContent = it.label;
    const sub = document.createElement("small");
    sub.textContent = it.explain;
    b.append(name, sub);
    b.addEventListener("click", () => pick(it.id));
    buttons.set(it.id, b);
    box.appendChild(b);
  }
  return (id) => {
    for (const [k, b] of buttons) {
      b.classList.toggle("on", k === id);
      b.setAttribute("aria-checked", String(k === id));
    }
  };
}

function read(): FactoryInput {
  const rate = input("f-rate").value.trim();
  return {
    client,
    network,
    daily: input("f-daily").value.trim(),
    perSeller: input("f-seller").value.trim(),
    perPayment: input("f-payment").value.trim(),
    perMinute: rate === "" ? null : Number(rate),
    allow: [...new Set($<HTMLTextAreaElement>("f-allow").value.split(/[\n,]+/).map(hostOf).filter(Boolean))],
    keyFile: input("f-key").value.trim(),
  };
}

function copyButton(text: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn copy";
  b.textContent = "Copy";
  b.addEventListener("click", () => {
    void navigator.clipboard?.writeText(text).then(
      () => { b.textContent = "Copied"; setTimeout(() => { b.textContent = "Copy"; }, 1500); },
      () => { b.textContent = "Select and copy by hand"; },
    );
  });
  return b;
}

function render(): void {
  const i = read();
  const wrong = problems(i);
  const box = $("problems");
  box.classList.toggle("hidden", wrong.length === 0);
  box.innerHTML = "";
  for (const w of wrong) {
    const p = document.createElement("div");
    p.textContent = w;
    box.appendChild(p);
  }
  $("words").textContent = wrong.length ? "Fix what is listed below and the steps appear." : inWords(i);
  const out = $("steps-out");
  out.innerHTML = "";
  if (wrong.length) return;
  out.appendChild(stepCard("The short way. ", oneCommand(i, DEFAULT_KEY)));
  const after = document.createElement("div");
  after.className = "chart-card wide";
  const afterText = document.createElement("p");
  afterText.className = "sub";
  afterText.textContent = "Then two things the command cannot do for you: send a few dollars of USDC on Arc to the address it prints, and run the deposit line it shows. After that, ask your AI to buy something.";
  after.appendChild(afterText);
  out.appendChild(after);
  const byHand = document.createElement("details");
  byHand.className = "by-hand";
  const summary = document.createElement("summary");
  summary.textContent = "Or do every step by hand, and see exactly what the command does";
  byHand.appendChild(summary);
  steps(i).forEach((s, n) => byHand.appendChild(stepCard(`Step ${n + 1}. `, s)));
  out.appendChild(byHand);
}

function stepCard(prefix: string, s: { title: string; explain: string; code: string; file?: string }): HTMLElement {
  {
    const card = document.createElement("div");
    card.className = "chart-card wide";
    const head = document.createElement("div");
    head.className = "head";
    const titles = document.createElement("div");
    const h = document.createElement("h2");
    h.textContent = `${prefix}${s.title}`;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = s.explain;
    titles.append(h, sub);
    head.append(titles, copyButton(s.code));
    card.appendChild(head);
    if (s.file) {
      const f = document.createElement("p");
      f.className = "sub mono";
      f.textContent = s.file;
      card.appendChild(f);
    }
    const pre = document.createElement("pre");
    pre.className = "json";
    pre.textContent = s.code;
    card.appendChild(pre);
    return card;
  }
}

const markClient = choices($("clients"), CLIENTS, (id) => { client = id; markClient(id); render(); });
const markNetwork = choices($("networks"), NETWORKS, (id) => { network = id; markNetwork(id); render(); });
const markPreset = choices($("presets"), PRESETS.map((p) => ({ id: p.id, label: p.label, explain: p.explain })), (id) => {
  const p = PRESETS.find((x) => x.id === id)!;
  input("f-daily").value = p.values.daily;
  input("f-seller").value = p.values.perSeller;
  input("f-payment").value = p.values.perPayment;
  input("f-rate").value = p.values.perMinute === null ? "" : String(p.values.perMinute);
  $<HTMLTextAreaElement>("f-allow").value = p.values.allow.join("\n");
  markPreset(id);
  render();
});

const home = /Windows/i.test(navigator.userAgent) ? "/home/you" : /Mac/i.test(navigator.userAgent) ? "/Users/you" : "/home/you";
const DEFAULT_KEY = `${home}/.cra-agent/agent.key`;
input("f-key").value = DEFAULT_KEY;
for (const id of ["f-daily", "f-seller", "f-payment", "f-rate", "f-allow", "f-key"]) {
  // A number typed by hand is no longer the preset's.
  $(id).addEventListener("input", () => { if (id !== "f-key") markPreset(null); render(); });
}
markClient(client);
markNetwork(network);
$("presets").querySelector<HTMLButtonElement>("button")?.click();

/* ------------------------------------------------------------------ selling */

let sellNetwork: Network = "arc";

function readSell(): SellInput {
  return {
    target: input("s-target").value.trim(),
    payTo: input("s-payto").value.trim(),
    payToSolana: input("s-solana").value.trim(),
    lightningFile: input("s-lightning").value.trim(),
    lightningFacilitator: input("s-lnfac").checked,
    price: input("s-price").value.trim(),
    name: input("s-name").value.trim(),
    free: $<HTMLTextAreaElement>("s-free").value.split(/[\n,]+/).map((f) => f.trim()).filter(Boolean),
    network: sellNetwork,
    publicUrl: input("s-public").value.trim().replace(/\/+$/, ""),
    browserWallets: input("s-browser").checked,
  };
}

function renderSell(): void {
  const i = readSell();
  const out = $("s-out");
  out.innerHTML = "";
  const box = $("s-problems");
  box.innerHTML = "";
  // Nothing typed yet is not a mistake: say what is needed instead of listing errors.
  if (!i.target || !i.payTo) {
    box.classList.add("hidden");
    $("s-words").textContent = "Fill in the address of your API and your wallet, and the command appears here.";
    return;
  }
  const wrong = sellProblems(i);
  box.classList.toggle("hidden", wrong.length === 0);
  for (const w of wrong) {
    const p = document.createElement("div");
    p.textContent = w;
    box.appendChild(p);
  }
  $("s-words").textContent = wrong.length ? "Fix what is listed below and the command appears." : sellInWords(i);
  if (wrong.length) return;
  out.appendChild(stepCard("", sellCommand(i)));
  sellNextSteps(i).forEach((s, n) => out.appendChild(stepCard(`Then ${n + 1}. `, s)));
}

const markSellNetwork = choices($("s-networks"), NETWORKS, (id) => { sellNetwork = id; markSellNetwork(id); renderSell(); });
markSellNetwork(sellNetwork);
$("s-browser").addEventListener("change", renderSell);
$("s-lnfac").addEventListener("change", renderSell);
for (const id of ["s-target", "s-payto", "s-solana", "s-lightning", "s-price", "s-name", "s-free", "s-public"]) $(id).addEventListener("input", renderSell);

type Mode = "buy" | "sell";
const MODES: Array<{ id: Mode; label: string; explain: string }> = [
  { id: "buy", label: "An agent that buys", explain: "Give your AI a budget and limits it cannot change. It pays for API calls by itself." },
  { id: "sell", label: "An API that sells", explain: "Put a price on an API you already run, without touching its code. Get paid in USDC." },
];
function setMode(mode: Mode): void {
  markMode(mode);
  $("buy-mode").classList.toggle("hidden", mode !== "buy");
  $("sell-mode").classList.toggle("hidden", mode !== "sell");
  if (location.hash !== `#${mode}`) history.replaceState(null, "", `#${mode}`);
  if (mode === "sell") renderSell();
}
const markMode = choices($("modes"), MODES, setMode);
setMode(location.hash === "#sell" ? "sell" : "buy");
window.addEventListener("hashchange", () => setMode(location.hash === "#sell" ? "sell" : "buy"));
