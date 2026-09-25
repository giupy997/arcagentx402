/**
 * An agent that pays for its own thinking.
 *
 * The brain is a pay-per-call LLM bought on Arc, BlockRun's chat completions by default, found in the
 * bazaar like anything else. Every thought is a paid call. Every tool the brain asks for is bought
 * the same way, from the same bazaar. There is no API key anywhere, only the agent's wallet and its
 * spending policy, which applies to thinking exactly as it applies to tools.
 *
 * The brain decides; this loop checks. It can buy only what a search in this session returned, never
 * above the listed price, and never past the session's budget. The rail's own policy still has the
 * last word on every payment, before anything is signed.
 */
import { addUsdc6, compareUsdc6, formatUsdc6, headroomUsdc6, parseUsdc6, usdc6, type Usdc6 } from "@cra-agent/accounting";
import type { Found } from "./search.js";

export const BLOCKRUN_CHAT = "https://nano.blockrun.ai/api/v1/chat/completions";
/**
 * Priced per call from the tokens in and out, with a floor of $0.003. With 6,000 characters of context
 * a thought cost $0.0053 on Haiku 4.5 and $0.012 on Sonnet 4.6 (checked 2026-09-24). Haiku keeps a
 * session in cents and follows the JSON shapes reliably.
 */
export const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";
/** Tool results kept whole in what the brain is sent: older ones become a line, since the brain pays for every character it rereads. */
const KEEP_RESULTS = 2;
const RESULT_CHARS = 2000;

/** One paid call as the loop sees it: what came back, what it cost, and the ledger row that proves it. */
export interface Paid {
  status: number;
  body: string;
  /** What was paid, in USDC; "0" when the call was free or nothing was charged. */
  paidUsdc: string;
  ledgerId: string | null;
  /** Set when the payment was refused before signing (policy or ceiling): nothing was paid. */
  refused: string | null;
  /** The settlement's id when something was paid: a Circle Gateway transfer, or a transaction hash. */
  tx?: string | null;
}

/** The call that is out right now, for anyone watching a run as it happens. */
export type Phase =
  | { kind: "think"; n: number }
  | { kind: "search"; query: string }
  | { kind: "buy"; url: string; method: string; seller: string; priceUsd: string };

export interface ThinkDeps {
  pay(url: string, init: { method: "GET" | "POST"; body?: string }, maxUsdc: string): Promise<Paid>;
  search(query: string): Promise<Found[]>;
  /** One line of the story, as it happens. */
  say(line: string): void;
  /** Each step once it has landed, with its timing: what a recorder keeps. Awaited, so steps arrive in order. */
  onStep?(step: Step): void | Promise<void>;
  /** A call about to go out; null once it is back. */
  onPhase?(phase: Phase | null): void | Promise<void>;
}

export interface ThinkOptions {
  task: string;
  brainUrl: string;
  model: string;
  /** Everything the session may spend, thinking and tools together, in USDC. */
  budgetUsdc: string;
  /** The most one thought may cost, in USDC. The brain's price grows with the tokens asked for. */
  thoughtCeilingUsdc: string;
  maxTokens: number;
  maxSteps: number;
}

export interface Step {
  kind: "think" | "search" | "buy" | "refused";
  detail: string;
  costUsdc: string;
  ledgerId: string | null;
  /** When the step landed, in milliseconds after the task began: a run can be replayed at its own pace. */
  atMs?: number;
  /** How long its call took, in milliseconds. */
  ms?: number;
  /** The settlement's id, when something was paid. */
  tx?: string | null;
  /** buy: what was called, who sold it and what it answered. */
  url?: string;
  method?: string;
  seller?: string;
  status?: number;
  /** search: what was asked, and the first results as the brain saw them. */
  query?: string;
  results?: Array<{ seller: string; what: string; priceUsd: string }>;
}

export interface ThinkResult {
  answer: string | null;
  stoppedBecause: "answered" | "budget" | "steps" | "brain";
  steps: Step[];
  spent: { thinkingUsdc: string; toolsUsdc: string; totalUsdc: string; thoughts: number; purchases: number };
}

interface Action {
  thought?: string;
  action?: string;
  query?: string;
  url?: string;
  body?: unknown;
  text?: string;
}

// A first run answered a question about Arc from memory, with the wrong year and a source it never read: it
// had searched the bazaar for the answer itself, found only data APIs, and never looked for a web search.
const SYSTEM = (budget: string, today: string) => `You are an autonomous agent on Arc, a blockchain where payments are in USDC. Today is ${today}. You have a budget of $${budget} for this whole task, and you pay for everything you use, including every reply you write here: each one costs a fraction of a cent.

Reply with exactly one JSON object and nothing else, in one of these shapes:
{"thought": "<one short sentence>", "action": "search", "query": "<the kind of API you need, in a few words>"}
{"thought": "<one short sentence>", "action": "buy", "url": "<a url from a search result>", "body": {<JSON body, only when the result's method is POST>}}
{"thought": "<one short sentence>", "action": "answer", "text": "<your final answer to the task>"}

Rules:
- search is free. It finds paid APIs on Arc by what they do, not the answer itself: search "web search", "bitcoin price" or "arc gas fees", not the question. It returns their url, method, price, and the parameters they take.
- buy calls one of those APIs and pays its price. You can only buy a url that a search returned. Replace any {placeholder} in it and change example values to what you need.
- Send only the parameters the task needs, with values a parameter's "about" allows: a seller can charge for a request it rejects.
- Your memory ends before today and can be wrong about anything recent. Check dates, news and recent facts by buying a web search.
- Never invent a fact or a source. Name only sources you bought in this task, and say plainly what you could not check.
- Spend as little as the task allows, and answer as soon as you know enough.`;

/** The first JSON object in a reply: models wrap it in prose or code fences often enough to matter. */
export function parseAction(reply: string): Action | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(reply.slice(start, end + 1)) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Action) : null;
  } catch {
    return null;
  }
}

/** The text of an OpenAI-shaped chat completion. */
export function completionText(body: string): string | null {
  try {
    const d = JSON.parse(body) as { choices?: Array<{ message?: { content?: unknown } }> };
    const c = d.choices?.[0]?.message?.content;
    return typeof c === "string" ? c : null;
  } catch {
    return null;
  }
}

/** A search result the way the brain reads it: short, since it pays for every character, with what a call needs. */
function forBrain(f: Found): Record<string, unknown> {
  const small = (v: unknown) => v !== null && v !== undefined && JSON.stringify(v).length <= 120;
  return {
    what: (f.label ?? f.description ?? f.name).slice(0, 120),
    url: f.url,
    method: f.method,
    priceUsd: f.priceUsd,
    seller: f.name,
    // "about" carries what a parameter accepts: without it a brain guesses, and a seller may charge for the guess.
    params: f.params.slice(0, 6).map((p) => ({ name: p.name, in: p.in ?? "query", required: p.required, ...(p.description ? { about: p.description.slice(0, 100) } : {}), ...(small(p.example) ? { example: p.example } : {}) })),
    ...(f.body && JSON.stringify(f.body).length <= 200 ? { exampleBody: f.body } : {}),
  };
}

/** A url the brain asks to buy, matched to a search result: the same one, or the same path with its placeholders and parameters filled. */
export function allowedResult(url: string, found: readonly Found[]): Found | null {
  const exact = found.find((f) => f.url === url);
  if (exact) return exact;
  let asked: URL;
  try {
    asked = new URL(url);
  } catch {
    return null;
  }
  return (
    found.find((f) => {
      try {
        const listed = new URL(f.url.replace(/\{[^}]*\}/g, "_"));
        if (listed.origin !== asked.origin) return false;
        const a = asked.pathname.split("/");
        const l = listed.pathname.split("/");
        return a.length === l.length && l.every((seg, i) => seg === "_" || seg === a[i]);
      } catch {
        return false;
      }
    }) ?? null
  );
}

export async function think(opts: ThinkOptions, deps: ThinkDeps): Promise<ThinkResult> {
  const budget = parseUsdc6(opts.budgetUsdc);
  const ceiling = parseUsdc6(opts.thoughtCeilingUsdc);
  let thinking: Usdc6 = usdc6(0n);
  let tools: Usdc6 = usdc6(0n);
  let thoughts = 0;
  let purchases = 0;
  const steps: Step[] = [];
  const found: Found[] = [];
  const began = Date.now();
  const left = (): Usdc6 => headroomUsdc6(budget, addUsdc6(thinking, tools));
  // Whoever watches the run gets each step in order; a watcher that fails never stops a run that is paying its way.
  const add = async (s: Step): Promise<void> => {
    const stamped = { ...s, atMs: Date.now() - began };
    steps.push(stamped);
    await (async () => deps.onStep?.(stamped))().catch(() => undefined);
  };
  const phase = async (p: Phase): Promise<number> => {
    await (async () => deps.onPhase?.(p))().catch(() => undefined);
    return Date.now();
  };
  // `result` marks what a tool returned: those are the long messages, and only the latest are sent whole.
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string; result?: true }> = [
    { role: "system", content: SYSTEM(opts.budgetUsdc, new Date().toISOString().slice(0, 10)) },
    { role: "user", content: `Task: ${opts.task}` },
  ];
  const toSend = () => {
    const results = messages.filter((m) => m.result);
    const old = new Set(results.slice(0, Math.max(0, results.length - KEEP_RESULTS)));
    return messages.map((m) => ({ role: m.role, content: old.has(m) ? "(an earlier tool result, left out to save cost; it is summed up in your later thoughts)" : m.content }));
  };
  const result = (answer: string | null, stoppedBecause: ThinkResult["stoppedBecause"]): ThinkResult => ({
    answer,
    stoppedBecause,
    steps,
    spent: { thinkingUsdc: formatUsdc6(thinking), toolsUsdc: formatUsdc6(tools), totalUsdc: formatUsdc6(addUsdc6(thinking, tools)), thoughts, purchases },
  });

  let unreadable = 0;
  // What the last thought cost: the next one costs about as much, a little more as the notes grow.
  let lastThought: Usdc6 = usdc6(0n);
  for (let step = 1; step <= opts.maxSteps; step++) {
    if (left() === 0n) return result(null, "budget");
    // A thought may cost up to the ceiling, or whatever is left when that is less: the rail refuses before
    // signing if the brain asks more, so the last cents can still pay for an answer.
    const cap = compareUsdc6(left(), ceiling) < 0 ? left() : ceiling;
    const lastCall = lastThought > 0n && compareUsdc6(left(), usdc6((lastThought * 5n) / 2n)) < 0;
    messages.push({ role: "user", content: `Budget left: $${formatUsdc6(left())}.${lastCall ? " That pays for about one more reply: answer now with what you have." : ""} Reply with one JSON object.` });
    const asked = await phase({ kind: "think", n: thoughts + 1 });
    const paid = await deps.pay(opts.brainUrl, { method: "POST", body: JSON.stringify({ model: opts.model, messages: toSend(), max_tokens: opts.maxTokens }) }, formatUsdc6(cap));
    messages.pop();
    if (paid.refused) {
      await add({ kind: "refused", detail: `thought refused before paying: ${paid.refused}`, costUsdc: "0", ledgerId: paid.ledgerId });
      deps.say(`[${step}] thought refused before paying: ${paid.refused}`);
      return result(null, "budget");
    }
    thinking = addUsdc6(thinking, parseUsdc6(paid.paidUsdc));
    if (parseUsdc6(paid.paidUsdc) > 0n) lastThought = parseUsdc6(paid.paidUsdc);
    thoughts++;
    const reply = paid.status === 200 ? completionText(paid.body) : null;
    const action = reply ? parseAction(reply) : null;
    await add({ kind: "think", detail: action?.thought ?? (reply ?? `the brain answered ${paid.status}`).slice(0, 200), costUsdc: paid.paidUsdc, ledgerId: paid.ledgerId, tx: paid.tx ?? null, ms: Date.now() - asked });
    deps.say(`[${step}] think  $${paid.paidUsdc}  ${action?.thought ? `"${action.thought}"` : reply ? "(no usable JSON)" : `(brain answered ${paid.status})`}`);
    if (!action) {
      // Twice unreadable in a row is a brain that is not following, not a blip.
      if (++unreadable >= 2 || !reply) return result(null, "brain");
      messages.push({ role: "assistant", content: reply }, { role: "user", content: "That was not one JSON object in the shapes given. Reply again with exactly one." });
      continue;
    }
    unreadable = 0;
    messages.push({ role: "assistant", content: JSON.stringify(action) });

    if (action.action === "answer") {
      const text = typeof action.text === "string" ? action.text : "";
      deps.say(`      answer`);
      return result(text, "answered");
    }

    if (action.action === "search") {
      const query = typeof action.query === "string" ? action.query.slice(0, 200) : "";
      const searched = await phase({ kind: "search", query });
      const hits = query ? await deps.search(query).catch(() => [] as Found[]) : [];
      found.push(...hits);
      const shown = hits.slice(0, 5).map(forBrain);
      await add({
        kind: "search",
        detail: `"${query}": ${hits.length} results`,
        costUsdc: "0",
        ledgerId: null,
        query,
        results: hits.slice(0, 5).map((h) => ({ seller: h.name, what: (h.label ?? h.description ?? h.name).slice(0, 120), priceUsd: h.priceUsd })),
        ms: Date.now() - searched,
      });
      deps.say(`      search "${query}" -> ${hits.length} results, free`);
      messages.push({ role: "user", content: `Search results for "${query}": APIs you can buy, not answers. If none of them can answer the task, search for the kind of API that could, like "web search".\n${JSON.stringify(shown)}`, result: true });
      continue;
    }

    if (action.action === "buy") {
      const url = typeof action.url === "string" ? action.url : "";
      const listed = allowedResult(url, found);
      if (!listed) {
        await add({ kind: "refused", detail: `not bought: ${url} was not in a search result`, costUsdc: "0", ledgerId: null });
        deps.say(`      not bought: that url did not come from a search`);
        messages.push({ role: "user", content: "Not bought: you can only buy a url that one of your searches returned. Search first." });
        continue;
      }
      const price = parseUsdc6(listed.priceUsd);
      if (compareUsdc6(price, left()) > 0) {
        await add({ kind: "refused", detail: `not bought: $${listed.priceUsd} is more than the $${formatUsdc6(left())} left`, costUsdc: "0", ledgerId: null, url, seller: listed.name });
        deps.say(`      not bought: $${listed.priceUsd} is more than the budget left`);
        messages.push({ role: "user", content: `Not bought: it costs $${listed.priceUsd} and only $${formatUsdc6(left())} is left. Answer with what you have, or find something cheaper.` });
        continue;
      }
      // Enough has to be left after a purchase to think about what it returned.
      const reserve = usdc6((lastThought * 3n) / 2n);
      if (compareUsdc6(addUsdc6(price, reserve), left()) > 0) {
        await add({ kind: "refused", detail: `not bought: $${listed.priceUsd} would leave too little to answer`, costUsdc: "0", ledgerId: null, url, seller: listed.name });
        deps.say(`      not bought: $${listed.priceUsd} would leave too little to answer`);
        messages.push({ role: "user", content: `Not bought: after paying $${listed.priceUsd}, too little would be left to answer. Answer with what you have.` });
        continue;
      }
      const body = listed.method === "POST" ? JSON.stringify(action.body ?? listed.body ?? {}) : undefined;
      const sent = await phase({ kind: "buy", url, method: listed.method, seller: listed.name, priceUsd: listed.priceUsd });
      // The listed price is the ceiling: a seller that asks more at pay time is refused before signing.
      const bought = await deps.pay(url, { method: listed.method, ...(body === undefined ? {} : { body }) }, listed.priceUsd);
      if (bought.refused || bought.status === 0) {
        const why = bought.refused ?? bought.body.slice(0, 160);
        await add({ kind: "refused", detail: `not bought: ${why}`, costUsdc: "0", ledgerId: bought.ledgerId, url, seller: listed.name });
        deps.say(`      not bought: ${why}`);
        messages.push({ role: "user", content: `Not bought: ${why}` });
        continue;
      }
      tools = addUsdc6(tools, parseUsdc6(bought.paidUsdc));
      purchases++;
      await add({ kind: "buy", detail: `${listed.method} ${url} -> ${bought.status}`, costUsdc: bought.paidUsdc, ledgerId: bought.ledgerId, tx: bought.tx ?? null, url, method: listed.method, seller: listed.name, status: bought.status, ms: Date.now() - sent });
      deps.say(`      buy    $${bought.paidUsdc}  ${listed.method} ${url.length > 70 ? `${url.slice(0, 67)}...` : url} -> ${bought.status}`);
      const failed = bought.status >= 400 ? `, an error: the seller charged for it anyway, so fix the request from what it says before trying again` : "";
      messages.push({ role: "user", content: `Bought ${url} (status ${bought.status}${failed}). Response, cut to ${RESULT_CHARS} characters:\n${bought.body.slice(0, RESULT_CHARS)}`, result: true });
      continue;
    }

    messages.push({ role: "user", content: `Unknown action "${String(action.action)}". Use search, buy or answer.` });
  }
  return result(null, "steps");
}
