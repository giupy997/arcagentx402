/**
 * @cra-agent/identity — who signs, and who the counterparty is. Two separate concerns, one thin package.
 *
 * Signing: the scheme is an explicit parameter (brief §4.3). One implementation today (secp256k1 / ECDSA
 * via viem). SLH-DSA-SHA2-128s is reserved so nothing else in the repo assumes ECDSA.
 *
 * Counterparty identity: ERC-8004 IdentityRegistry lookup. Fail closed: any error = not verified.
 */
import { createPublicClient, createWalletClient, http, parseEventLogs, type Address, type Chain, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { arc, arcTestnet } from "viem/chains";

export type SignatureScheme = "secp256k1" | "slh-dsa-sha2-128s";

export interface RailSigner {
  readonly scheme: SignatureScheme;
  readonly address: Address;
  /** viem account; the x402 schemes need signTypedData. */
  readonly account: PrivateKeyAccount;
  /** Only for the Gateway SDK (deposit/balances), which wants the raw key. Never log this. */
  readonly privateKey: Hex;
}

export interface CreateSignerOptions {
  readonly scheme: SignatureScheme;
  readonly privateKey: Hex;
}

export function createSigner(opts: CreateSignerOptions): RailSigner {
  switch (opts.scheme) {
    case "secp256k1": {
      const account = privateKeyToAccount(opts.privateKey);
      return { scheme: "secp256k1", address: account.address, account, privateKey: opts.privateKey };
    }
    case "slh-dsa-sha2-128s":
      throw new Error("slh-dsa-sha2-128s: post-quantum signing is not implemented yet (Arc beta support; see docs.arc.io/arc/concepts/post-quantum-security)");
    default:
      throw new Error(`unknown signature scheme ${String((opts as { scheme: string }).scheme)}`);
  }
}

// ---------------------------------------------------------------------------
// ERC-8004 identity
// ---------------------------------------------------------------------------

export type ArcNetwork = "arc" | "arcTestnet";

/**
 * Testnet: docs.arc.io/arc/tutorials/register-your-first-ai-agent. Mainnet: the ERC-8004 team's canonical mainnet
 * addresses (github.com/erc-8004/erc-8004-contracts, scripts/addresses.ts), the same on every chain. Found live on Arc
 * on 2026-09-23 behind the same verified implementation as testnet (0x7274e874…); Arc's docs still list only the
 * testnet ones, which is why this said "testnet only" from launch day until then.
 */
export const ERC8004_IDENTITY_REGISTRY: Record<ArcNetwork, Address | null> = {
  arcTestnet: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  arc: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
};
export const ERC8004_REPUTATION_REGISTRY: Record<ArcNetwork, Address | null> = {
  arcTestnet: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  arc: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
};
/** Multicall3 at its usual address: a genesis predeploy on both Arc networks, though viem only declares it for testnet. */
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

export const CHAINS: Record<ArcNetwork, Chain> = { arc, arcTestnet };
export const CAIP2: Record<ArcNetwork, string> = { arc: `eip155:${arc.id}`, arcTestnet: `eip155:${arcTestnet.id}` };

export interface IdentityResult {
  readonly address: Address;
  readonly verified: boolean;
  readonly agentIds: readonly bigint[];
  readonly metadataURI: string | null;
  readonly registry: Address | null;
  readonly checkedAt: Date;
  readonly error: string | null;
}

export interface IdentityResolver {
  resolve(address: Address): Promise<IdentityResult>;
}

/**
 * Subset of IdentityRegistryUpgradeable (verified impl 0x7274e874ca62410a93bd8bf61c69d8045e399c02 behind the testnet
 * proxy, read 2026-09-15). The registry is ERC-721 but NOT enumerable: owner -> agentId comes from the Registered event.
 */
export const REGISTRY_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "string" }] },
  { type: "function", name: "getAgentWallet", stateMutability: "view", inputs: [{ name: "agentId", type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }], outputs: [{ type: "uint256" }] },
  { type: "event", name: "Registered", inputs: [{ name: "agentId", type: "uint256", indexed: true }, { name: "agentURI", type: "string", indexed: false }, { name: "owner", type: "address", indexed: true }] },
] as const;

export interface Erc8004ResolverOptions {
  readonly network: ArcNetwork;
  readonly rpcUrl?: string;
  readonly registry?: Address;
  readonly cacheTtlMs?: number;
  /** Stop reading the registry past this many agents. Default 5000. */
  readonly maxAgents?: number;
  /** For tests: what the resolver reads the registry through. */
  readonly reader?: RegistryReader;
}

/** One agent as the registry holds it: who owns it, and the wallet it declared for receiving payments. */
export interface RegistryAgent {
  readonly agentId: bigint;
  readonly owner: Address;
  readonly wallet: Address | null;
}

/** The three reads the resolver needs. A viem client fits; so does a fake in a test. */
export interface RegistryReader {
  balanceOf(owner: Address): Promise<bigint>;
  /** Owner and declared wallet of each id, or null where the id does not exist. */
  agents(ids: readonly bigint[]): Promise<Array<{ owner: Address; wallet: Address | null } | null>>;
  tokenURI(agentId: bigint): Promise<string | null>;
}

const ZERO = "0x0000000000000000000000000000000000000000";

export function viemRegistryReader(client: PublicClient, registry: Address): RegistryReader {
  return {
    balanceOf: (owner) => client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "balanceOf", args: [owner] }),
    async agents(ids) {
      const contracts = ids.flatMap((id) => [
        { address: registry, abi: REGISTRY_ABI, functionName: "ownerOf" as const, args: [id] as const },
        { address: registry, abi: REGISTRY_ABI, functionName: "getAgentWallet" as const, args: [id] as const },
      ]);
      // One request per few hundred agents instead of one per call.
      const res = await client.multicall({ contracts, allowFailure: true, multicallAddress: MULTICALL3, batchSize: 131_072 });
      return ids.map((_, i) => {
        const owner = res[2 * i];
        const wallet = res[2 * i + 1];
        if (!owner || owner.status !== "success") return null;
        const w = wallet && wallet.status === "success" ? (wallet.result as Address) : null;
        return { owner: owner.result as Address, wallet: w && w !== ZERO ? w : null };
      });
    },
    tokenURI: (agentId) => client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "tokenURI", args: [agentId] }).catch(() => null),
  };
}

/**
 * Every agent in the registry. Ids are handed out in order from 0 and the registry is not enumerable, so pages
 * of ids are read until one comes back empty.
 */
export async function scanRegistry(reader: RegistryReader, maxAgents = 5000, page = 250): Promise<{ agents: RegistryAgent[]; complete: boolean }> {
  const agents: RegistryAgent[] = [];
  for (let from = 0; from < maxAgents; from += page) {
    const ids = Array.from({ length: Math.min(page, maxAgents - from) }, (_, i) => BigInt(from + i));
    const found = await reader.agents(ids);
    let any = false;
    found.forEach((a, i) => {
      if (!a) return;
      any = true;
      agents.push({ agentId: ids[i]!, owner: a.owner, wallet: a.wallet });
    });
    if (!any || found[found.length - 1] === null) return { agents, complete: true };
  }
  return { agents, complete: false };
}

/**
 * "Verified" means the address is an ERC-8004 agent's owner, or the wallet an agent declared for receiving payments
 * (declaring one takes a signature from that wallet, so it cannot be claimed for someone else's address). It says the
 * address has an identity on chain, not that it is honest: registering costs only gas.
 */
export function createErc8004Resolver(opts: Erc8004ResolverOptions): IdentityResolver {
  const registry = opts.registry ?? ERC8004_IDENTITY_REGISTRY[opts.network];
  const reader = opts.reader ?? (registry ? viemRegistryReader(createPublicClient({ chain: CHAINS[opts.network], transport: http(opts.rpcUrl) }) as PublicClient, registry) : null);
  const ttl = opts.cacheTtlMs ?? 10 * 60_000;
  const cache = new Map<string, IdentityResult>();
  // The registry read is shared by every address resolved in the next ten minutes.
  let scan: { at: number; result: Promise<{ agents: RegistryAgent[]; complete: boolean }> } | null = null;
  const agents = (): Promise<{ agents: RegistryAgent[]; complete: boolean }> => {
    if (!scan || Date.now() - scan.at > ttl) {
      const result = scanRegistry(reader!, opts.maxAgents ?? 5000);
      scan = { at: Date.now(), result };
      result.catch(() => {
        scan = null;
      });
    }
    return scan.result;
  };
  return {
    async resolve(address: Address): Promise<IdentityResult> {
      const key = address.toLowerCase();
      const hit = cache.get(key);
      if (hit && Date.now() - hit.checkedAt.getTime() < ttl) return hit;
      const base = { address, agentIds: [] as bigint[], metadataURI: null as string | null, registry, checkedAt: new Date() };
      if (!registry || !reader) {
        const r = { ...base, verified: false, error: `no ERC-8004 registry known for ${opts.network}` };
        cache.set(key, r);
        return r;
      }
      let owned: bigint;
      try {
        owned = await reader.balanceOf(address);
      } catch (err) {
        // fail closed, but do not cache failures for long
        return { ...base, verified: false, error: (err as Error).message.slice(0, 200) };
      }
      try {
        const { agents: all, complete } = await agents();
        const ids = all.filter((a) => a.owner.toLowerCase() === key || a.wallet?.toLowerCase() === key).map((a) => a.agentId);
        const verified = owned > 0n || ids.length > 0;
        const r = { ...base, verified, agentIds: ids, metadataURI: ids[0] === undefined ? null : await reader.tokenURI(ids[0]), error: complete ? null : `registry read up to ${all.length} agents only` };
        cache.set(key, r);
        return r;
      } catch (err) {
        // Without the list, ownership alone still decides; a declared wallet cannot be recognised.
        const r = { ...base, verified: owned > 0n, error: `registry list unavailable: ${(err as Error).message.slice(0, 160)}` };
        cache.set(key, r);
        return r;
      }
    },
  };
}

/** Resolver for tests / opt-out: everything unverified. */
export const NULL_IDENTITY: IdentityResolver = {
  async resolve(address) {
    return { address, verified: false, agentIds: [], metadataURI: null, registry: null, checkedAt: new Date(), error: "identity checks disabled" };
  },
};


// ---------------------------------------------------------------------------
// Registering our own identity (sellers and agents alike)
// ---------------------------------------------------------------------------

export interface RegisterIdentityOptions {
  readonly network: ArcNetwork;
  readonly signer: RailSigner;
  /** Agent metadata URI (ERC-8004 agent card, e.g. https://cra-agent.tech/.well-known/agent.json). */
  readonly agentURI: string;
  readonly rpcUrl?: string;
  readonly registry?: Address;
}

/** Mints an ERC-8004 identity for the signer. Costs gas (USDC on Arc). Returns the agentId from the Registered event. */
export async function registerIdentity(opts: RegisterIdentityOptions): Promise<{ agentId: bigint; txHash: Hex; registry: Address }> {
  const registry = opts.registry ?? ERC8004_IDENTITY_REGISTRY[opts.network];
  if (!registry) throw new Error(`no ERC-8004 registry known for ${opts.network}`);
  const chain = CHAINS[opts.network];
  const transport = http(opts.rpcUrl);
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ chain, transport, account: opts.signer.account });
  const { request } = await pub.simulateContract({ address: registry, abi: REGISTRY_ABI, functionName: "register", args: [opts.agentURI], account: opts.signer.account });
  const txHash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`register reverted in ${txHash}`);
  const [ev] = parseEventLogs({ abi: REGISTRY_ABI, eventName: "Registered", logs: receipt.logs });
  if (!ev) throw new Error("register: no Registered event in receipt");
  return { agentId: ev.args.agentId, txHash, registry };
}

export * from "./rpc.js";
