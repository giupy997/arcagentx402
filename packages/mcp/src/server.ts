#!/usr/bin/env node
/**
 * ArcRail MCP server: the agent-facing interface of the rail (brief §6: primary, not an add-on).
 * Tools: arc_quote, arc_pay, arc_balance, arc_deposit, arc_ledger, arc_policy.
 * Transport: stdio. All diagnostics go to stderr; stdout is the MCP channel.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatUsdc6 } from "@arc-rail/accounting";
import { describePolicy } from "@arc-rail/policy";
import { EscrowNotImplemented, PolicyRejected } from "@arc-rail/router";
import { railFromEnv } from "./rail-from-env.js";

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

async function main(): Promise<void> {
  const { rail, ledger, policy, network, agentId } = await railFromEnv();
  const server = new McpServer({ name: "arcrail", version: "0.0.1" });

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
    description: "Fetches the URL. If the server answers 402, ArcRail checks the spending policy, verifies the seller, signs a gas-free nanopayment through Circle Gateway (or a standard x402 payment), retries the request and records the outcome in the ledger. Returns the response body plus a receipt. Policy rejections are returned as errors with the rule that fired.",
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

  server.registerTool("arc_policy", {
    title: "Spending policy in force",
    description: "The limits this rail enforces for the agent. Read-only: limits are set by the operator in the environment, not by the model.",
    inputSchema: {},
  }, async () => text({ agentId, network, address: rail.address, policy: describePolicy(policy) }));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(JSON.stringify({ event: "arcrail.mcp.ready", network, address: rail.address, agentId }));
}

main().catch((err) => {
  console.error(JSON.stringify({ event: "arcrail.mcp.fatal", error: (err as Error).message }));
  process.exit(1);
});
