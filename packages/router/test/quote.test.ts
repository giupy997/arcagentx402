import { describe, expect, it } from "vitest";
import { MemoryLedger } from "@cra-agent/ledger";
import { createSigner } from "@cra-agent/identity";
import { parsePolicyString } from "@cra-agent/policy";
import { createRail, QuoteFailed } from "../src/index.js";

const SELLER = "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74";
const URL_ = "https://seller.example/v1/chat/completions";

/** A seller like BlockRun's chat: it reads the body first, and names a price only for a request it could serve. */
function chatSeller() {
  const seen: Array<{ method: string; body: string; type: string | null }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const body = await req.text();
    seen.push({ method: req.method, body, type: req.headers.get("content-type") });
    if (req.method !== "POST" || !body) return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400, headers: { "content-type": "application/json" } });
    const required = {
      x402Version: 2,
      resource: { url: URL_, description: "chat", mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: "eip155:5042", amount: "3000", asset: "0x3600000000000000000000000000000000000000", payTo: SELLER, maxTimeoutSeconds: 120, extra: { name: "USDC", version: "2" } }],
    };
    return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64"), "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

function rail(fetchImpl: typeof fetch) {
  const signer = createSigner({ scheme: "secp256k1", privateKey: `0x${"42".repeat(32)}` });
  return createRail({ network: "arc", signer, policy: parsePolicyString("daily=1,per_seller=1,per_payment=0.05"), ledger: new MemoryLedger(), identity: null, agentId: "test", fetch: fetchImpl });
}

describe("a quote asks the way the payment will", () => {
  it("names the price of a POST sent with its body, and pays nothing", async () => {
    const s = chatSeller();
    const q = await rail(s.fetchImpl).quote(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: '{"model":"anthropic/claude-haiku-4.5","messages":[]}' });
    expect(q).toMatchObject({ priceUsdc: "0.003", payTo: SELLER, network: "eip155:5042" });
    expect(s.seen).toEqual([{ method: "POST", body: '{"model":"anthropic/claude-haiku-4.5","messages":[]}', type: "application/json" }]);
  });

  it("does not call a refusal free: without its body the POST fails with what the seller said", async () => {
    const err = await rail(chatSeller().fetchImpl).quote(URL_, { method: "POST" }).catch((e) => e);
    expect(err).toBeInstanceOf(QuoteFailed);
    expect(err).toMatchObject({ status: 400 });
    expect((err as QuoteFailed).message).toBe('the seller answered 400 instead of a price: {"error":"Invalid request body"}');
  });

  it("calls a resource free only when the seller serves it, and keeps an error page short", async () => {
    const served = (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch;
    expect(await rail(served).quote(URL_)).toBeNull();
    const page = `<html>\n  <body>${"Not   found ".repeat(40)}</body>\n</html>`;
    const missing = (async () => new Response(page, { status: 404 })) as typeof fetch;
    const err = (await rail(missing).quote(URL_).catch((e) => e)) as QuoteFailed;
    expect(err.status).toBe(404);
    expect(err.detail).toHaveLength(200);
    expect(err.detail).toMatch(/^<html> <body>Not found Not found /);
  });
});
