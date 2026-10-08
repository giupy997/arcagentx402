/**
 * A second signature on a spend receipt, of a kind a quantum computer is not known to break.
 *
 * Every signature the rail makes is secp256k1, which a large enough quantum computer could forge. A receipt is
 * meant to be checked years later, so it can carry a second signature over the same digest: SLH-DSA-SHA2-128s
 * (FIPS 205), the scheme Arc verifies on chain with its PQ Signature Verify precompile. A receipt signed this way
 * is valid only when both signatures are, which is how Circle advises the precompile be used: a post-quantum
 * signature next to a classical one, never instead of it.
 *
 * What it covers, precisely. The receipt, not the payment: a payment on Arc is authorised by the wallet's
 * secp256k1 key until Arc has post-quantum transaction signing. And the SLH-DSA key is tied to the agent by a
 * statement the wallet key signs, so that tie is only as old as the day someone else first saw it. Publishing the
 * public key where it gets a date, in the agent's ERC-8004 registration, is the step after this one.
 */
import { slh_dsa_sha2_128s } from "@noble/post-quantum/slh-dsa.js";
import { decodeFunctionResult, encodeFunctionData, hexToBytes, parseAbi, recoverTypedDataAddress, toHex, type Address, type Hex } from "viem";

export const PQ_SCHEME = "slh-dsa-sha2-128s" as const;
/** Arc's PQ Signature Verify precompile, the same address on mainnet and testnet. */
export const ARC_PQ_VERIFY: Address = "0x1800000000000000000000000000000000000004";
export const ARC_PQ_VERIFY_ABI = parseAbi(["function verifySlhDsaSha2128s(bytes vk, bytes message, bytes sig) view returns (bool)"]);
/** What the key is made from: 48 random bytes, kept like a private key. */
export const PQ_SEED_BYTES = slh_dsa_sha2_128s.lengths.seed!;
const PUBLIC_KEY_BYTES = slh_dsa_sha2_128s.lengths.publicKey!;
const SIGNATURE_BYTES = slh_dsa_sha2_128s.lengths.signature!;

/** The agent's SLH-DSA key. The secret half stays inside: all it gives out is signatures. */
export interface PostQuantumKey {
  readonly scheme: typeof PQ_SCHEME;
  /** 32 bytes. */
  readonly publicKey: Hex;
  /** Signs a 32-byte digest. About a second of work: SLH-DSA trades slow signing for small keys and plain hashes. */
  sign(digest: Hex): Hex;
}

export function newPostQuantumSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(PQ_SEED_BYTES));
}

/** The seed as a key file holds it: hex, with or without 0x. Says what is wrong without repeating the secret. */
export function parsePostQuantumSeed(text: string): Uint8Array {
  const hex = text.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length !== PQ_SEED_BYTES * 2) throw new Error(`a post-quantum key file holds ${PQ_SEED_BYTES} bytes of hex (${PQ_SEED_BYTES * 2} characters); make one with: cra-agent pq-key <file>`);
  return hexToBytes(`0x${hex}`);
}

export function postQuantumKey(seed: Uint8Array): PostQuantumKey {
  if (seed.length !== PQ_SEED_BYTES) throw new Error(`a post-quantum seed is ${PQ_SEED_BYTES} bytes, got ${seed.length}`);
  const { publicKey, secretKey } = slh_dsa_sha2_128s.keygen(seed);
  return { scheme: PQ_SCHEME, publicKey: toHex(publicKey), sign: (digest) => toHex(slh_dsa_sha2_128s.sign(hexToBytes(digest), secretKey)) };
}

/** The wallet key saying "this SLH-DSA key is mine". Signed once; every receipt carries it. */
export const POST_QUANTUM_KEY_TYPES = {
  PostQuantumKey: [
    { name: "agent", type: "address" },
    { name: "scheme", type: "string" },
    { name: "publicKey", type: "bytes32" },
  ],
} as const;

type Domain = { readonly name: string; readonly version: string; readonly chainId: number };

export function signKeyStatement(account: { address: Address; signTypedData: (args: any) => Promise<Hex> }, domain: Domain, publicKey: Hex): Promise<Hex> {
  return account.signTypedData({ domain, types: POST_QUANTUM_KEY_TYPES, primaryType: "PostQuantumKey", message: { agent: account.address, scheme: PQ_SCHEME, publicKey } });
}

export interface PostQuantumSignature {
  readonly scheme: typeof PQ_SCHEME;
  /** The agent's SLH-DSA public key, 32 bytes. */
  readonly publicKey: Hex;
  /** The agent's wallet key vouching for that public key (EIP-712, the receipt's own domain). */
  readonly keyStatement: Hex;
  /** SLH-DSA signature over the receipt's EIP-712 digest, 7,856 bytes. */
  readonly signature: Hex;
}

const bytesOf = (h: unknown): number => (typeof h === "string" && /^0x([0-9a-fA-F]{2})*$/.test(h) ? (h.length - 2) / 2 : -1);

/**
 * Checks the second signature of a receipt: the key is the agent's own, and it signed this digest.
 * Null when both hold, otherwise what is wrong. Needs no network.
 */
export async function checkPostQuantum(pq: PostQuantumSignature, o: { agent: Address; domain: Domain; digest: Hex }): Promise<string | null> {
  if (pq?.scheme !== PQ_SCHEME) return `post-quantum scheme ${String(pq?.scheme)} is not one this version checks`;
  if (bytesOf(pq.publicKey) !== PUBLIC_KEY_BYTES) return `the post-quantum public key is not ${PUBLIC_KEY_BYTES} bytes`;
  if (bytesOf(pq.signature) !== SIGNATURE_BYTES) return `the post-quantum signature is not ${SIGNATURE_BYTES} bytes`;
  let vouchedBy: Address;
  try {
    vouchedBy = await recoverTypedDataAddress({ domain: o.domain, types: POST_QUANTUM_KEY_TYPES, primaryType: "PostQuantumKey", message: { agent: o.agent, scheme: PQ_SCHEME, publicKey: pq.publicKey }, signature: pq.keyStatement });
  } catch {
    return "the statement tying the post-quantum key to the agent cannot be read";
  }
  if (vouchedBy.toLowerCase() !== o.agent.toLowerCase()) return "the post-quantum key is not vouched for by the agent's wallet key";
  let signed = false;
  try {
    signed = slh_dsa_sha2_128s.verify(hexToBytes(pq.signature), hexToBytes(o.digest), hexToBytes(pq.publicKey));
  } catch {
    signed = false;
  }
  return signed ? null : "the post-quantum signature does not match the receipt";
}

/** The call that asks Arc itself: the precompile takes the key, the message and the signature, and answers a bool. */
export function arcVerifyCall(pq: Pick<PostQuantumSignature, "publicKey" | "signature">, digest: Hex): { to: Address; data: Hex } {
  return { to: ARC_PQ_VERIFY, data: encodeFunctionData({ abi: ARC_PQ_VERIFY_ABI, functionName: "verifySlhDsaSha2128s", args: [pq.publicKey, digest, pq.signature] }) };
}

/**
 * Has Arc verify the signature, with a read-only call to its precompile: nothing is sent, nothing is paid.
 * It checks the SLH-DSA signature alone; whose key it is, is checkPostQuantum's question.
 */
export async function verifiedByArc(pq: Pick<PostQuantumSignature, "publicKey" | "signature">, digest: Hex, rpcUrl: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const res = await fetchImpl(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [arcVerifyCall(pq, digest), "latest"] }) });
  const body = (await res.json()) as { result?: Hex; error?: { message?: string } };
  if (!body.result) throw new Error(`Arc did not answer the post-quantum check: ${body.error?.message ?? `HTTP ${res.status}`}`);
  return decodeFunctionResult({ abi: ARC_PQ_VERIFY_ABI, functionName: "verifySlhDsaSha2128s", data: body.result });
}
