import { readFileSync } from "node:fs";
import { createErc8004Resolver, createSigner, type ArcNetwork } from "@cra-agent/identity";
import { MemoryLedger, PgLedger, type Ledger } from "@cra-agent/ledger";
import { DEFAULT_POLICY, parsePolicyString, type SpendPolicy } from "@cra-agent/policy";
import { createRail, type Rail } from "@cra-agent/router";
import type { Hex } from "viem";

/**
 * Environment contract for the MCP server (and the CLI):
 *   CRA_NETWORK       arc | arcTestnet            (default arcTestnet)
 *   CRA_PRIVATE_KEY   0x…  or CRA_KEY_FILE=path (file containing the key; chmod 600)
 *   CRA_POLICY        "daily=5,per_seller=0.5,per_payment=0.05,rate=120/60s,identity=required,allow=a|b"
 *   CRA_AGENT_ID      ledger key for this agent (default: signer address)
 *   CRA_RPC_URL       optional RPC (required for arc mainnet until public RPCs exist)
 *   CRA_IDENTITY      on | off  (default on)
 *   DATABASE_URL          optional; with it the ledger is Postgres, without it in-memory
 */
export interface RailFromEnv { rail: Rail; ledger: Ledger; policy: SpendPolicy; network: ArcNetwork; agentId: string }

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
  const identity = (env.CRA_IDENTITY ?? "on") === "off" ? null : createErc8004Resolver({ network, ...(env.CRA_RPC_URL ? { rpcUrl: env.CRA_RPC_URL } : {}) });
  const rail = createRail({ network, signer, policy, ledger, identity, agentId, ...(env.CRA_RPC_URL ? { rpcUrl: env.CRA_RPC_URL } : {}), log: (e, d) => console.error(JSON.stringify({ event: e, ...d })) });
  return { rail, ledger, policy, network, agentId };
}
