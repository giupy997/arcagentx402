/**
 * Everything a third party needs to check a receipt, and nothing a wallet needs: no key, no rail, no database.
 * It is small enough to run in a browser, which is where cra-agent.tech/verify runs it.
 *
 * The checks are reported one by one rather than as a single verdict, so whoever reads the result sees which
 * part holds: the wallet's signature, the arithmetic, the post-quantum signature, and Arc's own answer on it.
 */
import type { Address } from "viem";
import { receiptDigest, verifySpendReceipt, type SignedSpendReceipt } from "./attest.js";
import { checkPostQuantum, verifiedByArc } from "./pq.js";

export * from "./attest.js";
export * from "./pq.js";

/** The signed object inside whatever was handed over: itself, a receipt that carries it, or the whole output of `pay`. */
export function findSignedReceipt(raw: unknown): SignedSpendReceipt | null {
  const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const outer = obj(raw);
  if (!outer) return null;
  const receipt = obj(outer.receipt) ?? outer;
  const signed = obj(receipt.attestation) ?? receipt;
  return obj(signed.domain) && obj(signed.message) && typeof signed.signature === "string" ? (signed as unknown as SignedSpendReceipt) : null;
}

export interface ReceiptCheck {
  readonly ok: boolean;
  readonly detail: string;
}

export interface ReceiptReport {
  /** The wallet key's signature: the agent named in the receipt issued it, and nothing was changed since. */
  readonly wallet: ReceiptCheck;
  /** The arithmetic: the payment fits the limits the receipt states. */
  readonly limits: ReceiptCheck;
  /** The second signature, checked here. Null when the receipt has none. */
  readonly postQuantum: ReceiptCheck | null;
  /** The second signature, checked by Arc's precompile. Null when nobody asked, or there was nothing to ask about. */
  readonly arc: (ReceiptCheck & { readonly answered: boolean; readonly endpoint: string | null }) | null;
  /** Every check that ran holds. An Arc that could not be reached does not make a receipt invalid. */
  readonly valid: boolean;
}

export interface InspectOptions {
  readonly expectedAgent?: Address;
  /** Arc endpoints to ask about the post-quantum signature, tried in order. Without any, Arc is not asked. */
  readonly arcRpcUrls?: readonly string[];
  readonly fetch?: typeof fetch;
}

export async function inspectReceipt(signed: SignedSpendReceipt, opts: InspectOptions = {}): Promise<ReceiptReport> {
  const { postQuantum: second, ...first } = signed;
  const classic = await verifySpendReceipt(first, opts.expectedAgent);
  const wallet: ReceiptCheck = classic.valid ? { ok: true, detail: `signed by ${classic.signer}, the agent it names` } : { ok: false, detail: classic.reason ?? "the signature does not hold" };
  const limits: ReceiptCheck = !classic.valid
    ? { ok: false, detail: "not checked: the figures cannot be trusted without the signature" }
    : classic.withinStatedLimits
      ? { ok: true, detail: "the payment fits the limits the receipt states" }
      : { ok: false, detail: classic.reason ?? "the amounts do not fit the limits the receipt states" };

  let postQuantum: ReceiptReport["postQuantum"] = null;
  let arc: ReceiptReport["arc"] = null;
  if (second) {
    let wrong: string | null;
    let digest: `0x${string}` | null = null;
    try {
      digest = receiptDigest(signed);
      wrong = await checkPostQuantum(second, { agent: signed.message.agent, domain: signed.domain, digest });
    } catch (err) {
      wrong = `unreadable receipt: ${(err as Error).message.slice(0, 80)}`;
    }
    postQuantum = wrong ? { ok: false, detail: wrong } : { ok: true, detail: `${second.scheme}, public key ${second.publicKey}` };
    // Arc is asked only about a signature that is well formed: the precompile reverts on a wrong length.
    if (!wrong && digest && opts.arcRpcUrls?.length) {
      let failure = "no endpoint answered";
      for (const url of opts.arcRpcUrls) {
        try {
          const ok = await verifiedByArc(second, digest, url, opts.fetch);
          arc = { ok, answered: true, endpoint: url, detail: ok ? "Arc's precompile verified the signature" : "Arc's precompile says the signature is not valid" };
          break;
        } catch (err) {
          failure = (err as Error).message.slice(0, 120);
        }
      }
      arc ??= { ok: false, answered: false, endpoint: null, detail: `Arc could not be asked: ${failure}` };
    }
  }
  const valid = wallet.ok && limits.ok && (postQuantum?.ok ?? true) && !(arc?.answered && !arc.ok);
  return { wallet, limits, postQuantum, arc, valid };
}
