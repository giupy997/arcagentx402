import { readFileSync } from "node:fs";
import { CHAIN_IDS, PUBLIC_RPCS, createErc8004Resolver, createSigner, mergeRpcLists, parseRpcList, pickRpcUrl, redactRpcUrl, type ArcNetwork } from "@cra-agent/identity";
import { MemoryLedger, PgLedger, type Ledger } from "@cra-agent/ledger";
import { DEFAULT_POLICY, parsePolicyString, type SpendPolicy } from "@cra-agent/policy";
import { createRail, type Rail } from "@cra-agent/router";
import { createEscrowClient, type EscrowClient } from "@cra-agent/escrow";
import { btcUsdRate, LNBTC_MAINNET, LNBTC_TESTNET, nwcPayer, readConnection } from "@cra-agent/lightning";
import type { Address } from "viem";
import type { Hex } from "viem";

/**
 * Environment contract for the MCP server (and the CLI):
 *   CRA_NETWORK       arc | arcTestnet            (default arcTestnet)
 *   CRA_PRIVATE_KEY   0x…  or CRA_KEY_FILE=path (file containing the key; chmod 600)
 *   CRA_POLICY        "daily=5,per_seller=0.5,per_payment=0.05,rate=120/60s,identity=required,allow=a|b"
 *   CRA_AGENT_ID      ledger key for this agent (default: signer address)
 *   CRA_RPC_URL       optional RPC, or several separated by commas, in priority order. They are tried first and the
 *                     public Arc endpoints after them, so one flaky endpoint cannot stop a payment.
 *   CRA_RPC_STRICT    "1" to use only the configured endpoints and never a public one
 *   CRA_IDENTITY      on | off  (default on)
 *   DATABASE_URL          optional; with it the ledger is Postgres, without it in-memory
 *   CRA_EVALUATOR         optional address that evaluates ERC-8183 jobs this agent creates (default: the agent)
 *   CRA_NWC_PAY_FILE      optional file holding a Nostr Wallet Connect string that can pay: the agent can then pay
 *                         sellers in bitcoin over Lightning (x402 exact on lnbtc), and its policy allows that network
 */
export interface RailFromEnv { rail: Rail; ledger: Ledger; policy: SpendPolicy; network: ArcNetwork; agentId: string; signer: ReturnType<typeof createSigner>; escrow: () => EscrowClient; /** The endpoint picked at startup, for anything that talks to the chain outside the rail. */ rpcUrl: string; /** Closes the Lightning wallet's relay connections, when there is one. */ close: () => void }

/** Accept the pre-rename ARCRAIL_* variables so existing setups keep working. */
function withLegacyNames(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("ARCRAIL_")) {
      const modern = `CRA_${k.slice("ARCRAIL_".length)}`;
      if (out[modern] === undefined) out[modern] = v;
    }
  }
  return out;
}

export async function railFromEnv(rawEnv: NodeJS.ProcessEnv = process.env): Promise<RailFromEnv> {
  const env = withLegacyNames(rawEnv);
  const network = (env.CRA_NETWORK ?? "arcTestnet") as ArcNetwork;
  if (network !== "arc" && network !== "arcTestnet") throw new Error(`CRA_NETWORK must be arc or arcTestnet, got ${network}`);
  let privateKey = env.CRA_PRIVATE_KEY as Hex | undefined;
  if (!privateKey && env.CRA_KEY_FILE) privateKey = readFileSync(env.CRA_KEY_FILE, "utf8").trim() as Hex;
  if (!privateKey) throw new Error("CRA_PRIVATE_KEY or CRA_KEY_FILE is required (never paste keys in chat; put them in .env with chmod 600)");
  const signer = createSigner({ scheme: "secp256k1", privateKey });
  const policy = env.CRA_POLICY ? parsePolicyString(env.CRA_POLICY) : DEFAULT_POLICY;
  const agentId = env.CRA_AGENT_ID ?? signer.address.toLowerCase();
  let ledger: Ledger;
  if (env.DATABASE_URL) {
    const pg = new PgLedger(env.DATABASE_URL);
    await pg.migrate();
    ledger = pg;
  } else {
    ledger = new MemoryLedger();
  }
  // One endpoint that is answering right now. Configured ones are preferred, not exclusive: a single
  // configured URL that drops connections is exactly how a deposit failed here.
  const configured = parseRpcList(env.CRA_RPC_URL);
  const candidates = env.CRA_RPC_STRICT === "1" && configured.length > 0 ? configured : mergeRpcLists(configured, PUBLIC_RPCS[network]);
  let rpcUrl: string;
  try {
    rpcUrl = await pickRpcUrl(candidates, CHAIN_IDS[network]);
  } catch (err) {
    // Nothing answered. Commands that need no chain (ledger, policy) must still run, and the ones
    // that do will fail with their own error, so start with the first candidate as before.
    rpcUrl = candidates[0]!;
    console.error(JSON.stringify({ event: "rpc.none_answered", using: redactRpcUrl(rpcUrl), error: (err as Error).message }));
  }
  const identity = (env.CRA_IDENTITY ?? "on") === "off" ? null : createErc8004Resolver({ network, rpcUrl });
  // A Lightning wallet is an explicit choice of whoever runs the agent: with one, the policy also allows the
  // Lightning network, and every limit still applies, a price in sats counted in dollars.
  const payer = env.CRA_NWC_PAY_FILE ? nwcPayer(readConnection(env.CRA_NWC_PAY_FILE)) : null;
  const lnbtc = network === "arc" ? LNBTC_MAINNET : LNBTC_TESTNET;
  const limits = payer && !policy.allowedNetworks.includes(lnbtc) ? { ...policy, allowedNetworks: [...policy.allowedNetworks, lnbtc] } : policy;
  const rail = createRail({ network, signer, policy: limits, ledger, identity, agentId, rpcUrl, log: (e, d) => console.error(JSON.stringify({ event: e, ...d })), ...(payer ? { lightning: { payer, rate: btcUsdRate() } } : {}) });
  const escrow = () => createEscrowClient({ network, signer, rpcUrl, ...(env.CRA_EVALUATOR ? { evaluator: env.CRA_EVALUATOR as Address } : {}) });
  return { rail, ledger, policy: limits, network, agentId, signer, escrow, rpcUrl, close: () => payer?.close() };
}
