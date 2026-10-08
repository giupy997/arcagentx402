/**
 * A spend receipt a third party can check.
 *
 * The receipt says what was bought, for how much, from whom, and under which limits it was allowed:
 * the caps in force and what had already been spent when the rail said yes. It is signed with the
 * agent's own key (EIP-712), so nobody can alter it afterwards without the signature breaking.
 *
 * What the signature proves, precisely: that the holder of the agent's key issued this statement.
 * It is the rail vouching for its own decision, not an outside witness. The independent part of a
 * receipt is the settlement, which anyone can look up on chain. Both belong in the same object.
 *
 * A receipt can carry a second, post-quantum signature over the same digest (pq.ts). Then it is valid
 * only when both signatures are.
 */
import { addUsdc6, compareUsdc6, usdc6 } from "@cra-agent/accounting";
import { hashTypedData, keccak256, recoverTypedDataAddress, toBytes, type Address, type Hex } from "viem";
import { checkPostQuantum, PQ_SCHEME, type PostQuantumKey, type PostQuantumSignature } from "./pq.js";

export const SPEND_RECEIPT_TYPES = {
  SpendReceipt: [
    { name: "agent", type: "address" },
    { name: "resource", type: "string" },
    { name: "payTo", type: "address" },
    { name: "network", type: "string" },
    { name: "amount", type: "uint256" },
    { name: "status", type: "string" },
    { name: "settlementId", type: "string" },
    { name: "policyHash", type: "bytes32" },
    { name: "perPaymentCap", type: "uint256" },
    { name: "dailyCap", type: "uint256" },
    { name: "perSellerCap", type: "uint256" },
    { name: "spentTodayBefore", type: "uint256" },
    { name: "spentWithSellerBefore", type: "uint256" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

/** Amounts are USDC base units (6 decimals). */
export interface SpendReceiptMessage {
  readonly agent: Address;
  readonly resource: string;
  readonly payTo: Address;
  readonly network: string;
  readonly amount: bigint;
  readonly status: string;
  /** Gateway transfer id or transaction hash; empty when nothing was settled. */
  readonly settlementId: string;
  readonly policyHash: Hex;
  readonly perPaymentCap: bigint;
  readonly dailyCap: bigint;
  readonly perSellerCap: bigint;
  readonly spentTodayBefore: bigint;
  readonly spentWithSellerBefore: bigint;
  readonly issuedAt: bigint;
}

export interface SignedSpendReceipt {
  readonly domain: { readonly name: string; readonly version: string; readonly chainId: number };
  /** Same fields as the message, bigints as decimal strings so the object survives JSON. */
  readonly message: { readonly [K in keyof SpendReceiptMessage]: SpendReceiptMessage[K] extends bigint ? string : SpendReceiptMessage[K] };
  readonly signature: Hex;
  /** The same digest signed again with SLH-DSA-SHA2-128s, when the agent has a post-quantum key. */
  readonly postQuantum?: PostQuantumSignature;
}

export const spendReceiptDomain = (chainId: number) => ({ name: "CRA AGENT Spend Receipt", version: "1", chainId }) as const;

/** A stable fingerprint of the limits in force, so a receipt can be tied to one exact policy. */
export function policyHash(description: Record<string, unknown>): Hex {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canonical) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;
  return keccak256(toBytes(JSON.stringify(canonical(description))));
}

const BIG = ["amount", "perPaymentCap", "dailyCap", "perSellerCap", "spentTodayBefore", "spentWithSellerBefore", "issuedAt"] as const;

export function toWire(m: SpendReceiptMessage): SignedSpendReceipt["message"] {
  return { ...m, ...Object.fromEntries(BIG.map((k) => [k, m[k].toString()])) } as unknown as SignedSpendReceipt["message"];
}
export function fromWire(w: SignedSpendReceipt["message"]): SpendReceiptMessage {
  return { ...w, ...Object.fromEntries(BIG.map((k) => [k, BigInt(w[k])])) } as unknown as SpendReceiptMessage;
}

/** The 32 bytes both signatures are over: the receipt's EIP-712 digest. A contract on Arc can compute the same. */
export function receiptDigest(signed: Pick<SignedSpendReceipt, "domain" | "message">): Hex {
  return hashTypedData({ domain: signed.domain, types: SPEND_RECEIPT_TYPES, primaryType: "SpendReceipt", message: fromWire(signed.message) });
}

/** Adds the post-quantum signature to a receipt the wallet key has already signed. */
export function coSignSpendReceipt(signed: SignedSpendReceipt, pq: { readonly key: PostQuantumKey; readonly keyStatement: Hex }): SignedSpendReceipt {
  return { ...signed, postQuantum: { scheme: PQ_SCHEME, publicKey: pq.key.publicKey, keyStatement: pq.keyStatement, signature: pq.key.sign(receiptDigest(signed)) } };
}

export interface SpendReceiptCheck {
  readonly valid: boolean;
  readonly signer: Address | null;
  /** Inside the limits it states: the payment fits every cap given what had been spent. */
  readonly withinStatedLimits: boolean;
  readonly reason: string | null;
  /** Present when the receipt also carries a post-quantum signature and it holds. */
  readonly postQuantum?: { readonly scheme: string; readonly publicKey: Hex };
}

/**
 * Checks a receipt without trusting whoever handed it over: recovers the signer, compares it with
 * the agent named inside, and redoes the arithmetic the receipt claims.
 */
export async function verifySpendReceipt(signed: SignedSpendReceipt, expectedAgent?: Address, opts: { readonly requirePostQuantum?: boolean } = {}): Promise<SpendReceiptCheck> {
  let m: SpendReceiptMessage;
  let signer: Address;
  try {
    m = fromWire(signed.message);
    signer = await recoverTypedDataAddress({ domain: signed.domain, types: SPEND_RECEIPT_TYPES, primaryType: "SpendReceipt", message: m, signature: signed.signature });
  } catch (err) {
    return { valid: false, signer: null, withinStatedLimits: false, reason: `unreadable receipt: ${(err as Error).message.slice(0, 80)}` };
  }
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!same(signer, m.agent)) return { valid: false, signer, withinStatedLimits: false, reason: "signed by a different key than the agent named in the receipt" };
  if (expectedAgent && !same(signer, expectedAgent)) return { valid: false, signer, withinStatedLimits: false, reason: "signed by a different agent than the one expected" };
  // A second signature that is there has to hold: a receipt with a broken one is not half valid.
  if (signed.postQuantum) {
    const wrong = await checkPostQuantum(signed.postQuantum, { agent: m.agent, domain: signed.domain, digest: receiptDigest(signed) });
    if (wrong) return { valid: false, signer, withinStatedLimits: false, reason: wrong };
  } else if (opts.requirePostQuantum) {
    return { valid: false, signer, withinStatedLimits: false, reason: "no post-quantum signature on this receipt" };
  }
  // Money arithmetic goes through the accounting module, here as everywhere else.
  const amount = usdc6(m.amount);
  const fits = (spentBefore: bigint, cap: bigint) => compareUsdc6(addUsdc6(usdc6(spentBefore), amount), usdc6(cap)) <= 0;
  const within = compareUsdc6(amount, usdc6(m.perPaymentCap)) <= 0 && fits(m.spentTodayBefore, m.dailyCap) && fits(m.spentWithSellerBefore, m.perSellerCap);
  const postQuantum = signed.postQuantum ? { postQuantum: { scheme: signed.postQuantum.scheme, publicKey: signed.postQuantum.publicKey } } : {};
  return { valid: true, signer, withinStatedLimits: within, reason: within ? null : "the amounts in the receipt do not fit the limits it states", ...postQuantum };
}
