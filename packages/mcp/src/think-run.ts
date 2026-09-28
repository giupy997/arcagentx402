/**
 * The thinking agent wired to a rail: where its brain is found, how it pays, and what its searches may
 * show it. Shared by the `think` command and by the worker that runs it for buyers (think-worker.ts).
 */
import type { SpendPolicy } from "@cra-agent/policy";
import { PolicyRejected, type Rail } from "@cra-agent/router";
import { digestFree, freeTools, isFree, wantsWeb } from "./free-tools.js";
import { fit, NOTHING_SPENT, searchMarket, type Found } from "./search.js";
import { BLOCKRUN_CHAT, type Paid } from "./think.js";

export interface Brain {
  url: string;
  /** Who sells it, as the bazaar names them; null when the url was given. */
  name: string | null;
  /** How it was picked, in words. */
  from: string;
}

/** The brain is bought like anything else: from the bazaar, unless one is named. */
export async function findBrain(caip2: string, given?: string): Promise<Brain> {
  if (given) return { url: given, name: null, from: "given" };
  const found = await searchMarket("chat completions llm", { limit: 10 }).catch(() => null);
  const hit = found?.results.find((r) => r.network === caip2 && /\/chat\/completions$/.test(new URL(r.url).pathname) && r.method === "POST");
  if (!hit) return { url: BLOCKRUN_CHAT, name: "BlockRun", from: "BlockRun (the bazaar did not answer)" };
  return { url: hit.url, name: hit.name, from: `${hit.name}, found in the bazaar, from $${hit.priceUsd} a thought` };
}

/** One call, paid through the rail under its policy: what the loop is told, whatever happened. */
export function payWith(rail: Rail): (url: string, init: { method: "GET" | "POST"; body?: string }, maxUsdc: string) => Promise<Paid> {
  return async (url, init, maxUsdc) => {
    try {
      const { response, receipt } = await rail.fetch(url, { method: init.method, headers: { accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }) }, ...(init.body === undefined ? {} : { body: init.body }) }, { maxUsdc });
      const raw = await response.text();
      // A free public API's answer is large and unordered: the agent reads its digest (free-tools.ts).
      const body = (response.ok && isFree(url) ? digestFree(url, raw) : null) ?? raw;
      return { status: response.status, body, paidUsdc: receipt?.status === "settled" ? receipt.amountUsdc : "0", ledgerId: receipt ? String(receipt.ledgerId) : null, refused: null, tx: receipt?.txHash ?? null };
    } catch (err) {
      if (err instanceof PolicyRejected) return { status: 0, body: "", paidUsdc: "0", ledgerId: null, refused: `${err.decision.rule}: ${err.decision.reason}` };
      return { status: 0, body: `the call failed: ${(err as Error).message.slice(0, 140)}`, paidUsdc: "0", ledgerId: null, refused: null };
    }
  };
}

/**
 * Free public APIs first when they fit, then only what this wallet's policy lets it pay: a result it could
 * never buy only costs the brain a thought. A bazaar that does not answer leaves the free ones.
 */
export function searchWith(policy: SpendPolicy, caip2: string, allowedTool: (url: string) => boolean): (query: string) => Promise<Found[]> {
  return async (q) => {
    // Wide, then filtered: the bazaar's first dozen can all be sellers this wallet may not pay.
    const usable = async (query: string) =>
      (await searchMarket(query, { limit: 40 }).then((a) => a.results).catch(() => [])).filter((x) => x.network === caip2 && fit(x, policy, caip2, NOTHING_SPENT, null).payable && allowedTool(x.url));
    let found = [...freeTools(q, caip2).filter((x) => allowedTool(x.url)), ...(await usable(q))];
    // News and posts come from the web: when the words ask for them, a web search comes first.
    const isWeb = (x: { label: string | null }) => /\bweb\b/i.test(x.label ?? "") && /\bsearch/i.test(x.label ?? "");
    if (wantsWeb(q)) {
      const web = found.find(isWeb) ?? (await usable("web search")).find(isWeb);
      if (web) found = [web, ...found.filter((x) => x !== web)];
    }
    return found.slice(0, 6);
  };
}
