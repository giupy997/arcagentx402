import { readFileSync } from "node:fs";
import { createErc8004Resolver, createSigner, type ArcNetwork } from "@arc-rail/identity";
import { MemoryLedger, PgLedger, type Ledger } from "@arc-rail/ledger";
import { DEFAULT_POLICY, parsePolicyString, type SpendPolicy } from "@arc-rail/policy";
import { createRail, type Rail } from "@arc-rail/router";
import type { Hex } from "viem";

/**
 * Environment contract for the MCP server (and the CLI):
 *   ARCRAIL_NETWORK       arc | arcTestnet            (default arcTestnet)
 *   ARCRAIL_PRIVATE_KEY   0x…  or ARCRAIL_KEY_FILE=path (file containing the key; chmod 600)
 *   ARCRAIL_POLICY        "daily=5,per_seller=0.5,per_payment=0.05,rate=120/60s,identity=required,allow=a|b"
 *   ARCRAIL_AGENT_ID      ledger key for this agent (default: signer address)
 *   ARCRAIL_RPC_URL       optional RPC (required for arc mainnet until public RPCs exist)
 *   ARCRAIL_IDENTITY      on | off  (default on)
 *   DATABASE_URL          optional; with it the ledger is Postgres, without it in-memory
 */
export interface RailFromEnv { rail: Rail; ledger: Ledger; policy: SpendPolicy; network: ArcNetwork; agentId: string }

export async function railFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<RailFromEnv> {
  const network = (env.ARCRAIL_NETWORK ?? "arcTestnet") as ArcNetwork;
  if (network !== "arc" && network !== "arcTestnet") throw new Error(`ARCRAIL_NETWORK must be arc or arcTestnet, got ${network}`);
  let privateKey = env.ARCRAIL_PRIVATE_KEY as Hex | undefined;
  if (!privateKey && env.ARCRAIL_KEY_FILE) privateKey = readFileSync(env.ARCRAIL_KEY_FILE, "utf8").trim() as Hex;
  if (!privateKey) throw new Error("ARCRAIL_PRIVATE_KEY or ARCRAIL_KEY_FILE is required (never paste keys in chat; put them in .env with chmod 600)");
  const signer = createSigner({ scheme: "secp256k1", privateKey });
  const policy = env.ARCRAIL_POLICY ? parsePolicyString(env.ARCRAIL_POLICY) : DEFAULT_POLICY;
  const agentId = env.ARCRAIL_AGENT_ID ?? signer.address.toLowerCase();
  let ledger: Ledger;
  if (env.DATABASE_URL) {
    const pg = new PgLedger(env.DATABASE_URL);
    await pg.migrate();
    ledger = pg;
  } else {
    ledger = new MemoryLedger();
  }
  const identity = (env.ARCRAIL_IDENTITY ?? "on") === "off" ? null : createErc8004Resolver({ network, ...(env.ARCRAIL_RPC_URL ? { rpcUrl: env.ARCRAIL_RPC_URL } : {}) });
  const rail = createRail({ network, signer, policy, ledger, identity, agentId, ...(env.ARCRAIL_RPC_URL ? { rpcUrl: env.ARCRAIL_RPC_URL } : {}), log: (e, d) => console.error(JSON.stringify({ event: e, ...d })) });
  return { rail, ledger, policy, network, agentId };
}
