import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { checkLnbtcChallenge, httpBinding, issueLnbtcChallenge, LNBTC_MAINNET, LNBTC_TESTNET, lnbtcFacilitatorClient, localLightning, MemoryReplayStore, payLnbtcChallenge, type LnbtcRequirements } from "@cra-agent/lightning";
import { lnbtcFacilitator, type LnbtcSettledHere } from "../src/facilitator-lnbtc.js";
import { mountFacilitatorProtocol } from "../src/facilitator.js";

const KEY = new Uint8Array(32).map((_, i) => (i === 31 ? 5 : 0));
const URL_ = "https://seller.example/v1/data?x=1";

/** What a seller's server holds after a buyer paid: its own requirements, and the buyer's payload with the preimage. */
async function paid(o: { maxTimeoutSeconds?: number } = {}) {
  const node = localLightning({ privateKey: KEY });
  const params = { headers: [] as string[] };
  const request = { method: "GET", url: URL_, body: null, header: () => null };
  const requirements = await issueLnbtcChallenge({ receiver: node.receiver, network: LNBTC_MAINNET, amountMsat: "2000", maxTimeoutSeconds: o.maxTimeoutSeconds ?? 300, profile: "http:1", params, requestHash: httpBinding(request, params).requestHash });
  const checked = checkLnbtcChallenge(requirements, { profile: "http:1", request });
  if (!checked.ok) throw new Error(checked.reason);
  const pay = await payLnbtcChallenge(checked, node.payer);
  if (!pay.ok) throw new Error(pay.reason);
  return { node, requirements, payload: pay.payload, paymentHash: checked.invoice.paymentHash, body: { x402Version: 2, paymentPayload: pay.payload, paymentRequirements: requirements } };
}

describe("the open Lightning facilitator", () => {
  it("settles a paid proof once, with the payment hash and no payer, and records what it settled", async () => {
    const seen: LnbtcSettledHere[] = [];
    const f = lnbtcFacilitator({ replay: new MemoryReplayStore(), onSettled: (e) => void seen.push(e) });
    const p = await paid();
    const first = await f.settle(p.body, "198.51.100.1");
    expect(first).toEqual({ status: 200, json: { success: true, transaction: p.paymentHash, network: LNBTC_MAINNET } });
    const again = await f.settle(p.body, "198.51.100.1");
    expect(again).toEqual({ status: 200, json: { success: false, errorReason: "duplicate_settlement", transaction: "", network: LNBTC_MAINNET } });
    expect(seen).toEqual([{ network: LNBTC_MAINNET, paymentHash: p.paymentHash, payTo: p.node.receiver.pubkey, amountMsat: "2000" }]);
    expect(await f.settledToday()).toBe(1);
  });

  it("checks the proof against the seller's requirements, not the buyer's copy of them", async () => {
    const f = lnbtcFacilitator({ replay: new MemoryReplayStore() });
    const p = await paid();
    const other: LnbtcRequirements = { ...p.requirements, extra: { ...p.requirements.extra, requestHash: "00".repeat(32) } };
    const a = await f.settle({ ...p.body, paymentRequirements: other }, "198.51.100.1");
    expect(a.json).toMatchObject({ success: false, errorReason: "invalid_exact_lnbtc_request_mismatch" });
    // Nothing was claimed: the right requirements still settle it.
    expect((await f.settle(p.body, "198.51.100.1")).json).toMatchObject({ success: true });
  });

  it("refuses invoices that last over an hour before claiming anything, so every claim can be pruned", async () => {
    const replay = new MemoryReplayStore();
    const p = await paid({ maxTimeoutSeconds: 7200 });
    const strict = await lnbtcFacilitator({ replay }).settle(p.body, "198.51.100.1");
    expect(strict.json).toMatchObject({ success: false, errorReason: "invalid_exact_lnbtc_max_timeout" });
    expect((await lnbtcFacilitator({ replay, maxTimeoutSeconds: 7200 }).settle(p.body, "198.51.100.1")).json).toMatchObject({ success: true });
  });

  it("paces each address, stops at the daily cap, and says when its store is down, claiming nothing", async () => {
    const p = await paid();
    const paced = lnbtcFacilitator({ replay: new MemoryReplayStore(), perMinute: 1 });
    await paced.settle({ nothing: true }, "198.51.100.1");
    expect((await paced.settle(p.body, "198.51.100.1")).status).toBe(429);
    expect((await paced.settle(p.body, "198.51.100.2")).json).toMatchObject({ success: true });

    const full = lnbtcFacilitator({ replay: new MemoryReplayStore(), dailyCap: 5, settledEarlierToday: async () => 5 });
    expect(await full.settle(p.body, "198.51.100.1")).toMatchObject({ status: 503, json: { errorReason: "daily_cap_reached" } });

    const down = new MemoryReplayStore();
    down.claim = async () => {
      throw new Error("connection refused");
    };
    expect(await lnbtcFacilitator({ replay: down }).settle(p.body, "198.51.100.1")).toMatchObject({ status: 503, json: { success: false, errorReason: "replay_store_unavailable" } });
  });

  it("answers /verify with a pointer to /settle, since this flow has no verify step", () => {
    const f = lnbtcFacilitator({ replay: new MemoryReplayStore() });
    expect(f.verify()).toMatchObject({ status: 400, json: { isValid: false } });
  });
});

describe("the facilitator's routes", () => {
  function world(withArc: boolean) {
    const forwarded: string[] = [];
    const upstream = async (path: string, init?: RequestInit) => {
      forwarded.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/supported") return Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:5042" }], extensions: [], signers: { "eip155:*": ["0xf3b5"] } });
      return Response.json({ success: true, transaction: "0xabc", network: "eip155:5042" });
    };
    const app = new Hono();
    mountFacilitatorProtocol(app, { upstream: withArc ? upstream : null, lnbtc: lnbtcFacilitator({ replay: new MemoryReplayStore() }) });
    return { app, forwarded };
  }

  it("lists Lightning next to Arc, settles Lightning here and passes anything else on", async () => {
    const w = world(true);
    const supported = await (await w.app.request("/facilitator/supported")).json();
    expect(supported.kinds.map((k: { network: string }) => k.network)).toEqual(["eip155:5042", LNBTC_MAINNET, LNBTC_TESTNET]);
    const p = await paid();
    const ln = await w.app.request("/facilitator/settle", { method: "POST", body: JSON.stringify(p.body) });
    expect(await ln.json()).toEqual({ success: true, transaction: p.paymentHash, network: LNBTC_MAINNET });
    const arc = await w.app.request("/facilitator/settle", { method: "POST", body: JSON.stringify({ paymentPayload: { accepted: { network: "eip155:5042" } }, paymentRequirements: { network: "eip155:5042" } }) });
    expect((await arc.json()).transaction).toBe("0xabc");
    expect(w.forwarded).toEqual(["GET /supported", "POST /settle"]);
    expect((await w.app.request("/facilitator/verify", { method: "POST", body: JSON.stringify(p.body) })).status).toBe(400);
  });

  it("still settles Lightning when there is no Arc facilitator on the host", async () => {
    const w = world(false);
    expect((await (await w.app.request("/facilitator/supported")).json()).kinds).toHaveLength(2);
    const arc = await w.app.request("/facilitator/settle", { method: "POST", body: JSON.stringify({ paymentPayload: {}, paymentRequirements: { network: "eip155:5042" } }) });
    expect(arc.status).toBe(404);
  });

  it("is what a seller's client expects: it finds the network, settles once, then hears duplicate", async () => {
    const w = world(true);
    const client = lnbtcFacilitatorClient("https://api.cra-agent.tech/facilitator", { fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => w.app.request(String(input).replace("https://api.cra-agent.tech", ""), init)) as typeof fetch });
    expect(await client.supports(LNBTC_MAINNET)).toBe(true);
    expect(await client.supports("lnbtc:000000000000000000000000000000ff")).toBe(false);
    const p = await paid();
    expect(await client.settle(p.payload, p.requirements)).toEqual({ success: true, transaction: p.paymentHash, network: LNBTC_MAINNET });
    expect(await client.settle(p.payload, p.requirements)).toEqual({ success: false, errorReason: "duplicate_settlement", network: LNBTC_MAINNET });
  });
});
