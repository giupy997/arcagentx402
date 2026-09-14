/**
 * @cra-agent/identity — who signs, and who the counterparty is. Two separate concerns, one thin package.
 *
 * Signing: the scheme is an explicit parameter (brief §4.3). One implementation today (secp256k1 / ECDSA
 * via viem). SLH-DSA-SHA2-128s is reserved so nothing else in the repo assumes ECDSA.
 *
 * Counterparty identity: ERC-8004 IdentityRegistry lookup. Fail closed: any error = not verified.
 */
import { createPublicClient, http, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { arc, arcTestnet } from "viem/chains";

export type SignatureScheme = "secp256k1" | "slh-dsa-sha2-128s";

export interface RailSigner {
  readonly scheme: SignatureScheme;
  readonly address: Address;
  /** viem account; the x402 schemes need signTypedData. */
  readonly account: PrivateKeyAccount;
}

export interface CreateSignerOptions {
  readonly scheme: SignatureScheme;
  readonly privateKey: Hex;
}

export function createSigner(opts: CreateSignerOptions): RailSigner {
  switch (opts.scheme) {
    case "secp256k1": {
      const account = privateKeyToAccount(opts.privateKey);
      return { scheme: "secp256k1", address: account.address, account };
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

/** From docs.arc.io/arc/tutorials/register-your-first-ai-agent (2026-09-14). Mainnet: not published yet. */
export const ERC8004_IDENTITY_REGISTRY: Record<ArcNetwork, Address | null> = {
  arcTestnet: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  arc: null,
};

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

const REGISTRY_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "tokenOfOwnerByIndex", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "index", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "string" }] },
] as const;

export interface Erc8004ResolverOptions {
  readonly network: ArcNetwork;
  readonly rpcUrl?: string;
  readonly registry?: Address;
  readonly cacheTtlMs?: number;
}

/**
 * "Verified" = the address owns at least one agent identity NFT in the registry.
 * The tokenURI is fetched when the registry is enumerable; otherwise agentIds stays empty but verified is still true.
 */
export function createErc8004Resolver(opts: Erc8004ResolverOptions): IdentityResolver {
  const registry = opts.registry ?? ERC8004_IDENTITY_REGISTRY[opts.network];
  const chain = CHAINS[opts.network];
  const client = createPublicClient({ chain, transport: http(opts.rpcUrl) });
  const ttl = opts.cacheTtlMs ?? 10 * 60_000;
  const cache = new Map<string, IdentityResult>();
  return {
    async resolve(address: Address): Promise<IdentityResult> {
      const key = address.toLowerCase();
      const hit = cache.get(key);
      if (hit && Date.now() - hit.checkedAt.getTime() < ttl) return hit;
      const base = { address, agentIds: [] as bigint[], metadataURI: null as string | null, registry, checkedAt: new Date() };
      if (!registry) {
        const r = { ...base, verified: false, error: `no ERC-8004 registry known for ${opts.network}` };
        cache.set(key, r);
        return r;
      }
      try {
        const balance = await client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "balanceOf", args: [address] });
        if (balance === 0n) {
          const r = { ...base, verified: false, error: null };
          cache.set(key, r);
          return r;
        }
        let agentIds: bigint[] = [];
        let metadataURI: string | null = null;
        try {
          const id = await client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "tokenOfOwnerByIndex", args: [address, 0n] });
          agentIds = [id];
          metadataURI = await client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "tokenURI", args: [id] });
        } catch {
          /* registry not enumerable: identity still verified by balance */
        }
        const r = { ...base, verified: true, agentIds, metadataURI, error: null };
        cache.set(key, r);
        return r;
      } catch (err) {
        // fail closed, but do not cache failures for long
        return { ...base, verified: false, error: (err as Error).message.slice(0, 200) };
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
