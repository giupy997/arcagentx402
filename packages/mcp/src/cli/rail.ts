#!/usr/bin/env node
/**
 * Tiny CLI over the same rail the MCP server uses. For humans and for smoke tests.
 *   cra-agent quote <url>        cra-agent pay <url> [max usdc]        cra-agent balance
 *   cra-agent pay <url> [max usdc] --body '{"query":"x402"}'    a POST with a JSON body (--method POST without one)
 *   cra-agent quote <url> --body '{"query":"x402"}'    the price of that POST: some sellers want the body before they name one
 *   cra-agent deposit <usdc>     cra-agent ledger [n]       cra-agent policy
 *   cra-agent withdraw <usdc> [max fee]    Gateway balance back to the wallet: how a seller collects
 *   cra-agent verify <receipt.json> [agent]    checks a signed receipt; needs no key and no network
 *   cra-agent init [--client …] [--policy …]   makes the key, writes the AI client config; see init.ts
 *   cra-agent find <what you need> [--max <usdc>] [--limit <n>]   what can be bought on Arc; needs no key
 *   cra-agent think "<task>" [--budget 0.10] [--model …] [--steps 8]   an agent that pays for its own thinking, and its tools
 *   cra-agent think --record [--questions <file>]   the same, kept in Postgres as it runs (cra-agent.tech/think shows it live)
 */
import { compareUsdc6, formatUsdc6, parseUsdc6 } from "@cra-agent/accounting";
import { describePolicy, parsePolicyString } from "@cra-agent/policy";
import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { EscrowNotImplemented, PolicyRejected, verifySpendReceipt, type SignedSpendReceipt } from "@cra-agent/router";
import { CAIP2, registerIdentity, type ArcNetwork } from "@cra-agent/identity";
import { fit, forAgent, NOTHING_SPENT, searchMarket } from "../search.js";
import { railFromEnv } from "../rail-from-env.js";
import { runInit } from "./init.js";
import { BLOCKRUN_CHAT, DEFAULT_MODEL, think, type Paid } from "../think.js";
import { ThinkRecorder } from "../think-record.js";
import { digestFree, freeTools, isFree, toolAllowed, wantsWeb } from "../free-tools.js";

/** The url and the amount in order, and --method / --body wherever they are. A body means POST. */
function callOptions(args: readonly string[]): { positional: string[]; method: "GET" | "POST"; body: string | undefined } {
  const positional: string[] = [];
  let method: string | undefined;
  let body: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--method") method = args[++i];
    else if (args[i] === "--body") body = args[++i];
    else positional.push(args[i]!);
  }
  const m = (method ?? (body === undefined ? "GET" : "POST")).toUpperCase();
  if (m !== "GET" && m !== "POST") throw new Error("--method is GET or POST");
  if (body !== undefined && m === "GET") throw new Error("a body goes with POST: drop --method GET");
  if (body !== undefined) {
    try {
      JSON.parse(body);
    } catch {
      throw new Error(`--body must be JSON, like '{"query":"x402"}'`);
    }
  }
  return { positional, method: m, body };
}

const out = (v: unknown) => console.log(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  // Setting up comes before there is a key or an environment to read.
  if (cmd === "init") return runInit(process.argv.slice(3));
  // Looking for something to buy needs no key either. With CRA_POLICY or CRA_NETWORK set, each result is
  // checked against those limits; what was already spent today is only known to the running agent.
  if (cmd === "find") {
    const args = process.argv.slice(3);
    const flag = (name: string): string | undefined => {
      const i = args.indexOf(name);
      return i >= 0 ? args[i + 1] : undefined;
    };
    const words = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--"))).join(" ");
    if (!words) throw new Error("usage: find <what you need> [--max <usdc>] [--limit <n>]");
    const max = flag("--max");
    const answer = await searchMarket(words, { ...(max === undefined ? {} : { maxUsdc: max }), limit: Number(flag("--limit") ?? 5) });
    const configured = process.env.CRA_POLICY !== undefined || process.env.CRA_NETWORK !== undefined;
    const net = (process.env.CRA_NETWORK ?? "arcTestnet") as ArcNetwork;
    if (net !== "arc" && net !== "arcTestnet") throw new Error(`CRA_NETWORK must be arc or arcTestnet, got ${net}`);
    const policy = parsePolicyString(process.env.CRA_POLICY ?? "");
    out({
      query: answer.query,
      results: answer.results.map((r) => forAgent(r, configured ? fit(r, policy, CAIP2[net], NOTHING_SPENT, null) : null)),
      ...(configured ? { checked: "against your limits; what you already spent today is not counted here" } : {}),
    });
    return;
  }
  // Checking someone else's receipt needs no key, no network and no ledger, so it runs before any of that.
  if (cmd === "verify") {
    if (!arg) throw new Error("usage: verify <receipt.json | - for stdin> [expected agent address]");
    const raw = JSON.parse(readFileSync(arg === "-" ? 0 : arg, "utf8")) as Record<string, unknown>;
    // Accept the signed object itself, a receipt that carries one, or the whole output of `pay`.
    const receipt = (raw.receipt as Record<string, unknown> | undefined) ?? raw;
    const signed = ((receipt.attestation as unknown) ?? receipt) as SignedSpendReceipt;
    const expected = process.argv[4] as Address | undefined;
    const check = await verifySpendReceipt(signed, expected);
    out({ ...check, agent: signed.message?.agent, resource: signed.message?.resource, amountBaseUnits: signed.message?.amount, settlementId: signed.message?.settlementId, policyHash: signed.message?.policyHash });
    process.exit(check.valid && check.withinStatedLimits ? 0 : 1);
  }
  const { rail, ledger, policy, network, agentId, signer, escrow, rpcUrl } = await railFromEnv();
  switch (cmd) {
    case "quote": {
      const { positional, method, body } = callOptions(process.argv.slice(3));
      const url = positional[0];
      if (!url) throw new Error("usage: quote <url> [--body '<json>'] [--method POST]");
      const init: RequestInit = { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body }) };
      out((await rail.quote(url, init)) ?? { free: true, url });
      break;
    }
    case "pay": {
      const { positional, method, body } = callOptions(process.argv.slice(3));
      const [url, max] = positional;
      if (!url) throw new Error("usage: pay <url> [max usdc: refuse if the seller asks more at pay time] [--body '<json>'] [--method POST]");
      if (max !== undefined && !/^\d{1,6}(\.\d{1,6})?$/.test(max)) throw new Error("the ceiling is an amount in USDC, like 0.002");
      const init: RequestInit = { method, headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body }) };
      try {
        const { response, receipt } = await rail.fetch(url, init, max === undefined ? {} : { maxUsdc: max });
        const body = await response.text();
        out({ status: response.status, receipt, body: body.slice(0, 600) });
      } catch (err) {
        if (err instanceof PolicyRejected) out({ rejected: true, rule: err.decision.rule, reason: err.decision.reason, quote: err.quote });
        else if (err instanceof EscrowNotImplemented) out({ escrow: true, message: err.message });
        else throw err;
      }
      break;
    }
    case "balance": out({ network, ...(await rail.balances()) }); break;
    case "deposit": {
      if (!arg) throw new Error("usage: deposit <usdc>");
      out(await rail.deposit(arg));
      break;
    }
    case "withdraw": {
      if (!arg || !/^\d+(\.\d{1,6})?$/.test(arg)) throw new Error("usage: withdraw <usdc> [max fee in usdc, default 0.05]");
      const maxFee = process.argv[4];
      if (maxFee !== undefined && !/^\d+(\.\d{1,6})?$/.test(maxFee)) throw new Error("the max fee is an amount in USDC, like 0.05");
      out(await rail.withdraw(arg, maxFee ? { maxFeeUsdc: maxFee } : {}));
      break;
    }
    case "ledger": {
      const rows = await ledger.recent(agentId, Number(arg ?? 20));
      out({ agentId, spentLast24hUsdc: formatUsdc6(await ledger.spentSince(agentId, new Date(Date.now() - 86_400_000))), payments: rows.map((r) => ({ ...r, amount: formatUsdc6(r.amount) })) });
      break;
    }
    case "policy": out({ agentId, network, address: rail.address, policy: describePolicy(policy) }); break;
    case "think": {
      // An agent that pays for its own thinking: every thought a paid LLM call on Arc, every tool bought
      // from the bazaar, the session budget and the spending policy over both. See think.ts.
      const args = process.argv.slice(3);
      const flag = (name: string): string | undefined => {
        const i = args.indexOf(name);
        return i >= 0 ? args[i + 1] : undefined;
      };
      // Only these take a value; --json and --record stand alone, so the task may follow them.
      const VALUED = new Set(["--budget", "--ceiling", "--model", "--steps", "--tokens", "--brain", "--questions", "--tools"]);
      let task = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && VALUED.has(args[i - 1]!))).join(" ").trim();
      const questions = flag("--questions");
      if (!task && questions) {
        // A server run takes the next question of its list, going round: counted from the runs kept so far
        // when recording, so every question comes up whatever the schedule; by the hour otherwise.
        const list = readFileSync(questions, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
        if (list.length === 0) throw new Error(`${questions} has no questions in it`);
        const n = args.includes("--record") && process.env.DATABASE_URL ? await ThinkRecorder.count(process.env.DATABASE_URL) : Math.floor(Date.now() / 3_600_000);
        task = list[n % list.length]!;
      }
      if (!task) throw new Error('usage: think "<task>" [--budget 0.10] [--ceiling 0.01] [--model anthropic/claude-haiku-4.5] [--steps 8] [--tokens 350] [--brain <url>] [--json] [--record] [--questions <file>] [--tools <file>]');
      // --tools: URL prefixes the agent may use, one a line; anything else is never shown to it, so never bought.
      const toolsFile = flag("--tools");
      const allowedTool = toolAllowed(toolsFile ? readFileSync(toolsFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : null);
      const amount = /^\d{1,6}(\.\d{1,6})?$/;
      const budgetUsdc = flag("--budget") ?? "0.10";
      const thoughtCeilingUsdc = flag("--ceiling") ?? "0.01";
      if (!amount.test(budgetUsdc) || !amount.test(thoughtCeilingUsdc)) throw new Error("--budget and --ceiling are amounts in USDC, like 0.10");
      const model = flag("--model") ?? DEFAULT_MODEL;
      const maxSteps = Math.min(30, Math.max(1, Number(flag("--steps") ?? 8)));
      const maxTokens = Math.min(4000, Math.max(100, Number(flag("--tokens") ?? 350)));
      const json = args.includes("--json");
      const say = (line: string) => {
        if (!json) console.log(line);
      };
      const caip2 = CAIP2[network];
      // The brain is bought like anything else: from the bazaar, unless one is named.
      let brainUrl = flag("--brain");
      let brainFrom = "given";
      let brainName: string | null = null;
      if (!brainUrl) {
        const found = await searchMarket("chat completions llm", { limit: 10 }).catch(() => null);
        const hit = found?.results.find((r) => r.network === caip2 && /\/chat\/completions$/.test(new URL(r.url).pathname) && r.method === "POST");
        brainUrl = hit?.url ?? BLOCKRUN_CHAT;
        brainName = hit?.name ?? "BlockRun";
        brainFrom = hit ? `${hit.name}, found in the bazaar, from $${hit.priceUsd} a thought` : "BlockRun (the bazaar did not answer)";
      }
      const pay = async (url: string, init: { method: "GET" | "POST"; body?: string }, maxUsdc: string): Promise<Paid> => {
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
      const limits = describePolicy(policy);
      say(`Task: ${task}`);
      say(`Brain: ${model} at ${brainUrl} (${brainFrom})`);
      say(`Budget: $${budgetUsdc} for thinking and tools · at most $${thoughtCeilingUsdc} a thought · policy: $${limits.perPaymentCapUsdc} a payment, $${limits.dailyCapUsdc} a day`);
      say("");
      // --record keeps the run in Postgres as it happens, for cra-agent.tech/think to show live.
      let recorder: ThinkRecorder | null = null;
      if (args.includes("--record")) {
        if (!process.env.DATABASE_URL) throw new Error("--record writes the run to Postgres: set DATABASE_URL");
        // On a timer, a run starts only when the wallet can pay for all of it: an empty wallet skips quietly
        // instead of leaving a half-paid, failed run on the page.
        const { gatewayAvailable } = await rail.balances();
        if (compareUsdc6(parseUsdc6(gatewayAvailable), parseUsdc6(budgetUsdc)) < 0) {
          console.log(`Skipped: $${gatewayAvailable} left in Circle Gateway, less than the $${budgetUsdc} a run may spend. Top it up with cra-agent deposit.`);
          break;
        }
        recorder = await ThinkRecorder.start(process.env.DATABASE_URL, { agent: rail.address, network: caip2, task, model, brainUrl, brainName, budgetUsdc, ceilingUsdc: thoughtCeilingUsdc, policy: limits });
        say(`Recording as run ${recorder.id}`);
      }
      let r: Awaited<ReturnType<typeof think>>;
      try {
        r = await think(
          { task, brainUrl, model, budgetUsdc, thoughtCeilingUsdc, maxTokens, maxSteps },
          {
            pay,
            say,
            // Free public APIs first when they fit, then only what this wallet's policy lets it pay: a result it
            // could never buy only costs the brain a thought. A bazaar that does not answer leaves the free ones.
            search: async (q) => {
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
            },
            ...(recorder ? { onStep: (s) => recorder!.step(s), onPhase: (p) => recorder!.phase(p) } : {}),
          },
        );
        await recorder?.finish(r);
      } catch (err) {
        await recorder?.fail(err);
        throw err;
      } finally {
        await recorder?.close();
      }
      if (json) {
        out(r);
        break;
      }
      say("");
      say(r.answer !== null ? `Answer: ${r.answer}` : `No answer: ${r.stoppedBecause === "budget" ? "the budget ran out" : r.stoppedBecause === "steps" ? `no answer within ${maxSteps} steps` : "the brain stopped making sense"}.`);
      if (r.answer !== null && r.spent.purchases === 0) say("Nothing was bought: that answer is the model's own, and nothing in it was checked.");
      say(`Spent $${r.spent.totalUsdc}: thinking $${r.spent.thinkingUsdc} (${r.spent.thoughts} ${r.spent.thoughts === 1 ? "thought" : "thoughts"}), tools $${r.spent.toolsUsdc} (${r.spent.purchases} ${r.spent.purchases === 1 ? "purchase" : "purchases"}). Each payment signed a receipt, in USDC on Arc.`);
      break;
    }
    case "selftest": {
      // The rail buying from itself, on purpose and in the open: one route that must work, one that
      // must fail without charging. Run it on a timer and a broken rail shows within the hour.
      const base = (arg ?? "https://api.cra-agent.tech").replace(/\/+$/, "");
      const started = Date.now();
      const checks: Record<string, unknown> = {};
      let ok = true;
      try {
        const paid = await rail.fetch(`${base}/v1/paid/fees/estimate`, { headers: { accept: "application/json" } });
        const sig = paid.receipt?.attestation ? await verifySpendReceipt(paid.receipt.attestation, rail.address) : null;
        const good = paid.response.status === 200 && paid.receipt?.status === "settled" && sig?.valid === true && sig.withinStatedLimits;
        checks.paid = { http: paid.response.status, status: paid.receipt?.status ?? null, amountUsdc: paid.receipt?.amountUsdc ?? null, latencyMs: paid.receipt?.latencyMs ?? null, receiptSignatureValid: sig?.valid ?? false };
        ok = ok && good;
      } catch (err) {
        checks.paid = { error: (err as Error).message.slice(0, 200) };
        ok = false;
      }
      try {
        const broken = await rail.fetch(`${base}/v1/paid/selftest/fail`, { headers: { accept: "application/json" } });
        const good = broken.response.status >= 500 && broken.receipt?.status === "not_charged";
        checks.mustNotCharge = { http: broken.response.status, status: broken.receipt?.status ?? null };
        ok = ok && good;
      } catch (err) {
        checks.mustNotCharge = { error: (err as Error).message.slice(0, 200) };
        ok = false;
      }
      try {
        checks.settlementsMatched = (await rail.resolveSettlements({ limit: 30 })).length;
      } catch (err) {
        checks.settlementsMatched = { error: (err as Error).message.slice(0, 120) }; // late proofs are not a failed run
      }
      out({ ok, tookMs: Date.now() - started, agent: rail.address, ...checks });
      await ledger.close();
      process.exit(ok ? 0 : 1);
    }
    case "proof": {
      const proofs = await rail.resolveSettlements({ limit: Number(arg ?? 20) });
      out(proofs.length ? proofs : { message: "no new on-chain settlement matched yet; batched settlement can take a while" });
      break;
    }
    case "identity-register": {
      if (!arg) throw new Error("usage: identity-register <agentURI>");
      const r = await registerIdentity({ network, signer, agentURI: arg, rpcUrl });
      out({ agentId: r.agentId.toString(), txHash: r.txHash, registry: r.registry, owner: signer.address });
      break;
    }
    case "job": {
      const [, , sub, id, reason] = process.argv.slice(1);
      const e = escrow();
      if (!sub || !id) throw new Error("usage: job <status|fund|complete|reject> <jobId> [reason]");
      if (sub === "status") out(await e.getJob(BigInt(id)));
      else if (sub === "fund") out(await e.fund(BigInt(id)));
      else if (sub === "complete") out(await e.complete(BigInt(id), reason ?? "work-delivered-and-approved"));
      else if (sub === "reject") out(await e.reject(BigInt(id), reason ?? "rejected"));
      else throw new Error(`unknown job command ${sub}`);
      break;
    }
    default:
      console.error("usage: cra-agent <init|find|think|quote|pay|balance|deposit|withdraw|ledger|policy|proof|verify|selftest> [arg]");
      process.exit(2);
  }
  await ledger.close();
}

main().catch((err: unknown) => {
  // AggregateError (e.g. a database that is not listening) has an empty message: show the whole thing.
  const e = err as { message?: string; stack?: string; errors?: unknown[]; cause?: unknown };
  const msg = e?.message || (e?.errors?.length ? `${e.constructor?.name ?? "Error"}: ${e.errors.map((x) => (x as Error)?.message ?? String(x)).join("; ")}` : "") || String(err);
  console.error(msg);
  if (process.env.CRA_DEBUG) console.error(e?.stack ?? err);
  process.exit(1);
});
