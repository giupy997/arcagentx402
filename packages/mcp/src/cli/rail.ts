#!/usr/bin/env node
/**
 * Tiny CLI over the same rail the MCP server uses. For humans and for smoke tests.
 *   cra-agent quote <url>        cra-agent pay <url>        cra-agent balance
 *   cra-agent deposit <usdc>     cra-agent ledger [n]       cra-agent policy
 *   cra-agent withdraw <usdc> [max fee]    Gateway balance back to the wallet: how a seller collects
 *   cra-agent verify <receipt.json> [agent]    checks a signed receipt; needs no key and no network
 *   cra-agent init [--client …] [--policy …]   makes the key, writes the AI client config; see init.ts
 */
import { formatUsdc6 } from "@cra-agent/accounting";
import { describePolicy } from "@cra-agent/policy";
import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { EscrowNotImplemented, PolicyRejected, verifySpendReceipt, type SignedSpendReceipt } from "@cra-agent/router";
import { registerIdentity } from "@cra-agent/identity";
import { railFromEnv } from "../rail-from-env.js";
import { runInit } from "./init.js";

const out = (v: unknown) => console.log(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  // Setting up comes before there is a key or an environment to read.
  if (cmd === "init") return runInit(process.argv.slice(3));
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
      console.error("usage: cra-agent <init|quote|pay|balance|deposit|withdraw|ledger|policy|proof|verify|selftest> [arg]");
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
