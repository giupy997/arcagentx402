/**
 * BOLT11 invoices, decoded strictly and signed: what the x402 `exact` scheme on `lnbtc` checks before a
 * payment (the client) and before a proof is accepted (the facilitator). Decoding recovers the key that
 * signed the invoice, or checks the signature against the `n` field when there is one, so "the invoice
 * signing key equals payTo" is a fact about the signature, not about a field anyone could write.
 *
 * Encoding exists for tests and for a local receiver that signs with a key of its own.
 */
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bech32 } from "@scure/base";

export type Bolt11Currency = "bc" | "tb";

export interface Bolt11 {
  /** The whole invoice, lowercase, as it was given. */
  readonly invoice: string;
  readonly currency: Bolt11Currency;
  /** Integral millisatoshis, as a decimal string; null when the invoice names no amount. */
  readonly amountMsat: string | null;
  /** Unix seconds. */
  readonly timestamp: number;
  /** Seconds after `timestamp`; 3600 when the invoice does not say. */
  readonly expiry: number;
  /** 64 lowercase hex characters. */
  readonly paymentHash: string;
  readonly paymentSecret: string | null;
  /** 64 lowercase hex characters, or null. */
  readonly descriptionHash: string | null;
  /** An inline description, or null. */
  readonly description: string | null;
  /** The compressed public key that signed the invoice, 66 lowercase hex characters. */
  readonly payee: string;
  /** Whether the invoice carried its payee in an `n` field. */
  readonly payeeStated: boolean;
  readonly minFinalCltvExpiry: number | null;
}

export class Bolt11Error extends Error {
  override readonly name = "Bolt11Error";
}

const sha256 = (...parts: Uint8Array[]): Uint8Array => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const fromHex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"));

/** BOLT11's multipliers, as millisatoshis per unit of the written amount (p is a tenth of a millisatoshi). */
const MSAT_PER: Record<string, { num: bigint; den: bigint }> = {
  "": { num: 100_000_000_000n, den: 1n },
  m: { num: 100_000_000n, den: 1n },
  u: { num: 100_000n, den: 1n },
  n: { num: 100n, den: 1n },
  p: { num: 1n, den: 10n },
};

const TAG = { p: 1, s: 16, d: 13, h: 23, x: 6, c: 24, n: 19, f: 9, r: 3, features: 5, m: 27 } as const;

function wordsToInt(words: readonly number[]): number {
  let n = 0;
  for (const w of words) n = n * 32 + w;
  return n;
}

function intToWords(n: number, min = 1): number[] {
  const out: number[] = [];
  let v = n;
  do {
    out.unshift(v % 32);
    v = Math.floor(v / 32);
  } while (v > 0);
  while (out.length < min) out.unshift(0);
  return out;
}

/** 5-bit words to bytes, the last byte padded with zero bits: what the signature covers. */
function wordsToBytesPadded(words: readonly number[]): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out.push((acc << (8 - bits)) & 0xff);
  return new Uint8Array(out);
}

/** A field's words to bytes: exactly `size` bytes, and the padding bits must be zero. */
function fieldBytes(words: readonly number[], size: number, what: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = bech32.fromWords([...words]);
  } catch {
    throw new Bolt11Error(`${what} has non-zero padding`);
  }
  if (bytes.length !== size) throw new Bolt11Error(`${what} is ${bytes.length} bytes, not ${size}`);
  return bytes;
}

function parseHrp(hrp: string): { currency: Bolt11Currency; amountMsat: string | null } {
  const m = /^ln(bc|tb)(?:([1-9][0-9]*)([munp]?))?$/.exec(hrp);
  if (!m) throw new Bolt11Error(`not a mainnet or testnet invoice prefix: ${hrp.slice(0, 16)}`);
  const currency = m[1] as Bolt11Currency;
  if (m[2] === undefined) return { currency, amountMsat: null };
  const unit = MSAT_PER[m[3] ?? ""]!;
  const scaled = BigInt(m[2]) * unit.num;
  if (scaled % unit.den !== 0n) throw new Bolt11Error("the amount is not a whole number of millisatoshis");
  return { currency, amountMsat: (scaled / unit.den).toString() };
}

/**
 * Decodes an invoice strictly: a known currency, a whole number of millisatoshis, exactly one payment hash,
 * no repeated field that must be unique, zero padding, and a signature that holds.
 */
export function decodeBolt11(input: string): Bolt11 {
  if (typeof input !== "string" || input.length === 0) throw new Bolt11Error("no invoice");
  const invoice = input.trim();
  if (invoice !== invoice.toLowerCase() && invoice !== invoice.toUpperCase()) throw new Bolt11Error("mixed case");
  const lower = invoice.toLowerCase();
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32.decode(lower as `${string}1${string}`, false);
  } catch (err) {
    throw new Bolt11Error(`not bech32: ${(err as Error).message}`);
  }
  const { prefix, words } = decoded;
  const { currency, amountMsat } = parseHrp(prefix);
  if (words.length < 7 + 104) throw new Bolt11Error("too short");
  const sigWords = words.slice(-104);
  const data = words.slice(0, -104);
  const timestamp = wordsToInt(data.slice(0, 7));

  let paymentHash: string | null = null;
  let paymentSecret: string | null = null;
  let descriptionHash: string | null = null;
  let description: string | null = null;
  let payeeField: Uint8Array | null = null;
  let expiry: number | null = null;
  let minFinalCltvExpiry: number | null = null;
  const seen = new Set<number>();
  const once = (type: number, what: string) => {
    if (seen.has(type)) throw new Bolt11Error(`more than one ${what}`);
    seen.add(type);
  };

  let i = 7;
  while (i < data.length) {
    if (i + 3 > data.length) throw new Bolt11Error("a field runs past the end");
    const type = data[i]!;
    const len = data[i + 1]! * 32 + data[i + 2]!;
    const field = data.slice(i + 3, i + 3 + len);
    if (field.length !== len) throw new Bolt11Error("a field runs past the end");
    i += 3 + len;
    switch (type) {
      case TAG.p:
        once(type, "payment hash");
        if (len !== 52) throw new Bolt11Error("payment hash is not 52 words");
        paymentHash = hex(fieldBytes(field, 32, "payment hash"));
        break;
      case TAG.s:
        once(type, "payment secret");
        if (len !== 52) throw new Bolt11Error("payment secret is not 52 words");
        paymentSecret = hex(fieldBytes(field, 32, "payment secret"));
        break;
      case TAG.h:
        once(type, "description hash");
        if (len !== 52) throw new Bolt11Error("description hash is not 52 words");
        descriptionHash = hex(fieldBytes(field, 32, "description hash"));
        break;
      case TAG.d:
        once(type, "description");
        try {
          description = new TextDecoder("utf-8", { fatal: true }).decode(bech32.fromWords(field));
        } catch {
          throw new Bolt11Error("description is not UTF-8");
        }
        break;
      case TAG.n:
        once(type, "payee");
        if (len !== 53) throw new Bolt11Error("payee is not 53 words");
        payeeField = fieldBytes(field, 33, "payee");
        break;
      case TAG.x:
        once(type, "expiry");
        expiry = wordsToInt(field);
        break;
      case TAG.c:
        once(type, "min_final_cltv_expiry");
        minFinalCltvExpiry = wordsToInt(field);
        break;
      default:
        // Routing hints, fallbacks, features, metadata and fields unknown today: signed, not needed here.
        break;
    }
  }
  if (paymentHash === null) throw new Bolt11Error("no payment hash");

  const sig = fieldBytes(sigWords, 65, "signature");
  const recovery = sig[64]!;
  if (recovery > 3) throw new Bolt11Error("bad signature recovery id");
  const digest = sha256(new TextEncoder().encode(prefix), wordsToBytesPadded(data));
  let payee: string;
  try {
    const signature = secp256k1.Signature.fromCompact(sig.slice(0, 64));
    if (payeeField) {
      if (!secp256k1.verify(signature, digest, payeeField, { lowS: false })) throw new Error("does not verify against the payee field");
      payee = hex(payeeField);
    } else {
      payee = signature.addRecoveryBit(recovery).recoverPublicKey(digest).toHex(true);
    }
  } catch (err) {
    throw new Bolt11Error(`bad signature: ${(err as Error).message}`);
  }

  return {
    invoice: lower,
    currency,
    amountMsat,
    timestamp,
    expiry: expiry ?? 3600,
    paymentHash,
    paymentSecret,
    descriptionHash,
    description,
    payee,
    payeeStated: payeeField !== null,
    minFinalCltvExpiry,
  };
}

export interface EncodeBolt11 {
  currency: Bolt11Currency;
  amountMsat: bigint;
  timestamp: number;
  paymentHash: Uint8Array;
  paymentSecret: Uint8Array;
  descriptionHash: Uint8Array;
  expiry: number;
  minFinalCltvExpiry?: number;
  privateKey: Uint8Array;
}

/** The shortest BOLT11 amount for a number of millisatoshis. */
function amountPart(msat: bigint): string {
  if (msat <= 0n) throw new Bolt11Error("an invoice amount is positive");
  for (const unit of ["", "m", "u", "n"] as const) {
    const per = MSAT_PER[unit]!.num;
    if (msat % per === 0n) return `${msat / per}${unit}`;
  }
  return `${msat * 10n}p`;
}

function field(type: number, data: number[]): number[] {
  return [type, Math.floor(data.length / 32), data.length % 32, ...data];
}

/** Signs an invoice with a private key of our own: for tests, and a local receiver in development. */
export function encodeBolt11(o: EncodeBolt11): string {
  const hrp = `ln${o.currency}${amountPart(o.amountMsat)}`;
  const data = [
    ...intToWords(o.timestamp, 7),
    ...field(TAG.p, bech32.toWords(o.paymentHash)),
    ...field(TAG.s, bech32.toWords(o.paymentSecret)),
    ...field(TAG.h, bech32.toWords(o.descriptionHash)),
    ...field(TAG.x, intToWords(o.expiry)),
    ...field(TAG.c, intToWords(o.minFinalCltvExpiry ?? 18)),
  ];
  const digest = sha256(new TextEncoder().encode(hrp), wordsToBytesPadded(data));
  const sig = secp256k1.sign(digest, o.privateKey);
  const sig65 = new Uint8Array(65);
  sig65.set(sig.toCompactRawBytes(), 0);
  sig65[64] = sig.recovery;
  return bech32.encode(hrp, [...data, ...bech32.toWords(sig65)], false);
}

export { fromHex, hex, sha256 };
