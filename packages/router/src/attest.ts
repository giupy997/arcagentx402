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
 */
import { addUsdc6, compareUsdc6, usdc6 } from "@cra-agent/accounting";
import { keccak256, recoverTypedDataAddress, toBytes, type Address, type Hex } from "viem";

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

export interface SpendReceiptCheck {
  readonly valid: boolean;
  readonly signer: Address | null;
  /** Inside the limits it states: the payment fits every cap given what had been spent. */
  readonly withinStatedLimits: boolean;
  readonly reason: string | null;
}

/**
 * Checks a receipt without trusting whoever handed it over: recovers the signer, compares it with
 * the agent named inside, and redoes the arithmetic the receipt claims.
 */
export async function verifySpendReceipt(signed: SignedSpendReceipt, expectedAgent?: Address): Promise<SpendReceiptCheck> {
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
  // Money arithmetic goes through the accounting module, here as everywhere else.
  const amount = usdc6(m.amount);
  const fits = (spentBefore: bigint, cap: bigint) => compareUsdc6(addUsdc6(usdc6(spentBefore), amount), usdc6(cap)) <= 0;
  const within = compareUsdc6(amount, usdc6(m.perPaymentCap)) <= 0 && fits(m.spentTodayBefore, m.dailyCap) && fits(m.spentWithSellerBefore, m.perSellerCap);
  return { valid: true, signer, withinStatedLimits: within, reason: within ? null : "the amounts in the receipt do not fit the limits it states" };
}
