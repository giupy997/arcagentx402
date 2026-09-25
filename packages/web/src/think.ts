/**
 * The think page: the agent that pays for its own thinking, shown live while a run is going and
 * replayed at its own pace when none is. Everything in the console comes from the API (/v1/think/*),
 * which reads what `cra-agent think --record` wrote as the run happened; logos come from the bazaar's
 * proxy. Nothing is animated that did not happen: a replay plays the recorded steps at their times.
 */
import { API_BASE, ApiUnavailable, ago, getJson, setNetPill, type Network } from "./api.js";
import { monogram, watchLogos } from "./logos.js";
import { initChrome } from "./menu.js";

initChrome();

type Kind = "think" | "search" | "buy" | "fetch" | "refused";
interface Step {
  kind: Kind;
  detail: string;
  costUsdc: string;
  atMs: number | null;
  ms: number | null;
  tx: string | null;
  url?: string;
  method?: string;
  seller?: string;
  status?: number;
  query?: string;
  results?: Array<{ seller: string; what: string; priceUsd: string }>;
}
interface Spent { thinkingUsdc: string; toolsUsdc: string; totalUsdc: string; thoughts: number; purchases: number }
type Phase = { kind: "think"; n: number } | { kind: "search"; query: string } | { kind: "buy"; url: string; method: string; seller: string; priceUsd: string } | { kind: "fetch"; url: string; method: string; seller: string };
type Status = "running" | "answered" | "budget" | "steps" | "brain" | "failed" | "interrupted";
interface Run {
  id: number;
  agent: string;
  network: string;
  task: string;
  model: string;
  brain: { url: string; name: string | null };
  budgetUsdc: string;
  ceilingUsdc: string;
  policy: { perPaymentCapUsdc?: string; dailyCapUsdc?: string } | null;
  status: Status;
  phase: Phase | null;
  phaseSince: number | null;
  steps: Step[];
  answer: string | null;
  checked: boolean;
  spent: Spent;
  paid: Array<{ seller: string; role: "brain" | "tool"; payments: number; usdc: string }>;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  now: number;
  /** Set on the recorded example the page falls back to before the server has run anything. */
  example?: string;
}
interface RunsList {
  note: string;
  totals: { runs: number; answered: number; spentUsdc: string; thoughts: number; purchases: number };
  runs: Array<{ id: number; task: string; status: Status; answer: string | null; checked: boolean; spent: Spent; startedAt: number; finishedAt: number | null; sellers: string[] }>;
}
interface Bazaar { sellers: Array<{ name: string; source: string; logo: string | null }>; networks?: Array<{ id: string; name: string; logo?: string | null }> }

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string | null | undefined) => (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ small formats

/** Money as the API sends it, in micro-USDC for adding up without floating point. */
const micro = (usd: string): number => {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(usd);
  return m ? Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0")) : 0;
};
const usd = (u: number): string => `$${(u / 1_000_000).toFixed(6).replace(/\.?0+$/, "") || "0"}`;
const modelName = (m: string) => (m.split("/").pop() ?? m).split("-").map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const shortTx = (t: string) => (t.startsWith("0x") ? `${t.slice(0, 10)}…` : t.slice(0, 8));
const shortUrl = (u: string | undefined) => {
  if (!u) return "";
  try {
    const x = new URL(u);
    const q = x.search.length > 24 ? "?…" : x.search;
    return `${x.host}${x.pathname}${q}`;
  } catch {
    return u;
  }
};
const clockOf = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const OUTCOME: Record<Status, string> = {
  running: "running",
  answered: "answered",
  budget: "budget spent",
  steps: "out of steps",
  brain: "brain lost the thread",
  failed: "failed",
  interrupted: "interrupted",
};

// ------------------------------------------------------------------ logos

const logoPath = new Map<string, string | null>();
let arcLogo: string | null = null;

function logo(name: string | null | undefined, size = ""): string {
  const n = name ?? "?";
  if (/^CRA AGENT/i.test(n)) return `<span class="b-logo ${size}"><img src="/brand/logo-96.png" alt=""></span>`;
  const path = logoPath.get(n);
  if (!path) return `<span class="b-logo ${size} failed">${monogram(n)}</span>`;
  return `<span class="b-logo ${size}"><img src="${esc(API_BASE + path)}" alt="" decoding="async">${monogram(n)}</span>`;
}

/** Free public APIs the agent calls: not sellers in the bazaar, but their logo comes the same way. */
const FREE_TOOL_SITES: Record<string, string> = { DexScreener: "https://dexscreener.com" };
for (const [name, site] of Object.entries(FREE_TOOL_SITES)) logoPath.set(name, `/v1/bazaar/logo?site=${encodeURIComponent(site)}`);

async function loadLogos(): Promise<void> {
  const b = await getJson<Bazaar>("/v1/bazaar").catch(() => null);
  if (!b) return;
  for (const s of b.sellers) logoPath.set(s.name, s.logo);
  arcLogo = b.networks?.find((n) => n.id === "eip155:5042")?.logo ?? null;
  const tools = [...new Map(b.sellers.filter((s) => !/blockrun/i.test(s.name)).map((s) => [s.name, s])).values()].slice(0, 6);
  $("t-cast").innerHTML =
    `<span class="grp"><span>Brain</span>${logo("BlockRun.AI", "sm")}<b>BlockRun</b></span>` +
    `<span class="grp"><span>Tools</span>${tools.map((s) => logo(s.name, "sm")).join("")}<b>the bazaar</b></span>` +
    `<span class="grp"><span>Paid in</span>${arcLogo ? `<span class="b-logo sm"><img src="${esc(API_BASE + arcLogo)}" alt=""></span>` : ""}<b>USDC on Arc</b></span>`;
  watchLogos($("t-cast"));
}

// ------------------------------------------------------------------ the console

let shown: Run | null = null;
let onScreen = 0;
let mode: "live" | "replay" | "done" | "empty" = "empty";
let picked = false;
let timers: number[] = [];
let clockTimer: number | undefined;
let skew = 0; // server clock minus ours, in seconds

function brainLabel(run: Run): string {
  return run.brain.name ?? "the brain";
}

function frame(run: Run): void {
  shown = run;
  onScreen = 0;
  stick = true;
  consoleBody().scrollTop = 0;
  $("t-steps").innerHTML = "";
  $("t-golive").classList.add("hidden");
  $("t-answer").className = "t-answer hidden";
  $("t-empty").classList.add("hidden");
  $("t-now").classList.add("hidden");
  $("t-cmd").innerHTML = `<span class="p">$</span>cra-agent think <span class="q">"${esc(run.task)}"</span>`;
  const policy = run.policy ?? {};
  $("t-meta").innerHTML =
    `<dt>Brain</dt><dd>${esc(modelName(run.model))}, bought per thought from ${esc(brainLabel(run))}</dd>` +
    `<dt>Budget</dt><dd>$${esc(run.budgetUsdc)} for thinking and tools · at most $${esc(run.ceilingUsdc)} a thought</dd>` +
    `<dt>Wallet</dt><dd><span title="${esc(run.agent)}">${esc(shortAddr(run.agent))}</span>${policy.perPaymentCapUsdc ? ` · its policy: $${esc(policy.perPaymentCapUsdc)} a payment${policy.dailyCapUsdc ? `, $${esc(policy.dailyCapUsdc)} a day` : ""}` : ""}</dd>`;
  bill(run, 0);
  $("t-paid").innerHTML = "";
  for (const tr of document.querySelectorAll<HTMLTableRowElement>("#t-history tr[data-id]")) tr.classList.toggle("on", Number(tr.dataset.id) === run.id);
}

function state(kind: "live" | "replay" | "done" | "example" | "loading", run: Run | null): void {
  const el = $("t-state");
  el.className = `t-state ${kind}`;
  const label = $("t-state-label");
  const when = $("t-when");
  if (kind === "live") label.textContent = `Live · run ${run?.id ?? ""}`;
  else if (kind === "replay") label.textContent = `Replay · run ${run?.id ?? ""}`;
  else if (kind === "example") label.textContent = "Example run";
  else if (kind === "done") label.textContent = `Run ${run?.id ?? ""} · ${OUTCOME[run?.status ?? "answered"]}`;
  else label.textContent = "Loading";
  // Live, the clock says how long it has been going; otherwise, when it happened.
  when.textContent = !run || kind === "live" ? "" : run.example ? run.example : `recorded ${ago(run.startedAt - skew)}`;
  $("t-replay").classList.toggle("hidden", !((kind === "done" || (kind === "example" && mode === "done")) && run !== null && run.steps.length > 0));
  $("t-skip").classList.toggle("hidden", !(kind === "replay" || (kind === "example" && mode === "replay")));
}

function stepHtml(run: Run, s: Step, index: number): string {
  const thought = run.steps.slice(0, index + 1).filter((x) => x.kind === "think").length;
  const n = s.kind === "think" ? String(thought).padStart(2, "0") : "";
  // A seller that fails is not paid: x402 settles only after it answers.
  const charged = micro(s.costUsdc) > 0;
  const cost = s.kind === "search" || s.kind === "fetch" ? `<span class="cost free">free</span>` : s.kind === "refused" ? `<span class="cost free">·</span>` : s.kind === "buy" && !charged ? `<span class="cost free">$0</span>` : `<span class="cost">$${esc(s.costUsdc)}</span>`;
  const sub: string[] = [];
  let txt = "";
  if (s.kind === "think") {
    txt = `“${esc(s.detail)}”`;
    sub.push(`${logo(run.brain.name, "xs")}paid ${esc(brainLabel(run))}`);
  } else if (s.kind === "search") {
    const count = /(\d+) results$/.exec(s.detail)?.[1];
    txt = `the bazaar for “${esc(s.query ?? s.detail)}”${count ? ` <span class="dim">→ ${count} APIs</span>` : ""}`;
    // What the brain was shown, by seller: "Exa $0.007", or "CRA AGENT data ×5 from $0.0005".
    const bySeller = new Map<string, { n: number; min: number; price: string }>();
    for (const r of s.results ?? []) {
      const g = bySeller.get(r.seller) ?? { n: 0, min: Number.POSITIVE_INFINITY, price: r.priceUsd };
      g.n++;
      if (micro(r.priceUsd) < g.min) [g.min, g.price] = [micro(r.priceUsd), r.priceUsd];
      bySeller.set(r.seller, g);
    }
    if (bySeller.size) sub.push([...bySeller].map(([seller, g]) => `${logo(seller, "xs")}${esc(seller)}${g.n > 1 ? ` ×${g.n}` : ""} <span class="price">${g.n > 1 ? "from " : ""}$${esc(g.price)}</span>`).join('<i class="sep">·</i>'));
  } else if (s.kind === "fetch") {
    txt = `${esc(s.method ?? "")} ${esc(shortUrl(s.url))} <span class="dim">→ ${s.status ?? ""}</span>`;
    sub.push(`${logo(s.seller, "xs")}${esc(s.seller ?? "a public API")}, free public API: nothing paid`);
  } else if (s.kind === "buy") {
    txt = `${esc(s.method ?? "")} ${esc(shortUrl(s.url))} <span class="dim">→ ${s.status ?? ""}</span>`;
    sub.push(charged ? `${logo(s.seller, "xs")}paid ${esc(s.seller ?? "the seller")}` : `${logo(s.seller, "xs")}${esc(s.seller ?? "the seller")} failed, not charged`);
  } else {
    txt = esc(s.detail);
  }
  if (s.tx) sub.push(`settled <span class="tx" title="${esc(s.tx)}">${esc(shortTx(s.tx))}</span>`);
  if (s.ms && s.kind !== "search") sub.push(`${(s.ms / 1000).toFixed(1)}s`);
  const label = s.kind;
  return `<li class="t-step ${s.kind}"><span class="n">${n}</span><span class="k">${label}</span>${cost}<span class="txt">${txt}</span>${sub.length ? `<span class="sub">${sub.join('<i class="sep">·</i>')}</span>` : ""}</li>`;
}

/** Puts the run's steps up to `upTo` on screen, each fading in, and keeps the newest in view while it runs. */
function show(run: Run, upTo: number): void {
  const list = $("t-steps");
  while (onScreen < Math.min(upTo, run.steps.length)) {
    list.insertAdjacentHTML("beforeend", stepHtml(run, run.steps[onScreen]!, onScreen));
    const li = list.lastElementChild as HTMLElement;
    watchLogos(li);
    if (calm) li.classList.add("on");
    else requestAnimationFrame(() => requestAnimationFrame(() => li.classList.add("on")));
    onScreen++;
  }
  bill(run, onScreen);
  follow();
}

function phaseHtml(run: Run, p: Phase): string {
  if (p.kind === "think") return `<span class="n">${String(p.n).padStart(2, "0")}</span><span class="k">think</span><span class="cost">…</span><span class="txt">paying ${esc(brainLabel(run))} for thought ${p.n}<span class="spin"></span></span>`;
  if (p.kind === "search") return `<span class="n"></span><span class="k">search</span><span class="cost free">free</span><span class="txt">searching the bazaar for “${esc(p.query)}”<span class="spin"></span></span>`;
  if (p.kind === "fetch") return `<span class="n"></span><span class="k">fetch</span><span class="cost free">free</span><span class="txt">calling ${esc(p.method)} ${esc(shortUrl(p.url))} from ${esc(p.seller)}<span class="spin"></span></span>`;
  return `<span class="n"></span><span class="k">buy</span><span class="cost">$${esc(p.priceUsd)}</span><span class="txt">buying ${esc(p.method)} ${esc(shortUrl(p.url))} from ${esc(p.seller)}<span class="spin"></span></span>`;
}

function phase(run: Run, p: Phase | null): void {
  const el = $("t-now");
  if (!p) {
    el.classList.add("hidden");
    return;
  }
  el.innerHTML = phaseHtml(run, p);
  el.classList.remove("hidden");
  follow();
}

/** The bill so far: from the steps on screen, so a replay adds up as it plays. */
function bill(run: Run, upTo: number): void {
  let thinking = 0;
  let tools = 0;
  let thoughts = 0;
  let bought = 0;
  for (const s of run.steps.slice(0, upTo)) {
    if (s.kind === "think") {
      thinking += micro(s.costUsdc);
      thoughts++;
    } else if (s.kind === "buy" && micro(s.costUsdc) > 0) {
      tools += micro(s.costUsdc);
      bought++;
    }
  }
  const budget = micro(run.budgetUsdc) || 1;
  const [th, tl] = [...$("t-meter").children] as HTMLElement[];
  th!.style.width = `${Math.min(100, (thinking / budget) * 100)}%`;
  tl!.style.width = `${Math.min(100 - Math.min(100, (thinking / budget) * 100), (tools / budget) * 100)}%`;
  $("t-bill").innerHTML =
    `<span>Spent <b>${usd(thinking + tools)}</b> of $${esc(run.budgetUsdc)}</span>` +
    `<span class="th">Thinking <b>${usd(thinking)}</b> · ${thoughts} ${thoughts === 1 ? "thought" : "thoughts"}</span>` +
    `<span class="tl">Tools <b>${usd(tools)}</b> · ${bought} ${bought === 1 ? "purchase" : "purchases"}</span>`;
}

function paid(run: Run): void {
  $("t-paid").innerHTML = run.paid.length
    ? `<span class="lbl">Paid</span>${run.paid
        .map((p) => `<span class="t-payee">${logo(p.seller, "sm")}<span><b>${esc(p.seller)}</b><small>${p.role === "brain" ? `${p.payments} ${p.payments === 1 ? "thought" : "thoughts"}` : `${p.payments} ${p.payments === 1 ? "call" : "calls"}`} · $${esc(p.usdc)}</small></span></span>`)
        .join("")}`
    : "";
  watchLogos($("t-paid"));
}

function end(run: Run): void {
  phase(run, null);
  show(run, run.steps.length);
  const box = $("t-answer");
  if (run.answer !== null && run.status === "answered") {
    const what = run.steps.filter((s) => s.kind === "buy").map((s) => s.seller ?? "a seller");
    box.className = `t-answer${run.checked ? "" : " unchecked"}`;
    box.innerHTML = `<div class="lbl">Answer<span>${run.checked ? `from what it bought: ${esc([...new Set(what)].join(", "))}` : "nothing was bought: the model's own answer, not checked"}</span></div><p>${esc(run.answer)}</p>`;
  } else {
    box.className = "t-answer unchecked";
    box.innerHTML = `<div class="lbl">No answer<span>${esc(OUTCOME[run.status])}</span></div><p>${run.status === "budget" ? "The budget could not pay for another thought, so the agent stopped." : run.status === "steps" ? "It ran out of steps before it knew enough." : run.status === "interrupted" ? "The run stopped without finishing: its process went away." : esc(run.error ?? "The run ended without an answer.")}</p>`;
  }
  requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add("on")));
  paid(run);
  follow();
}

// The console scrolls itself to the newest line, unless the reader has scrolled up in it to read.
let stick = true;
let autoScrolling = 0;
const consoleBody = () => $("t-body");
consoleBody().addEventListener("scroll", () => {
  if (Date.now() < autoScrolling) return;
  const b = consoleBody();
  stick = b.scrollTop + b.clientHeight >= b.scrollHeight - 40;
}, { passive: true });
function follow(): void {
  if (!stick) return;
  const b = consoleBody();
  if (b.scrollHeight <= b.clientHeight) return;
  autoScrolling = Date.now() + 900;
  b.scrollTo({ top: b.scrollHeight, behavior: calm ? "auto" : "smooth" });
}

function stopTimers(): void {
  for (const t of timers) clearTimeout(t);
  timers = [];
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = undefined;
}

function runClock(fromMs: () => number): void {
  if (clockTimer) clearInterval(clockTimer);
  const tick = () => ($("t-clock").textContent = clockOf(fromMs()));
  tick();
  clockTimer = window.setInterval(tick, 250);
}

// ------------------------------------------------------------------ live, replay, done

async function live(run: Run): Promise<void> {
  stopTimers();
  mode = "live";
  frame(run);
  state("live", run);
  runClock(() => Date.now() - (run.startedAt - skew) * 1000);
  let current = run;
  show(current, current.steps.length);
  phase(current, current.phase);
  while (mode === "live" && shown?.id === run.id) {
    await new Promise((r) => setTimeout(r, 1000));
    if (mode !== "live" || shown?.id !== run.id) return;
    const next = await getJson<{ run: Run }>(`/v1/think/runs/${run.id}`).then((x) => x.run).catch(() => null);
    if (!next) continue;
    current = next;
    shown = next;
    show(next, next.steps.length);
    if (next.status === "running") phase(next, next.phase);
    else {
      mode = "done";
      stopTimers();
      $("t-clock").textContent = clockOf(((next.finishedAt ?? next.now) - next.startedAt) * 1000);
      end(next);
      state("done", next);
      void loadHistory();
      idle();
      return;
    }
  }
}

/** Plays a finished run at the pace it happened: each call's phase, then its step when it landed. */
function replay(run: Run): void {
  stopTimers();
  mode = "replay";
  frame(run);
  state(run.example ? "example" : "replay", run);
  if (calm) {
    done(run);
    return;
  }
  const times = run.steps.map((s, i) => s.atMs ?? (i + 1) * 1500);
  const began = performance.now();
  runClock(() => performance.now() - began);
  let thought = 0;
  run.steps.forEach((s, i) => {
    const prev = i === 0 ? 0 : times[i - 1]!;
    let p: Phase | null = null;
    if (s.kind === "think") p = { kind: "think", n: ++thought };
    else if (s.kind === "search") p = { kind: "search", query: s.query ?? "" };
    else if (s.kind === "buy") p = { kind: "buy", url: s.url ?? "", method: s.method ?? "", seller: s.seller ?? "", priceUsd: s.costUsdc };
    else if (s.kind === "fetch") p = { kind: "fetch", url: s.url ?? "", method: s.method ?? "", seller: s.seller ?? "" };
    if (p) {
      const shownPhase = p;
      timers.push(window.setTimeout(() => phase(run, shownPhase), prev + 200));
    }
    timers.push(window.setTimeout(() => {
      phase(run, null);
      show(run, i + 1);
    }, Math.max(times[i]!, prev + 400)));
  });
  const last = Math.max(times.at(-1) ?? 0, 0);
  timers.push(window.setTimeout(() => done(run), last + 700));
}

function done(run: Run): void {
  stopTimers();
  mode = "done";
  frame(run);
  end(run);
  const took = run.finishedAt ? (run.finishedAt - run.startedAt) * 1000 : run.steps.at(-1)?.atMs ?? 0;
  $("t-clock").textContent = clockOf(took);
  state(run.example ? "example" : "done", run);
}

function empty(message: string): void {
  stopTimers();
  mode = "empty";
  $("t-cmd").innerHTML = "";
  $("t-meta").innerHTML = "";
  $("t-empty").innerHTML = `${esc(message)}<span class="spin"></span>`;
  $("t-empty").classList.remove("hidden");
  state("loading", null);
  $("t-state-label").textContent = "No run yet";
}

// While nothing is live, look for a new run now and then; switch to it unless a past one was picked.
let idleTimer: number | undefined;
function idle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = window.setTimeout(async () => {
    const latest = await getJson<{ run: Run | null }>("/v1/think/latest").then((x) => x.run).catch(() => null);
    if (latest && latest.status === "running" && latest.id !== shown?.id) {
      if (!picked) {
        skew = latest.now - Date.now() / 1000;
        void live(latest);
        void loadHistory();
        return;
      }
      $("t-golive").classList.remove("hidden");
    }
    idle();
  }, document.hidden ? 15_000 : 4000);
}

// ------------------------------------------------------------------ history

async function loadHistory(): Promise<void> {
  const list = await getJson<RunsList>("/v1/think/runs?limit=20").catch(() => null);
  const body = $("t-history");
  if (!list) {
    body.innerHTML = `<tr><td colspan="6" class="empty">Nothing to list yet: the history comes from our server's API.</td></tr>`;
    return;
  }
  $("t-note").textContent = list.note;
  const t = list.totals;
  $("t-history-sub").textContent = t.runs
    ? `${t.runs} ${t.runs === 1 ? "run" : "runs"} so far: ${t.thoughts} ${t.thoughts === 1 ? "thought" : "thoughts"} and ${t.purchases} ${t.purchases === 1 ? "purchase" : "purchases"}, $${t.spentUsdc} in all. Pick one to replay it.`
    : "No run has been recorded here yet.";
  body.innerHTML = list.runs.length
    ? list.runs
        .map(
          (r) => `<tr data-id="${r.id}" class="${r.id === shown?.id ? "on" : ""}" tabindex="0">
            <td class="mono">${esc(ago(r.startedAt))}</td>
            <td class="q">${esc(r.task)}</td>
            <td><span class="t-outcome ${r.status}">${esc(OUTCOME[r.status])}</span>${r.status === "answered" && !r.checked ? ' <span class="tag">unchecked</span>' : ""}</td>
            <td class="num">${r.spent.thoughts}</td>
            <td class="num">${r.sellers.filter((s) => !/blockrun/i.test(s)).length ? esc([...new Set(r.sellers.filter((s) => !/blockrun/i.test(s)))].join(", ")) : "·"}</td>
            <td class="num mono">$${esc(r.spent.totalUsdc)}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="6" class="empty">No run yet.</td></tr>`;
  for (const tr of body.querySelectorAll<HTMLTableRowElement>("tr[data-id]")) {
    const open = () => void pick(Number(tr.dataset.id));
    tr.addEventListener("click", open);
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
  }
}

async function pick(id: number): Promise<void> {
  const run = await getJson<{ run: Run }>(`/v1/think/runs/${id}`).then((x) => x.run).catch(() => null);
  if (!run) return;
  picked = true;
  setRunInUrl(id);
  skew = run.now - Date.now() / 1000;
  document.getElementById("t-live")?.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" });
  if (run.status === "running") void live(run);
  else replay(run);
}

function setRunInUrl(id: number | null): void {
  const url = new URL(location.href);
  if (id === null) url.searchParams.delete("run");
  else url.searchParams.set("run", String(id));
  window.history.replaceState(null, "", url);
}

// ------------------------------------------------------------------ start

$("t-replay").addEventListener("click", () => shown && replay(shown));
$("t-skip").addEventListener("click", () => shown && done(shown));
$("t-golive").addEventListener("click", async () => {
  const latest = await getJson<{ run: Run | null }>("/v1/think/latest").then((x) => x.run).catch(() => null);
  if (!latest || latest.status !== "running") return;
  picked = false;
  setRunInUrl(null);
  skew = latest.now - Date.now() / 1000;
  void live(latest);
});
for (const a of document.querySelectorAll<HTMLAnchorElement>("a[data-api]")) a.href = `${API_BASE}${a.getAttribute("href")}`;

async function start(): Promise<void> {
  state("loading", null);
  // Logos first, briefly: a replay drawn before them would show initials in place of every seller.
  const logos = loadLogos().then(() => {
    if (shown && mode === "done") done(shown);
  });
  void getJson<Network>("/v1/network").then((n) => setNetPill(n)).catch(() => setNetPill(null, true));
  const asked = Number(new URL(location.href).searchParams.get("run"));
  let run: Run | null = null;
  let apiDown = false;
  try {
    if (Number.isSafeInteger(asked) && asked > 0) {
      run = await getJson<{ run: Run }>(`/v1/think/runs/${asked}`).then((x) => x.run).catch(() => null);
      picked = run !== null;
    }
    if (!run) run = (await getJson<{ run: Run | null }>("/v1/think/latest")).run;
  } catch (err) {
    apiDown = true;
    if (!(err instanceof ApiUnavailable)) console.warn(err);
  }
  if (run) skew = run.now - Date.now() / 1000;
  await Promise.race([logos, new Promise((r) => setTimeout(r, 1500))]);
  void loadHistory();
  if (run && run.status === "running") {
    void live(run);
    return;
  }
  if (run) {
    replay(run);
    idle();
    return;
  }
  // Nothing recorded on this server yet: play the run we recorded while building this page, and say so.
  const example = await fetch("/think-example.json").then((r) => (r.ok ? (r.json() as Promise<Run>) : null)).catch(() => null);
  if (example) {
    skew = 0;
    replay(example);
  } else empty(apiDown ? "The agent's runs are read from the API, which did not answer." : "No run yet. This console goes live as soon as the agent starts one.");
  if (!apiDown) idle();
}

void start();
