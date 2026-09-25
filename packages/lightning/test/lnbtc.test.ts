import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { httpBinding, mcpBinding, type HttpRequestForBinding } from "../src/binding.js";
import { encodeBolt11, fromHex } from "../src/bolt11.js";
import { checkLnbtcChallenge, issueLnbtcChallenge, LNBTC_MAINNET, localLightning, MemoryReplayStore, payLnbtcChallenge, settleLnbtc, type LnbtcRequirements } from "../src/lnbtc.js";
import { lnbtcAmount, usdToMsat } from "../src/amounts.js";

// The spec's example, verbatim: requirements, the paid proof, and the settlement it must produce.
const G = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const KEY = fromHex("0000000000000000000000000000000000000000000000000000000000000001");
const T = 1700000000;
const SPEC_REQ: LnbtcRequirements = {
  scheme: "exact",
  network: LNBTC_MAINNET,
  amount: "25000",
  asset: "BTC",
  payTo: G,
  maxTimeoutSeconds: 300,
  extra: {
    assetTransferMethod: "bolt11",
    paymentFlow: "upfront",
    requestHash: "0d6623f775e025501fa7f0a30b54da25aad62b6ccfe35c85da38016711e6c018",
    requestBindingProfile: "http:1",
    requestBindingParams: { headers: [] },
    invoice:
      "lnbc250n1pj48ugqpp54y3u9s8ylemsv8l3ewyzzu0klhujvuvmkl6llchq23vy8rzjsf0qsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygshp5p4nz8am4uqj4q8a87z3sk4x6yk4dv2mvel34epw68qqkwy0xcqvqxqzfvcqpjr4rx6ls6j5rpwknuea64evlk7yfx56wmqcer5eerekdsn9tlv6v4ex9mlz5dtm9qapl3svwlqcf7837dmjkru9z9w4h2rvm0md52w2sqxrwu5f",
  },
};
const SPEC_PREIMAGE = "0001020304050607080900010203040506070809000102030405060708090102";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const proof = (accepted: LnbtcRequirements, preimage = SPEC_PREIMAGE) => ({ x402Version: 2, accepted, payload: { preimage } });
const settle = (payment: unknown, req: unknown, now = T) => settleLnbtc(payment, req, { replay: new MemoryReplayStore(), now });

const get = (url: string, over: Partial<HttpRequestForBinding> = {}): HttpRequestForBinding => ({ method: "GET", url, body: null, header: () => null, ...over });
const hashOf = (url: string, over: Partial<HttpRequestForBinding> = {}) => httpBinding(get(url, over), { headers: [] }).requestHash;

/** A fresh invoice signed by the test key for a request hash, with a preimage we know. */
function invoiceFor(requestHash: string, o: { amountMsat?: bigint; expiry?: number; timestamp?: number; currency?: "bc" | "tb"; key?: Uint8Array } = {}) {
  const preimage = new Uint8Array(32).map(() => Math.floor(Math.random() * 256));
  const paymentHash = new Uint8Array(createHash("sha256").update(preimage).digest());
  const invoice = encodeBolt11({ currency: o.currency ?? "bc", amountMsat: o.amountMsat ?? 25000n, timestamp: o.timestamp ?? T, paymentHash, paymentSecret: new Uint8Array(32).fill(9), descriptionHash: fromHex(requestHash), expiry: o.expiry ?? 300, privateKey: o.key ?? KEY });
  return { invoice, preimage: Buffer.from(preimage).toString("hex"), paymentHash: Buffer.from(paymentHash).toString("hex") };
}
const reqWith = (requestHash: string, invoice: string, over: Partial<LnbtcRequirements> = {}): LnbtcRequirements => ({ ...clone(SPEC_REQ), ...over, extra: { ...clone(SPEC_REQ.extra), requestHash, invoice } });

describe("settlement: the spec's example", () => {
  it("settles the example proof, with the payment hash as the transaction and no payer", async () => {
    expect(await settle(proof(clone(SPEC_REQ)), clone(SPEC_REQ))).toEqual({ success: true, transaction: "a923c2c0e4fe77061ff1cb882171f6fdf926719bb7f5ffe2e05458438c52825e", network: LNBTC_MAINNET });
  });

  it("settles a proof once: the same proof twice, even at once, gives exactly one success", async () => {
    const replay = new MemoryReplayStore();
    const [a, b] = await Promise.all([settleLnbtc(proof(clone(SPEC_REQ)), clone(SPEC_REQ), { replay, now: T }), settleLnbtc(proof(clone(SPEC_REQ)), clone(SPEC_REQ), { replay, now: T })]);
    expect([a.success, b.success].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.success)).toMatchObject({ errorReason: "duplicate_settlement" });
  });
});

describe("settlement: the spec's HTTP cases", () => {
  const A = hashOf("https://api.example.com/article/A");
  const B = hashOf("https://api.example.com/article/B");

  it("uses the invoice the client paid, not the one in a newer challenge", async () => {
    const fresh = invoiceFor(A);
    expect(await settle(proof(clone(SPEC_REQ)), reqWith(A, fresh.invoice))).toMatchObject({ success: true });
  });

  it("two challenges for the same request: the first invoice's proof settles against the second; both paid, both settle", async () => {
    const one = invoiceFor(A);
    const two = invoiceFor(A);
    const replay = new MemoryReplayStore();
    const r1 = await settleLnbtc(proof(reqWith(A, one.invoice), one.preimage), reqWith(A, two.invoice), { replay, now: T });
    const r2 = await settleLnbtc(proof(reqWith(A, two.invoice), two.preimage), reqWith(A, two.invoice), { replay, now: T });
    expect(r1).toMatchObject({ success: true, transaction: one.paymentHash });
    expect(r2).toMatchObject({ success: true, transaction: two.paymentHash });
  });

  it("article A's proof for a request for article B", async () => {
    expect(await settle(proof(clone(SPEC_REQ)), reqWith(B, invoiceFor(B).invoice))).toMatchObject({ errorReason: "invalid_exact_lnbtc_request_mismatch" });
    const accepted = clone(SPEC_REQ);
    accepted.extra.requestHash = B;
    expect(await settle(proof(accepted), reqWith(B, invoiceFor(B).invoice))).toMatchObject({ errorReason: "invalid_exact_lnbtc_invoice_request_mismatch" });
  });

  it("another method or body, with the new digest echoed: the invoice still commits to the old request", async () => {
    for (const changed of [hashOf("https://api.example.com/article/A", { method: "POST" }), hashOf("https://api.example.com/article/A", { body: new Uint8Array([0x78]) })]) {
      const accepted = clone(SPEC_REQ);
      accepted.extra.requestHash = changed;
      expect(await settle(proof(accepted), reqWith(changed, invoiceFor(changed).invoice))).toMatchObject({ errorReason: "invalid_exact_lnbtc_invoice_request_mismatch" });
    }
  });

  it("missing, unknown or malformed binding on either side; a changed header list", async () => {
    for (const field of ["requestHash", "requestBindingProfile", "requestBindingParams"] as const) {
      const a = clone(SPEC_REQ);
      delete (a.extra as Record<string, unknown>)[field];
      expect(await settle(proof(a), clone(SPEC_REQ))).toMatchObject({ errorReason: "invalid_exact_lnbtc_request_binding" });
      const r = clone(SPEC_REQ);
      delete (r.extra as Record<string, unknown>)[field];
      expect(await settle(proof(clone(SPEC_REQ)), r)).toMatchObject({ errorReason: "invalid_exact_lnbtc_request_binding" });
    }
    const unknown = clone(SPEC_REQ);
    unknown.extra.requestBindingProfile = "http:2";
    expect(await settle(proof(unknown), clone(SPEC_REQ))).toMatchObject({ errorReason: "invalid_exact_lnbtc_request_binding" });
    const extraParam = clone(SPEC_REQ);
    extraParam.extra.requestBindingParams = { headers: [], more: 1 } as unknown as { headers: string[] };
    expect(await settle(proof(extraParam), clone(SPEC_REQ))).toMatchObject({ errorReason: "invalid_exact_lnbtc_request_binding" });
    const headers = clone(SPEC_REQ);
    headers.extra.requestBindingParams = { headers: ["accept"] };
    expect(await settle(proof(headers), clone(SPEC_REQ))).toMatchObject({ errorReason: "invalid_exact_lnbtc_request_mismatch" });
  });

  it("an invoice with an inline description instead of a description hash", async () => {
    // Swap the h field for a d field by encoding by hand: same key, amount and hash.
    const { bech32 } = await import("@scure/base");
    const inv = invoiceFor(A);
    const dec = bech32.decode(inv.invoice as `${string}1${string}`, false);
    const words = dec.words.slice(0, -104);
    const out: number[] = words.slice(0, 7);
    for (let i = 7; i < words.length; ) {
      const type = words[i]!;
      const len = words[i + 1]! * 32 + words[i + 2]!;
      const data = words.slice(i + 3, i + 3 + len);
      if (type === 23) {
        const d = bech32.toWords(new TextEncoder().encode("article A"));
        out.push(13, Math.floor(d.length / 32), d.length % 32, ...d);
      } else out.push(type, words[i + 1]!, words[i + 2]!, ...data);
      i += 3 + len;
    }
    const { secp256k1 } = await import("@noble/curves/secp256k1");
    const bytes: number[] = [];
    let acc = 0, bits = 0;
    for (const w of out) { acc = (acc << 5) | w; bits += 5; while (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); } acc &= (1 << bits) - 1; }
    if (bits) bytes.push((acc << (8 - bits)) & 0xff);
    const digest = createHash("sha256").update(Buffer.from(dec.prefix)).update(Buffer.from(bytes)).digest();
    const sig = secp256k1.sign(digest, KEY);
    const sig65 = new Uint8Array(65);
    sig65.set(sig.toCompactRawBytes());
    sig65[64] = sig.recovery;
    const inline = bech32.encode(dec.prefix, [...out, ...bech32.toWords(sig65)], false);
    expect(await settle(proof(reqWith(A, inline), inv.preimage), reqWith(A, inv.invoice))).toMatchObject({ errorReason: "invalid_exact_lnbtc_invoice_description" });
  });
});

describe("settlement: the spec's MCP cases", () => {
  const params = { server: "https://api.example.com/mcp", metadata: [] as string[] };
  const call = { name: "get_article", arguments: { article: "A" } };
  const A = mcpBinding(call, params).requestHash;
  const mcpReq = (requestHash: string, invoice: string): LnbtcRequirements => ({ ...clone(SPEC_REQ), extra: { assetTransferMethod: "bolt11", paymentFlow: "upfront", requestHash, requestBindingProfile: "mcp:1", requestBindingParams: clone(params), invoice } });

  it("the same call with a new id, progress token and payment metadata settles; other arguments do not", async () => {
    const inv = invoiceFor(A);
    const again = mcpBinding({ ...call, meta: { progressToken: 7, "x402/payment": {} } }, params).requestHash;
    expect(again).toBe(A);
    expect(await settle(proof(mcpReq(A, inv.invoice), inv.preimage), mcpReq(again, invoiceFor(again).invoice))).toMatchObject({ success: true });
    const B = mcpBinding({ ...call, arguments: { article: "B" } }, params).requestHash;
    expect(await settle(proof(mcpReq(A, inv.invoice), inv.preimage), mcpReq(B, invoiceFor(B).invoice))).toMatchObject({ errorReason: "invalid_exact_lnbtc_request_mismatch" });
    expect(await settle(proof(mcpReq(B, inv.invoice), inv.preimage), mcpReq(B, invoiceFor(B).invoice))).toMatchObject({ errorReason: "invalid_exact_lnbtc_invoice_request_mismatch" });
  });

  it("an HTTP invoice cannot pay for an MCP call: the domains differ", async () => {
    expect(await settle(proof(mcpReq(A, SPEC_REQ.extra.invoice)), mcpReq(A, invoiceFor(A).invoice))).toMatchObject({ errorReason: "invalid_exact_lnbtc_invoice_request_mismatch" });
  });
});

describe("settlement: terms, proof and time", () => {
  it("each term the client accepted must be the server's", async () => {
    const cases: Array<[Partial<LnbtcRequirements>, string]> = [
      [{ scheme: "upto" }, "unsupported_scheme"],
      [{ network: "lnbtc:000000000933ea01ad0ee984209779ba" }, "network_mismatch"],
      [{ amount: "26000" }, "invalid_exact_lnbtc_amount_mismatch"],
      [{ asset: "SAT" }, "invalid_exact_lnbtc_asset"],
      [{ payTo: "03" + G.slice(2) }, "invalid_exact_lnbtc_pay_to_mismatch"],
      [{ maxTimeoutSeconds: 301 }, "invalid_exact_lnbtc_max_timeout_mismatch"],
    ];
    for (const [change, reason] of cases) expect(await settle(proof({ ...clone(SPEC_REQ), ...change }), clone(SPEC_REQ))).toMatchObject({ errorReason: reason });
    const both = (change: Partial<LnbtcRequirements>) => settle(proof({ ...clone(SPEC_REQ), ...change }), { ...clone(SPEC_REQ), ...change });
    expect(await both({ network: "lnbtc:ffff" })).toMatchObject({ errorReason: "unsupported_network" });
    expect(await both({ amount: "0" })).toMatchObject({ errorReason: "invalid_exact_lnbtc_amount" });
    expect(await both({ payTo: "04" + G.slice(2) })).toMatchObject({ errorReason: "invalid_exact_lnbtc_pay_to_malformed" });
  });

  it("the preimage: missing, malformed, short, or for another invoice", async () => {
    const p = (preimage: unknown) => settle({ x402Version: 2, accepted: clone(SPEC_REQ), payload: preimage === undefined ? {} : { preimage } }, clone(SPEC_REQ));
    expect(await p(undefined)).toMatchObject({ errorReason: "invalid_exact_lnbtc_preimage_missing" });
    // The spec's preimage is all digits: an upper-case letter or a non-hex character makes it malformed.
    expect(await p(SPEC_PREIMAGE.slice(0, 62) + "0A")).toMatchObject({ errorReason: "invalid_exact_lnbtc_preimage_malformed" });
    expect(await p(SPEC_PREIMAGE.slice(0, 63) + "g")).toMatchObject({ errorReason: "invalid_exact_lnbtc_preimage_malformed" });
    expect(await p(SPEC_PREIMAGE.slice(2))).toMatchObject({ errorReason: "invalid_exact_lnbtc_preimage_length" });
    expect(await p("ff" + SPEC_PREIMAGE.slice(2))).toMatchObject({ errorReason: "invalid_exact_lnbtc_preimage_hash_mismatch" });
  });

  it("paid but expired: valid until the invoice's end plus the skew, and not a second after", async () => {
    const end = T + 300;
    expect(await settle(proof(clone(SPEC_REQ)), clone(SPEC_REQ), end + 60)).toMatchObject({ success: true });
    expect(await settle(proof(clone(SPEC_REQ)), clone(SPEC_REQ), end + 61)).toMatchObject({ errorReason: "invalid_exact_lnbtc_invoice_expired" });
    expect(await settle(proof(clone(SPEC_REQ)), clone(SPEC_REQ), T - 61)).toMatchObject({ errorReason: "invalid_exact_lnbtc_invoice_created_in_future" });
  });

  it("an invoice signed by another key, for another amount or network, or with another expiry", async () => {
    const A = SPEC_REQ.extra.requestHash;
    const other = invoiceFor(A, { key: fromHex("02".padStart(64, "0")) });
    expect(await settle(proof(reqWith(A, other.invoice), other.preimage), clone(SPEC_REQ))).toMatchObject({ errorReason: "invalid_exact_lnbtc_invoice_payee_mismatch" });
    const tb = invoiceFor(A, { currency: "tb" });
    expect(await settle(proof(reqWith(A, tb.invoice), tb.preimage), clone(SPEC_REQ))).toMatchObject({ errorReason: "invalid_exact_lnbtc_invoice_currency_mismatch" });
    const cheaper = invoiceFor(A, { amountMsat: 24000n });
    expect(await settle(proof(reqWith(A, cheaper.invoice), cheaper.preimage), clone(SPEC_REQ))).toMatchObject({ errorReason: "invalid_exact_lnbtc_invoice_amount_mismatch" });
    const longer = invoiceFor(A, { expiry: 600 });
    expect(await settle(proof(reqWith(A, longer.invoice), longer.preimage), clone(SPEC_REQ))).toMatchObject({ errorReason: "invalid_exact_lnbtc_invoice_expiry_mismatch" });
    expect(await settle(proof(reqWith(A, "lnbc1garbage")), clone(SPEC_REQ))).toMatchObject({ errorReason: "invalid_exact_lnbtc_invoice_decode_failed" });
  });
});

describe("a buyer and a seller, end to end, on a local node", () => {
  it("issues a challenge for a request, checks it, pays it, and settles once", async () => {
    let clock = T;
    const { receiver, payer } = localLightning({ privateKey: KEY, now: () => clock });
    const request = get("https://api.cra-agent.tech/v1/paid/fees/estimate?gas=21000");
    const requestHash = httpBinding(request, { headers: [] }).requestHash;
    const challenge = await issueLnbtcChallenge({ receiver, network: LNBTC_MAINNET, amountMsat: "1000", maxTimeoutSeconds: 300, profile: "http:1", params: { headers: [] }, requestHash, now: clock });
    expect(challenge).toMatchObject({ payTo: G, amount: "1000", extra: { requestHash, paymentFlow: "upfront" } });

    // The buyer checks the challenge against what it is about to send, then pays.
    expect(checkLnbtcChallenge(challenge, { profile: "http:1", request: get("https://api.cra-agent.tech/v1/paid/fees/estimate?gas=50000") }, { now: clock })).toMatchObject({ ok: false, reason: "invalid_exact_lnbtc_request_mismatch" });
    const checked = checkLnbtcChallenge(challenge, { profile: "http:1", request }, { now: clock });
    if (!checked.ok) throw new Error(checked.reason);
    const paid = await payLnbtcChallenge(checked, payer);
    if (!paid.ok) throw new Error(paid.reason);

    // The seller recomputes the binding from the request it will run, with a fresh invoice, and settles.
    clock += 5;
    const retry = await issueLnbtcChallenge({ receiver, network: LNBTC_MAINNET, amountMsat: "1000", maxTimeoutSeconds: 300, profile: "http:1", params: { headers: [] }, requestHash, now: clock });
    const replay = new MemoryReplayStore();
    expect(await settleLnbtc(paid.payload, retry, { replay, now: clock })).toMatchObject({ success: true, transaction: checked.invoice.paymentHash });
    expect(await settleLnbtc(paid.payload, retry, { replay, now: clock })).toMatchObject({ errorReason: "duplicate_settlement" });
  });

  it("a buyer refuses a challenge it should not pay", () => {
    const at = { now: T };
    const intent = { profile: "http:1" as const, request: get("https://api.example.com/article/A") };
    expect(checkLnbtcChallenge(clone(SPEC_REQ), intent, at)).toMatchObject({ ok: true });
    expect(checkLnbtcChallenge({ ...clone(SPEC_REQ), payTo: "03" + G.slice(2) }, intent, at)).toMatchObject({ ok: false, reason: "invalid_exact_lnbtc_invoice_payee_mismatch" });
    expect(checkLnbtcChallenge(clone(SPEC_REQ), intent, { now: T + 300 })).toMatchObject({ ok: false, reason: "invalid_exact_lnbtc_invoice_expired" });
    expect(checkLnbtcChallenge(clone(SPEC_REQ), { profile: "mcp:1", call: { name: "x" }, server: "https://api.example.com/mcp" }, at)).toMatchObject({ ok: false, reason: "invalid_exact_lnbtc_request_binding" });
  });
});

describe("amounts", () => {
  it("reads explicit amounts and sats, and refuses bare numbers and fractions of a millisatoshi", () => {
    expect(lnbtcAmount({ asset: "BTC", amount: "21000" })).toBe("21000");
    expect(lnbtcAmount("21 sat")).toBe("21000");
    expect(lnbtcAmount("21 sats")).toBe("21000");
    expect(lnbtcAmount("0.001 sat")).toBe("1");
    expect(() => lnbtcAmount("21")).toThrow();
    expect(() => lnbtcAmount(21)).toThrow();
    expect(() => lnbtcAmount("$1")).toThrow();
    expect(() => lnbtcAmount("0.0001 sat")).toThrow();
  });

  it("prices dollars in millisatoshis, rounding up, never under a floor", () => {
    // $0.001 at $100,000 a bitcoin is exactly 1 sat.
    expect(usdToMsat("0.001", "100000")).toBe("1000");
    expect(usdToMsat("0.001", "113456.78")).toBe("882");
    expect(usdToMsat("0.0005", "113456.78", 1000n)).toBe("1000");
  });
});
