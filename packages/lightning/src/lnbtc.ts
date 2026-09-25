/**
 * The x402 `exact` scheme on Bitcoin Lightning, as specified in x402's scheme_exact_lnbtc.md (merged
 * 2026-09-23): the seller's 402 carries a fresh BOLT11 invoice whose signed description hash commits to the
 * request; the buyer pays it and sends the preimage; settlement checks the proof locally, with no access to
 * the seller's node, and records `network:payment_hash` once in a durable store. Error reasons are the
 * spec's own strings.
 */
import { createHash, randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { BindingError, checkParams, httpBinding, jcs, mcpBinding, type HttpBindingParams, type HttpRequestForBinding, type McpBindingParams, type McpCallForBinding } from "./binding.js";
import { Bolt11Error, decodeBolt11, encodeBolt11, fromHex, type Bolt11, type Bolt11Currency } from "./bolt11.js";

export const LNBTC_MAINNET = "lnbtc:000000000019d6689c085ae165831e93";
export const LNBTC_TESTNET = "lnbtc:000000000933ea01ad0ee984209779ba";
const CURRENCY: Record<string, Bolt11Currency> = { [LNBTC_MAINNET]: "bc", [LNBTC_TESTNET]: "tb" };
/** The spec's default clock-skew allowance. */
export const DEFAULT_SKEW_SECONDS = 60;

export interface LnbtcExtra {
  assetTransferMethod?: string;
  paymentFlow: string;
  requestHash: string;
  requestBindingProfile: string;
  requestBindingParams: HttpBindingParams | McpBindingParams;
  invoice: string;
  [key: string]: unknown;
}
export interface LnbtcRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: LnbtcExtra;
}
export interface LnbtcPaymentPayload {
  x402Version: 2;
  accepted: LnbtcRequirements;
  payload: { preimage: string };
  [key: string]: unknown;
}

export type LnbtcSettleError =
  | "unsupported_scheme"
  | "network_mismatch"
  | "unsupported_network"
  | "invalid_exact_lnbtc_asset"
  | "invalid_exact_lnbtc_amount"
  | "invalid_exact_lnbtc_amount_mismatch"
  | "invalid_exact_lnbtc_pay_to_mismatch"
  | "invalid_exact_lnbtc_pay_to_malformed"
  | "invalid_exact_lnbtc_max_timeout_mismatch"
  | "invalid_exact_lnbtc_extra_mismatch"
  | "invalid_exact_lnbtc_request_binding"
  | "invalid_exact_lnbtc_request_mismatch"
  | "invalid_exact_lnbtc_asset_transfer_method"
  | "invalid_exact_lnbtc_payment_flow"
  | "invalid_exact_lnbtc_invoice_missing"
  | "invalid_exact_lnbtc_invoice_decode_failed"
  | "invalid_exact_lnbtc_invoice_description"
  | "invalid_exact_lnbtc_invoice_request_mismatch"
  | "invalid_exact_lnbtc_invoice_payee_mismatch"
  | "invalid_exact_lnbtc_invoice_currency_mismatch"
  | "invalid_exact_lnbtc_invoice_amount_mismatch"
  | "invalid_exact_lnbtc_max_timeout"
  | "invalid_exact_lnbtc_invoice_expiry_mismatch"
  | "invalid_exact_lnbtc_invoice_created_in_future"
  | "duplicate_settlement"
  | "invalid_exact_lnbtc_preimage_missing"
  | "invalid_exact_lnbtc_preimage_malformed"
  | "invalid_exact_lnbtc_preimage_length"
  | "invalid_exact_lnbtc_preimage_hash_mismatch"
  | "invalid_exact_lnbtc_invoice_expired";

export type LnbtcSettlement =
  | { success: true; transaction: string; network: string }
  | { success: false; errorReason: LnbtcSettleError; network?: string };

/**
 * Where settled proofs are remembered. `claim` inserts the key atomically and answers false when it was
 * already there; the entry must outlive the invoice's validity by an hour. It must survive restarts: an
 * in-memory store is not compliant (MemoryReplayStore is for tests).
 */
export interface ReplayStore {
  claim(key: string, keepUntilUnix: number): Promise<boolean>;
}

export class MemoryReplayStore implements ReplayStore {
  private readonly keys = new Map<string, number>();
  async claim(key: string, keepUntilUnix: number): Promise<boolean> {
    if (this.keys.has(key)) return false;
    this.keys.set(key, keepUntilUnix);
    return true;
  }
}

const HASH = /^[0-9a-f]{64}$/;
const isPosIntString = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]*$/.test(v);
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const nowUnix = () => Math.floor(Date.now() / 1000);
const sha256hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A compressed secp256k1 public key, 66 lowercase hex characters, on the curve. */
export function isPayTo(v: unknown): v is string {
  if (typeof v !== "string" || !/^0[23][0-9a-f]{64}$/.test(v)) return false;
  try {
    secp256k1.ProjectivePoint.fromHex(v);
    return true;
  } catch {
    return false;
  }
}

const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
/** Fields of `extra` that have rules of their own; any other the server declared must come back unchanged. */
const RULED = new Set(["invoice", "requestHash", "requestBindingProfile", "requestBindingParams", "assetTransferMethod", "paymentFlow"]);

/**
 * The facilitator's /settle for `exact` on `lnbtc`: the checks in the spec's order, then the atomic replay
 * claim. `requirements` are the server's, recomputed from the request that will run; `payment` is the
 * client's payload; both are untrusted input.
 */
export async function settleLnbtc(payment: unknown, requirements: unknown, o: { replay: ReplayStore; now?: number; skewSeconds?: number }): Promise<LnbtcSettlement> {
  const now = o.now ?? nowUnix();
  const skew = o.skewSeconds ?? DEFAULT_SKEW_SECONDS;
  const req = asObject(requirements);
  const pay = asObject(payment);
  const acc = asObject(pay?.accepted);
  const fail = (errorReason: LnbtcSettleError): LnbtcSettlement => ({ success: false, errorReason, ...(typeof req?.network === "string" ? { network: req.network } : {}) });
  if (!req || !acc) return fail("unsupported_scheme");

  // 1. The core fields the client accepted are the server's.
  if (acc.scheme !== req.scheme) return fail("unsupported_scheme");
  if (acc.network !== req.network) return fail("network_mismatch");
  if (acc.amount !== req.amount) return fail("invalid_exact_lnbtc_amount_mismatch");
  if (acc.asset !== req.asset) return fail("invalid_exact_lnbtc_asset");
  if (acc.payTo !== req.payTo) return fail("invalid_exact_lnbtc_pay_to_mismatch");
  if (acc.maxTimeoutSeconds !== req.maxTimeoutSeconds) return fail("invalid_exact_lnbtc_max_timeout_mismatch");
  // 2. And they are what this scheme takes.
  if (req.scheme !== "exact") return fail("unsupported_scheme");
  const network = req.network as string;
  const currency = typeof network === "string" ? CURRENCY[network] : undefined;
  if (!currency) return fail("unsupported_network");
  if (req.asset !== "BTC") return fail("invalid_exact_lnbtc_asset");
  if (!isPosIntString(req.amount)) return fail("invalid_exact_lnbtc_amount");
  if (!isPosInt(req.maxTimeoutSeconds)) return fail("invalid_exact_lnbtc_max_timeout");
  if (!isPayTo(req.payTo)) return fail("invalid_exact_lnbtc_pay_to_malformed");

  // 3. The scheme's extra fields, and the request binding on both sides.
  const rx = asObject(req.extra);
  const ax = asObject(acc.extra);
  if (!rx || !ax) return fail("invalid_exact_lnbtc_request_binding");
  if ((rx.assetTransferMethod ?? "bolt11") !== "bolt11" || (ax.assetTransferMethod ?? "bolt11") !== "bolt11") return fail("invalid_exact_lnbtc_asset_transfer_method");
  if (rx.paymentFlow !== "upfront" || ax.paymentFlow !== "upfront") return fail("invalid_exact_lnbtc_payment_flow");
  for (const x of [rx, ax]) {
    if (typeof x.requestHash !== "string" || !HASH.test(x.requestHash)) return fail("invalid_exact_lnbtc_request_binding");
    try {
      checkParams(x.requestBindingProfile, x.requestBindingParams);
    } catch {
      return fail("invalid_exact_lnbtc_request_binding");
    }
  }
  if (ax.requestHash !== rx.requestHash || ax.requestBindingProfile !== rx.requestBindingProfile || jcs(ax.requestBindingParams) !== jcs(rx.requestBindingParams)) return fail("invalid_exact_lnbtc_request_mismatch");
  for (const [k, v] of Object.entries(rx)) {
    if (RULED.has(k)) continue;
    if (!(k in ax) || jcs(ax[k]) !== jcs(v)) return fail("invalid_exact_lnbtc_extra_mismatch");
  }

  // 4. Both invoices are there; the one the client paid is the one that counts.
  if (typeof rx.invoice !== "string" || rx.invoice.length === 0 || typeof ax.invoice !== "string" || ax.invoice.length === 0) return fail("invalid_exact_lnbtc_invoice_missing");

  // 5. The paid invoice, strictly: binding, signer, currency, amount, expiry, time.
  let inv: Bolt11;
  try {
    inv = decodeBolt11(ax.invoice);
  } catch {
    return fail("invalid_exact_lnbtc_invoice_decode_failed");
  }
  if (inv.amountMsat === null) return fail("invalid_exact_lnbtc_invoice_decode_failed");
  if (inv.descriptionHash === null || inv.description !== null) return fail("invalid_exact_lnbtc_invoice_description");
  if (inv.descriptionHash !== rx.requestHash) return fail("invalid_exact_lnbtc_invoice_request_mismatch");
  if (inv.payee !== req.payTo) return fail("invalid_exact_lnbtc_invoice_payee_mismatch");
  if (inv.currency !== currency) return fail("invalid_exact_lnbtc_invoice_currency_mismatch");
  if (inv.amountMsat !== req.amount) return fail("invalid_exact_lnbtc_invoice_amount_mismatch");
  if (inv.expiry !== req.maxTimeoutSeconds) return fail("invalid_exact_lnbtc_invoice_expiry_mismatch");
  if (inv.timestamp > now + skew) return fail("invalid_exact_lnbtc_invoice_created_in_future");

  // 6. The preimage proves the payment.
  const preimage = asObject(pay?.payload)?.preimage;
  if (preimage === undefined || preimage === null) return fail("invalid_exact_lnbtc_preimage_missing");
  if (typeof preimage !== "string" || !/^[0-9a-f]*$/.test(preimage)) return fail("invalid_exact_lnbtc_preimage_malformed");
  if (preimage.length !== 64) return fail("invalid_exact_lnbtc_preimage_length");
  if (sha256hex(fromHex(preimage)) !== inv.paymentHash) return fail("invalid_exact_lnbtc_preimage_hash_mismatch");

  // 7. Paid shortly before it expired still counts, up to the skew; after that, no.
  const invoiceEnd = inv.timestamp + inv.expiry;
  if (now > invoiceEnd + skew) return fail("invalid_exact_lnbtc_invoice_expired");

  // Once, atomically, in a store that outlives the invoice by an hour.
  const claimed = await o.replay.claim(`${network}:${inv.paymentHash}`, invoiceEnd + skew + 3600);
  if (!claimed) return fail("duplicate_settlement");
  return { success: true, transaction: inv.paymentHash, network };
}

/** What a buyer is about to do, so it can check that the invoice pays for exactly that. */
export type LnbtcIntent =
  | { profile: "http:1"; request: HttpRequestForBinding; resourceUrl?: string }
  | { profile: "mcp:1"; call: McpCallForBinding; server: string };

export type LnbtcClientCheck = { ok: true; requirements: LnbtcRequirements; invoice: Bolt11 } | { ok: false; reason: string };

/** The spec's client checks, before anything is paid. */
export function checkLnbtcChallenge(requirements: unknown, intent: LnbtcIntent, o: { now?: number; skewSeconds?: number } = {}): LnbtcClientCheck {
  const now = o.now ?? nowUnix();
  const skew = o.skewSeconds ?? DEFAULT_SKEW_SECONDS;
  const no = (reason: string): LnbtcClientCheck => ({ ok: false, reason });
  const r = asObject(requirements);
  if (!r) return no("unsupported_scheme");
  if (r.scheme !== "exact") return no("unsupported_scheme");
  const currency = typeof r.network === "string" ? CURRENCY[r.network] : undefined;
  if (!currency) return no("unsupported_network");
  if (r.asset !== "BTC") return no("invalid_exact_lnbtc_asset");
  if (!isPosIntString(r.amount)) return no("invalid_exact_lnbtc_amount");
  if (!isPosInt(r.maxTimeoutSeconds)) return no("invalid_exact_lnbtc_max_timeout");
  if (!isPayTo(r.payTo)) return no("invalid_exact_lnbtc_pay_to_malformed");
  const x = asObject(r.extra);
  if (!x) return no("invalid_exact_lnbtc_request_binding");
  if (x.paymentFlow !== "upfront") return no("invalid_exact_lnbtc_payment_flow");
  if ((x.assetTransferMethod ?? "bolt11") !== "bolt11") return no("invalid_exact_lnbtc_asset_transfer_method");
  if (typeof x.invoice !== "string" || x.invoice.length === 0) return no("invalid_exact_lnbtc_invoice_missing");
  let inv: Bolt11;
  try {
    inv = decodeBolt11(x.invoice);
  } catch {
    return no("invalid_exact_lnbtc_invoice_decode_failed");
  }
  if (typeof x.requestHash !== "string" || !HASH.test(x.requestHash)) return no("invalid_exact_lnbtc_request_binding");
  if (x.requestBindingProfile !== intent.profile) return no("invalid_exact_lnbtc_request_binding");
  let computed: string;
  try {
    checkParams(x.requestBindingProfile, x.requestBindingParams);
    if (intent.profile === "http:1") {
      if (intent.resourceUrl !== undefined && intent.resourceUrl !== intent.request.url) return no("invalid_exact_lnbtc_request_mismatch");
      computed = httpBinding(intent.request, x.requestBindingParams as HttpBindingParams).requestHash;
    } else {
      // The server's identity comes from the client's own configuration, never from the challenge.
      if ((x.requestBindingParams as McpBindingParams).server !== intent.server) return no("invalid_exact_lnbtc_request_mismatch");
      computed = mcpBinding(intent.call, x.requestBindingParams as McpBindingParams).requestHash;
    }
  } catch (err) {
    return no(err instanceof BindingError ? "invalid_exact_lnbtc_request_binding" : "invalid_exact_lnbtc_request_binding");
  }
  if (inv.descriptionHash === null || inv.description !== null) return no("invalid_exact_lnbtc_invoice_description");
  if (x.requestHash !== computed) return no("invalid_exact_lnbtc_request_mismatch");
  if (inv.descriptionHash !== computed) return no("invalid_exact_lnbtc_invoice_request_mismatch");
  if (inv.payee !== r.payTo) return no("invalid_exact_lnbtc_invoice_payee_mismatch");
  if (inv.currency !== currency) return no("invalid_exact_lnbtc_invoice_currency_mismatch");
  if (inv.amountMsat !== r.amount) return no("invalid_exact_lnbtc_invoice_amount_mismatch");
  if (inv.expiry !== r.maxTimeoutSeconds) return no("invalid_exact_lnbtc_invoice_expiry_mismatch");
  if (inv.timestamp > now + skew) return no("invalid_exact_lnbtc_invoice_created_in_future");
  if (now >= inv.timestamp + inv.expiry) return no("invalid_exact_lnbtc_invoice_expired");
  return { ok: true, requirements: r as unknown as LnbtcRequirements, invoice: inv };
}

/** A Lightning wallet that pays an invoice and says how it went. It must return the preimage when paid. */
export interface PayerAdapter {
  payInvoice(invoice: string, amountMsat: string): Promise<
    | { status: "paid"; preimage?: string; paymentHash?: string; invoice?: string; amountMsat?: string; feesMsat?: string }
    | { status: "in_flight" }
    | { status: "failed"; reason: string }
  >;
}

/** Pays a checked challenge and builds the payment payload; any mismatch in what the wallet reports stops it. */
export async function payLnbtcChallenge(checked: { requirements: LnbtcRequirements; invoice: Bolt11 }, payer: PayerAdapter): Promise<{ ok: true; payload: LnbtcPaymentPayload; feesMsat: string | null } | { ok: false; reason: string }> {
  const { requirements, invoice } = checked;
  const r = await payer.payInvoice(invoice.invoice, requirements.amount);
  if (r.status === "in_flight") return { ok: false, reason: "exact_lnbtc_payment_in_flight" };
  if (r.status !== "paid") return { ok: false, reason: "exact_lnbtc_payment_not_paid" };
  if (r.invoice !== undefined && r.invoice.toLowerCase() !== invoice.invoice) return { ok: false, reason: "invalid_exact_lnbtc_payer_invoice_mismatch" };
  if (r.paymentHash !== undefined && r.paymentHash.toLowerCase() !== invoice.paymentHash) return { ok: false, reason: "invalid_exact_lnbtc_payer_payment_hash_mismatch" };
  if (r.amountMsat !== undefined && r.amountMsat !== requirements.amount) return { ok: false, reason: "invalid_exact_lnbtc_payer_amount_mismatch" };
  if (r.preimage === undefined) return { ok: false, reason: "invalid_exact_lnbtc_payer_preimage_required" };
  const preimage = r.preimage.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(preimage)) return { ok: false, reason: "invalid_exact_lnbtc_payer_preimage_malformed" };
  if (sha256hex(fromHex(preimage)) !== invoice.paymentHash) return { ok: false, reason: "invalid_exact_lnbtc_payer_preimage_hash_mismatch" };
  return { ok: true, payload: { x402Version: 2, accepted: requirements, payload: { preimage } }, feesMsat: r.feesMsat ?? null };
}

/** The seller's node: it signs invoices with the key in payTo, and only the seller may ask it to. */
export interface ReceiverAdapter {
  /** The node's public key, 66 lowercase hex characters: payTo. */
  readonly pubkey: string;
  createInvoice(o: { amountMsat: string; descriptionHash: string; expirySeconds: number }): Promise<string>;
}

/**
 * A fresh challenge for one request: a new invoice from the receiver, strictly checked the way the spec asks
 * a server to before it answers 402. Throws when the receiver hands back an invoice that does not fit.
 */
export async function issueLnbtcChallenge(o: {
  receiver: ReceiverAdapter;
  network: string;
  amountMsat: string;
  maxTimeoutSeconds: number;
  profile: "http:1" | "mcp:1";
  params: HttpBindingParams | McpBindingParams;
  requestHash: string;
  now?: number;
  skewSeconds?: number;
}): Promise<LnbtcRequirements> {
  const currency = CURRENCY[o.network];
  if (!currency) throw new Error(`unsupported network ${o.network}`);
  if (!isPosIntString(o.amountMsat)) throw new Error("amount must be a positive whole number of millisatoshis");
  if (!isPosInt(o.maxTimeoutSeconds)) throw new Error("maxTimeoutSeconds must be a positive integer");
  if (!isPayTo(o.receiver.pubkey)) throw new Error("the receiver's key is not a compressed secp256k1 public key");
  checkParams(o.profile, o.params);
  const invoice = await o.receiver.createInvoice({ amountMsat: o.amountMsat, descriptionHash: o.requestHash, expirySeconds: o.maxTimeoutSeconds });
  const now = o.now ?? nowUnix();
  const skew = o.skewSeconds ?? DEFAULT_SKEW_SECONDS;
  let inv: Bolt11;
  try {
    inv = decodeBolt11(invoice);
  } catch (err) {
    throw new Error(`the receiver returned an invoice that does not decode: ${(err as Bolt11Error).message}`);
  }
  const problems = [
    inv.amountMsat !== o.amountMsat && "amount",
    inv.currency !== currency && "currency",
    (inv.descriptionHash !== o.requestHash || inv.description !== null) && "description hash",
    inv.payee !== o.receiver.pubkey && "signing key",
    inv.expiry !== o.maxTimeoutSeconds && "expiry",
    inv.timestamp > now + skew && "creation time",
    now >= inv.timestamp + inv.expiry && "already expired",
  ].filter(Boolean);
  if (problems.length) throw new Error(`the receiver's invoice does not fit the challenge: ${problems.join(", ")}`);
  return {
    scheme: "exact",
    network: o.network,
    amount: o.amountMsat,
    asset: "BTC",
    payTo: o.receiver.pubkey,
    maxTimeoutSeconds: o.maxTimeoutSeconds,
    extra: { assetTransferMethod: "bolt11", paymentFlow: "upfront", requestHash: o.requestHash, requestBindingProfile: o.profile, requestBindingParams: o.params, invoice: inv.invoice },
  };
}

/**
 * A receiver that signs its own invoices, and a payer that settles them from the same memory: for tests and
 * local development only. Nothing crosses a Lightning network.
 */
export function localLightning(o: { privateKey: Uint8Array; currency?: Bolt11Currency; now?: () => number }) {
  const preimages = new Map<string, string>();
  const pubkey = secp256k1.getPublicKey(o.privateKey, true);
  const receiver: ReceiverAdapter = {
    pubkey: Buffer.from(pubkey).toString("hex"),
    async createInvoice({ amountMsat, descriptionHash, expirySeconds }) {
      const preimage = new Uint8Array(randomBytes(32));
      const paymentHash = createHash("sha256").update(preimage).digest();
      preimages.set(paymentHash.toString("hex"), Buffer.from(preimage).toString("hex"));
      return encodeBolt11({ currency: o.currency ?? "bc", amountMsat: BigInt(amountMsat), timestamp: (o.now ?? nowUnix)(), paymentHash: new Uint8Array(paymentHash), paymentSecret: new Uint8Array(randomBytes(32)), descriptionHash: fromHex(descriptionHash), expiry: expirySeconds, privateKey: o.privateKey });
    },
  };
  const payer: PayerAdapter = {
    async payInvoice(invoice, amountMsat) {
      const inv = decodeBolt11(invoice);
      const preimage = preimages.get(inv.paymentHash);
      if (!preimage) return { status: "failed", reason: "unknown invoice" };
      return { status: "paid", preimage, paymentHash: inv.paymentHash, invoice: inv.invoice, amountMsat, feesMsat: "0" };
    },
  };
  return { receiver, payer };
}
