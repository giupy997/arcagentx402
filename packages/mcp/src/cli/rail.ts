#!/usr/bin/env node
/**
 * Tiny CLI over the same rail the MCP server uses. For humans and for smoke tests.
 *   cra-agent quote <url>        cra-agent pay <url>        cra-agent balance
 *   cra-agent deposit <usdc>     cra-agent ledger [n]       cra-agent policy
 */
import { formatUsdc6 } from "@cra-agent/accounting";
import { describePolicy } from "@cra-agent/policy";
import { EscrowNotImplemented, PolicyRejected } from "@cra-agent/router";
import { railFromEnv } from "../rail-from-env.js";

const out = (v: unknown) => console.log(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  const { rail, ledger, policy, network, agentId } = await railFromEnv();
  switch (cmd) {
    case "quote": {
      if (!arg) throw new Error("usage: quote <url>");
      out((await rail.quote(arg)) ?? { free: true, url: arg });
      break;
    }
    case "pay": {
      if (!arg) throw new Error("usage: pay <url>");
      try {
        const { response, receipt } = await rail.fetch(arg, { headers: { accept: "application/json" } });
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
    case "ledger": {
      const rows = await ledger.recent(agentId, Number(arg ?? 20));
      out({ agentId, spentLast24hUsdc: formatUsdc6(await ledger.spentSince(agentId, new Date(Date.now() - 86_400_000))), payments: rows.map((r) => ({ ...r, amount: formatUsdc6(r.amount) })) });
      break;
    }
    case "policy": out({ agentId, network, address: rail.address, policy: describePolicy(policy) }); break;
    default:
      console.error("usage: cra-agent <quote|pay|balance|deposit|ledger|policy> [arg]");
      process.exit(2);
  }
  await ledger.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
