#!/usr/bin/env node
/**
 * Tiny CLI over the same rail the MCP server uses. For humans and for smoke tests.
 *   cra-agent quote <url>        cra-agent pay <url> [max usdc]        cra-agent balance
 *   cra-agent pay <url> [max usdc] --body '{"query":"x402"}'    a POST with a JSON body (--method POST without one)
 *   cra-agent pay <url> [max usdc] --lightning   paid in bitcoin over Lightning, when CRA_NWC_PAY_FILE holds a wallet
 *   cra-agent quote <url> --body '{"query":"x402"}'    the price of that POST: some sellers want the body before they name one
 *   cra-agent deposit <usdc>     cra-agent ledger [n]       cra-agent policy
 *   cra-agent withdraw <usdc> [max fee]    Gateway balance back to the wallet: how a seller collects
 *   cra-agent verify <receipt.json> [agent]    checks a signed receipt; needs no key and no network
 *   cra-agent init [--client …] [--policy …]   makes the key, writes the AI client config; see init.ts
 *   cra-agent find <what you need> [--max <usdc>] [--limit <n>]   what can be bought on Arc; needs no key
 *   cra-agent think "<task>" [--budget 0.10] [--model …] [--steps 8]   an agent that pays for its own thinking, and its tools
 *   cra-agent think --record [--questions <file>]   the same, kept in Postgres as it runs (cra-agent.tech/think shows it live)
 *   cra-agent serve-think [--port 8793] [--tools <file>] [--max-budget 0.10] [--max-seconds 150]   the same agent, hired:
 *                                  runs one task at a time for the API's /v1/upto/think, on 127.0.0.1 only (think-worker.ts)
 */
import { compareUsdc6, formatUsdc6, parseUsdc6 } from "@cra-agent/accounting";
import { describePolicy, parsePolicyString } from "@cra-agent/policy";
import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { EscrowNotImplemented, LightningNotPaid, PolicyRejected, verifySpendReceipt, type SignedSpendReceipt } from "@cra-agent/router";
import { CAIP2, registerIdentity, type ArcNetwork } from "@cra-agent/identity";
import { fit, forAgent, NOTHING_SPENT, searchMarket } from "../search.js";
import { railFromEnv } from "../rail-from-env.js";
import { runInit } from "./init.js";
import { DEFAULT_MODEL, STOPPED, think } from "../think.js";
import { findBrain, payWith, searchWith } from "../think-run.js";
import { serveLocal, thinkWorker } from "../think-worker.js";
import { ThinkRecorder } from "../think-record.js";
import { toolAllowed } from "../free-tools.js";
import { expandQuestions, pickQuestion } from "../think-questions.js";

/** The url and the amount in order, and --method / --body wherever they are. A body means POST. */
function callOptions(args: readonly string[]): { positional: string[]; method: "GET" | "POST"; body: string | undefined; lightning: boolean } {
  const positional: string[] = [];
  let method: string | undefined;
  let body: string | undefined;
  let lightning = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--method") method = args[++i];
    else if (args[i] === "--body") body = args[++i];
    else if (args[i] === "--lightning") lightning = true;
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
  return { positional, method: m, body, lightning };
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
  const { rail, ledger, policy, network, agentId, signer, escrow, rpcUrl, close: closeWallet } = await railFromEnv();
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
      const { positional, method, body, lightning } = callOptions(process.argv.slice(3));
      const [url, max] = positional;
      if (!url) throw new Error("usage: pay <url> [max usdc: refuse if the seller asks more at pay time] [--body '<json>'] [--method POST] [--lightning]");
      if (max !== undefined && !/^\d{1,6}(\.\d{1,6})?$/.test(max)) throw new Error("the ceiling is an amount in USDC, like 0.002");
      const init: RequestInit = { method, headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body }) };
      try {
        const pay = lightning ? rail.fetchLightning.bind(rail) : rail.fetch.bind(rail);
        const { response, receipt } = await pay(url, init, max === undefined ? {} : { maxUsdc: max });
        const body = await response.text();
        out({ status: response.status, receipt, body: body.slice(0, 600) });
      } catch (err) {
        if (err instanceof PolicyRejected) out({ rejected: true, rule: err.decision.rule, reason: err.decision.reason, quote: err.quote });
        else if (err instanceof EscrowNotImplemented) out({ escrow: true, message: err.message });
        else if (err instanceof LightningNotPaid) out({ paid: false, lightning: true, reason: err.reason });
        else throw err;
      }
      closeWallet();
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
        // A server run takes the next question of a shuffled pass through everything the file can ask, and
        // never one of the last hundred it asked (think-questions.ts). Counted from the runs kept so far.
        const all = expandQuestions(readFileSync(questions, "utf8"));
        if (all.length === 0) throw new Error(`${questions} has no questions in it`);
        const db = args.includes("--record") ? process.env.DATABASE_URL : undefined;
        const n = db ? await ThinkRecorder.count(db) : Math.floor(Date.now() / 1_800_000);
        task = pickQuestion(all, n, db ? await ThinkRecorder.recentTasks(db, 100) : new Set());
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
      const brain = await findBrain(caip2, flag("--brain"));
      const brainUrl = brain.url;
      const brainName = brain.name;
      const brainFrom = brain.from;
      const pay = payWith(rail);
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
            search: searchWith(policy, caip2, allowedTool),
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
      say(r.answer !== null ? `Answer: ${r.answer}` : `No answer: ${STOPPED[r.stoppedBecause](maxSteps)}.`);
      const read = r.steps.some((s) => (s.kind === "buy" || s.kind === "fetch") && (s.status ?? 0) >= 200 && (s.status ?? 0) < 300);
      if (r.answer !== null && !read) say("Nothing was bought or read: that answer is the model's own, and nothing in it was checked.");
      say(`Spent $${r.spent.totalUsdc}: thinking $${r.spent.thinkingUsdc} (${r.spent.thoughts} ${r.spent.thoughts === 1 ? "thought" : "thoughts"}), tools $${r.spent.toolsUsdc} (${r.spent.purchases} ${r.spent.purchases === 1 ? "purchase" : "purchases"}). Each payment signed a receipt, in USDC on Arc.`);
      break;
    }
    case "serve-think": {
      // The same agent as `think`, run for whoever the API sold a task to. It stays up; each run is logged as one line.
      const args = process.argv.slice(3);
      const flag = (name: string): string | undefined => {
        const i = args.indexOf(name);
        return i >= 0 ? args[i + 1] : undefined;
      };
      const toolsFile = flag("--tools");
      const allowedTool = toolAllowed(toolsFile ? readFileSync(toolsFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : null);
      const port = Number(flag("--port") ?? 8793);
      const maxBudgetUsdc = flag("--max-budget") ?? "0.10";
      const maxMs = Math.min(280, Math.max(20, Number(flag("--max-seconds") ?? 150))) * 1000;
      const model = flag("--model") ?? DEFAULT_MODEL;
      const maxSteps = Math.min(12, Math.max(1, Number(flag("--steps") ?? 8)));
      const caip2 = CAIP2[network];
      const log = (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ time: new Date().toISOString(), app: "cra-agent-think-worker", event, ...data }));
      const search = searchWith(policy, caip2, allowedTool);
      const pay = payWith(rail);
      const handler = thinkWorker({
        maxBudgetUsdc,
        maxMs,
        log,
        available: async () => (await rail.balances()).gatewayAvailable,
        run: async (task, budgetUsdc, deadline) => {
          const brain = await findBrain(caip2);
          return think({ task, brainUrl: brain.url, model, budgetUsdc, thoughtCeilingUsdc: "0.01", maxTokens: 350, maxSteps, deadline }, { pay, search, say: () => {} });
        },
      });
      serveLocal(handler, port, () => log("listening", { host: "127.0.0.1", port, agent: rail.address, agentId, network: caip2, maxBudgetUsdc, maxSeconds: maxMs / 1000, policy: describePolicy(policy) }));
      // Serves until stopped: the ledger stays open for the runs.
      await new Promise(() => {});
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
