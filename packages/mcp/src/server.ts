#!/usr/bin/env node
/**
 * CRA AGENT MCP server: the agent-facing interface of the rail (brief §6: primary, not an add-on).
 * Tools: arc_search, arc_quote, arc_pay, arc_balance, arc_deposit, arc_ledger, arc_policy and more.
 * Transport: stdio. All diagnostics go to stderr; stdout is the MCP channel.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatUsdc6 } from "@cra-agent/accounting";
import { describePolicy } from "@cra-agent/policy";
import { EscrowNotImplemented, PolicyRejected, verifySpendReceipt, type SignedSpendReceipt } from "@cra-agent/router";
import { evaluatePolicy } from "@cra-agent/policy";
import { usdc6 } from "@cra-agent/accounting";
import type { Address, Hex } from "viem";
import { railFromEnv } from "./rail-from-env.js";
import { fit, forAgent, searchMarket } from "./search.js";

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

async function main(): Promise<void> {
  const { rail, ledger, policy, network, agentId, escrow } = await railFromEnv();
  const server = new McpServer({ name: "cra-agent", version: "0.0.1" });

  server.registerTool("arc_quote", {
    title: "Quote an x402 resource",
    description: "Ask what a URL costs without paying. Returns price in USDC, seller address, network, whether the seller batches via Circle Gateway, the rail that would be used, the policy decision and the seller's ERC-8004 identity. Returns null if the resource is free.",
    inputSchema: { url: z.string().url(), method: z.enum(["GET", "POST"]).optional() },
  }, async ({ url, method }) => {
    try {
      const q = await rail.quote(url, method ? { method } : undefined);
      return text(q ?? { free: true, url });
    } catch (err) {
      return fail(`quote failed: ${(err as Error).message}`);
    }
  });

  server.registerTool("arc_pay", {
    title: "Fetch a resource, paying with USDC on Arc if it asks",
    description: "Fetches the URL. If the server answers 402, CRA AGENT checks the spending policy, verifies the seller, signs a gas-free nanopayment through Circle Gateway (or a standard x402 payment), retries the request and records the outcome in the ledger. Returns the response body plus a receipt. Policy rejections are returned as errors with the rule that fired.",
    inputSchema: { url: z.string().url(), method: z.enum(["GET", "POST"]).optional(), body: z.string().optional(), maxUsdc: z.string().optional().describe("Refuse if the quoted price is above this (decimal USDC)") },
  }, async ({ url, method, body, maxUsdc }) => {
    try {
      if (maxUsdc !== undefined) {
        const q = await rail.quote(url, method ? { method } : undefined);
        if (q && Number(q.priceUsdc) > Number(maxUsdc)) return fail(`price ${q.priceUsdc} USDC is above maxUsdc ${maxUsdc}; not paid`);
      }
      const init: RequestInit = { method: method ?? "GET", headers: { accept: "application/json" } };
      if (body !== undefined) { init.body = body; (init.headers as Record<string, string>)["content-type"] = "application/json"; }
      const { response, receipt } = await rail.fetch(url, init);
      const raw = await response.text();
      let data: unknown = raw;
      try { data = JSON.parse(raw); } catch { /* keep text */ }
      return text({ status: response.status, paid: receipt !== null, receipt, data });
    } catch (err: unknown) {
      if (err instanceof PolicyRejected) return fail(`rejected by policy (${err.decision.rule}): ${err.decision.reason}. Quote: ${err.quote.priceUsdc} USDC to ${err.quote.payTo}`);
      if (err instanceof EscrowNotImplemented) return fail(err.message);
      return fail(`payment failed: ${(err as Error).message}`);
    }
  });

  server.registerTool("arc_search", {
    title: "Find paid APIs on Arc",
    description: "Search what can be bought on Arc, in a few words: 'bitcoin price', 'euro to dollar', 'vulnerabilities in an npm package'. Covers CRA AGENT's own data and every endpoint on the CRA market, each verified to answer 402 on Arc. Each result gives the URL to call with example parameters (change them to what you need, following params), the price, the seller, and whether your spending policy allows paying it right now, counting what you already spent today. Next: arc_quote the URL, then arc_pay it.",
    inputSchema: {
      query: z.string().min(2).max(200).describe("What you need, in a few words"),
      maxUsdc: z.string().regex(/^\d{1,6}(\.\d{1,6})?$/).optional().describe("Only results at or under this price per call, in USDC"),
      limit: z.number().int().min(1).max(20).optional(),
    },
  }, async ({ query, maxUsdc, limit }) => {
    try {
      const answer = await searchMarket(query, { ...(maxUsdc === undefined ? {} : { maxUsdc }), limit: limit ?? 5 });
      const since = new Date(Date.now() - 86_400_000);
      const sellers = [...new Set(answer.results.map((r) => r.payTo))];
      const [day, count, perSeller, balances] = await Promise.all([
        ledger.spentSince(agentId, since),
        ledger.countSince(agentId, new Date(Date.now() - policy.rateLimit.windowMs)),
        Promise.all(sellers.map(async (p) => [p, await ledger.spentSince(agentId, since, p)] as const)),
        rail.balances().catch(() => null),
      ]);
      const bySeller = new Map(perSeller);
      const spent = { day, inRateWindow: count, withSeller: (p: string) => bySeller.get(p) ?? usdc6(0n) };
      const results = answer.results.map((r) => forAgent(r, fit(r, policy, rail.network, spent, balances?.gatewayAvailable ?? null)));
      return text({
        query: answer.query,
        results,
        next: results.length ? "arc_quote the url to confirm the price, then arc_pay it. Change the example values in the url to what you need, following params." : "Nothing on Arc sells that yet. Try other words, or look at https://cra-agent.tech/market.",
      });
    } catch (err) {
      return fail(`search failed: ${(err as Error).message}`);
    }
  });

  server.registerTool("arc_balance", {
    title: "Balances of the rail wallet",
    description: "USDC in the wallet and in the Circle Gateway balance used for nanopayments, on the configured Arc network.",
    inputSchema: {},
  }, async () => {
    try { return text({ network, ...(await rail.balances()) }); } catch (err) { return fail(`balance failed: ${(err as Error).message}`); }
  });

  server.registerTool("arc_deposit", {
    title: "Deposit USDC into Gateway",
    description: "Moves USDC from the wallet into the Circle Gateway balance so nanopayments can be signed. On-chain transaction (needs a little USDC for gas on Arc).",
    inputSchema: { amountUsdc: z.string().regex(/^\d+(\.\d{1,6})?$/) },
  }, async ({ amountUsdc }) => {
    try { return text(await rail.deposit(amountUsdc)); } catch (err) { return fail(`deposit failed: ${(err as Error).message}`); }
  });

  server.registerTool("arc_ledger", {
    title: "Recent payments",
    description: "The last N payment attempts by this agent with amount, seller, status, latency and transaction, plus today's spend.",
    inputSchema: { limit: z.number().int().min(1).max(200).optional() },
  }, async ({ limit }) => {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [rows, spent] = await Promise.all([ledger.recent(agentId, limit ?? 20), ledger.spentSince(agentId, since)]);
    return text({ agentId, spentLast24hUsdc: formatUsdc6(spent), payments: rows.map((r) => ({ ...r, amount: formatUsdc6(r.amount) })) });
  });

  server.registerTool("arc_proof", {
    title: "Find the on-chain transaction for past payments",
    description: "Gateway settles in batches, so the transfer to the seller reaches the chain after the response. This matches settled payments in the ledger to the on-chain USDC transfer that carried them and stores the transaction hash.",
    inputSchema: { limit: z.number().int().min(1).max(50).optional() },
  }, async ({ limit }) => {
    try {
      const proofs = await rail.resolveSettlements({ limit: limit ?? 20 });
      return text(proofs.length ? proofs : { matched: 0, note: "nothing new on chain yet" });
    } catch (err) { return fail(`proof lookup failed: ${(err as Error).message}`); }
  });

  server.registerTool("arc_verify_receipt", {
    title: "Check a signed spend receipt",
    description: "Verifies a receipt another agent hands over: recovers who signed it, checks it is the agent named inside, and redoes the arithmetic to confirm the payment fitted the limits it states. It proves the agent's key issued the statement and that nothing was altered; it does not prove the payment settled, which is what the settlement id is for. Needs no payment and spends nothing.",
    inputSchema: { receipt: z.string().describe("The signed receipt as JSON: the attestation object, or a receipt that contains one"), expectedAgent: z.string().optional().describe("The address the receipt is supposed to come from") },
  }, async ({ receipt, expectedAgent }) => {
    try {
      const raw = JSON.parse(receipt) as Record<string, unknown>;
      const inner = (raw.receipt as Record<string, unknown> | undefined) ?? raw;
      const signed = ((inner.attestation as unknown) ?? inner) as SignedSpendReceipt;
      return text(await verifySpendReceipt(signed, expectedAgent as Address | undefined));
    } catch (err) { return fail(`not a readable receipt: ${(err as Error).message}`); }
  });

  server.registerTool("arc_policy", {
    title: "Spending policy in force",
    description: "The limits this rail enforces for the agent. Read-only: limits are set by the operator in the environment, not by the model.",
    inputSchema: {},
  }, async () => text({ agentId, network, address: rail.address, policy: describePolicy(policy) }));

  // ---------------------------------------------------------------- ERC-8183 escrow rail (jobs)
  server.registerTool("arc_job_create", {
    title: "Open an ERC-8183 job (escrow rail)",
    description: "For work that is too large or too slow for a per-call payment. Creates a job with a provider (seller) and an evaluator; the provider then sets the budget, you fund it with arc_job_fund, the provider submits, the evaluator completes or rejects. Costs gas in USDC.",
    inputSchema: { provider: z.string().regex(/^0x[0-9a-fA-F]{40}$/), description: z.string().min(1).max(2000), expiresInSeconds: z.number().int().min(60).max(90 * 86400).optional(), evaluator: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional() },
  }, async ({ provider, description, expiresInSeconds, evaluator }) => {
    try {
      const r = await escrow().createJob({ provider: provider as Address, description, expiresInSeconds: expiresInSeconds ?? 7 * 86400, ...(evaluator ? { evaluator: evaluator as Address } : {}) });
      return text({ jobId: r.jobId.toString(), txHash: r.txHash, next: "provider calls setBudget, then arc_job_fund" });
    } catch (err) { return fail(`job create failed: ${(err as Error).message}`); }
  });

  server.registerTool("arc_job_fund", {
    title: "Fund an ERC-8183 job from escrow",
    description: "Moves the job's budget (set by the provider) from the agent wallet into the escrow contract. The spending policy is applied to the budget as one payment, with the provider as counterparty. Recorded in the ledger on the escrow rail.",
    inputSchema: { jobId: z.string().regex(/^\d+$/) },
  }, async ({ jobId }) => {
    const e = escrow();
    try {
      const job = await e.getJob(BigInt(jobId));
      const since = new Date(Date.now() - 86_400_000);
      const [spent, spentCp, count] = await Promise.all([ledger.spentSince(agentId, since), ledger.spentSince(agentId, since, job.provider), ledger.countSince(agentId, new Date(Date.now() - policy.rateLimit.windowMs))]);
      const decision = evaluatePolicy(policy, { amount: job.budget, network: rail.network, payTo: job.provider, host: e.contract, spentInWindow: spent, spentInWindowWithCounterparty: spentCp, paymentsInRateWindow: count, identityVerified: null, sellerBond: null });
      if (!decision.allow) {
        await ledger.record({ agentId, rail: "escrow", url: `erc8183://${e.contract}/${jobId}`, host: e.contract, method: "FUND", network: rail.network, scheme: "erc8183", asset: "USDC", payTo: job.provider, amount: job.budget, status: "rejected", reason: `${decision.rule}: ${decision.reason}` });
        return fail(`rejected by policy (${decision.rule}): ${decision.reason}`);
      }
      const rec = await ledger.record({ agentId, rail: "escrow", url: `erc8183://${e.contract}/${jobId}`, host: e.contract, method: "FUND", network: rail.network, scheme: "erc8183", asset: "USDC", payTo: job.provider, amount: job.budget, status: "signed" });
      try {
        const r = await e.fund(BigInt(jobId));
        await ledger.update(rec.id, { txHash: r.txHash, meta: { approveTxHash: r.approveTxHash, escrow: true } });
        return text({ jobId, funded: r.amount.toString(), fundedUsdc: job.budgetUsdc, txHash: r.txHash, ledgerId: rec.id, note: "escrowed: counts as open exposure until the evaluator completes or the job is refunded" });
      } catch (err) {
        await ledger.update(rec.id, { status: "failed", reason: (err as Error).message.slice(0, 300) });
        throw err;
      }
    } catch (err) { return fail(`job fund failed: ${(err as Error).message}`); }
  });

  server.registerTool("arc_job_status", {
    title: "Read an ERC-8183 job",
    description: "Client, provider, evaluator, budget, expiry and state (Open, Funded, Submitted, Completed, Rejected, Expired).",
    inputSchema: { jobId: z.string().regex(/^\d+$/) },
  }, async ({ jobId }) => {
    try { return text(await escrow().getJob(BigInt(jobId))); } catch (err) { return fail(`job status failed: ${(err as Error).message}`); }
  });

  server.registerTool("arc_job_decide", {
    title: "Complete or reject a job (evaluator)",
    description: "As the job's evaluator: complete releases the escrow to the provider, reject returns it to the client. The reason is stored on-chain as a hash.",
    inputSchema: { jobId: z.string().regex(/^\d+$/), decision: z.enum(["complete", "reject"]), reason: z.string().min(1).max(200) },
  }, async ({ jobId, decision, reason }) => {
    try {
      const e = escrow();
      const r = decision === "complete" ? await e.complete(BigInt(jobId), reason) : await e.reject(BigInt(jobId), reason);
      const rows = await ledger.recent(agentId, 200);
      const rec = rows.find((x) => x.rail === "escrow" && x.url.endsWith(`/${jobId}`) && x.status === "signed");
      if (rec) await ledger.update(rec.id, { status: decision === "complete" ? "settled" : "failed", reason: decision === "complete" ? null : `rejected: ${reason}`, settledAt: decision === "complete" ? new Date() : null, txHash: r.txHash });
      return text({ jobId, decision, txHash: r.txHash });
    } catch (err) { return fail(`job ${decision} failed: ${(err as Error).message}`); }
  });

  server.registerTool("arc_job_submit", {
    title: "Submit a deliverable (provider)",
    description: "As the job's provider: submits the keccak256 hash of the deliverable and moves the job to Submitted.",
    inputSchema: { jobId: z.string().regex(/^\d+$/), deliverableHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) },
  }, async ({ jobId, deliverableHash }) => {
    try { return text({ jobId, ...(await escrow().submit(BigInt(jobId), deliverableHash as Hex)) }); } catch (err) { return fail(`job submit failed: ${(err as Error).message}`); }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(JSON.stringify({ event: "cra.mcp.ready", network, address: rail.address, agentId }));
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "cra.mcp.fatal", error: (err as Error).message }));
  process.exit(1);
});
