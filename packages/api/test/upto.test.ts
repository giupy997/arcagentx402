import { x402Client } from "@x402/core/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { Hono } from "hono";
import type { Logger } from "pino";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mountUptoRoutes, thinkBill } from "../src/upto.js";

const NET = "eip155:5042";
const SELLER = "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74";
const FACILITATOR = "http://127.0.0.1:8792";
const WORKER = "http://127.0.0.1:8793";
const OUR_SIGNER = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const buyer = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000002");
const decode = (h: string | null) => JSON.parse(Buffer.from(h!, "base64").toString("utf8"));
const log = { info: () => {}, warn: () => {} } as unknown as Logger;

// Our facilitator, played here: it lists upto with its address, passes every payment, and settles what it is told.
const settled: string[] = [];
beforeAll(() => {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(FACILITATOR)) return real(input, init);
    if (url.endsWith("/supported")) return Response.json({ kinds: [{ x402Version: 2, scheme: "exact", network: NET }, { x402Version: 2, scheme: "upto", network: NET, extra: { facilitatorAddress: OUR_SIGNER } }], extensions: [], signers: {} });
    const body = JSON.parse(String(init!.body));
    if (url.endsWith("/verify")) return Response.json({ isValid: true, payer: buyer.address });
    settled.push(body.paymentRequirements.amount);
    return Response.json({ success: true, transaction: `0x${"ab".repeat(32)}`, network: NET, payer: buyer.address, amount: body.paymentRequirements.amount });
  });
});
afterAll(() => void vi.unstubAllGlobals());

const run = (over: Record<string, unknown> = {}) => ({
  answer: "EURC traded between 1.1702 and 1.1719 today.",
  stoppedBecause: "answered",
  steps: [
    { kind: "think", detail: "I need today's EURC trades.", costUsdc: "0.0053", ledgerId: "812", tx: "5e0c6a2e-0000-4000-8000-000000000000" },
    { kind: "buy", detail: "fx execution", costUsdc: "0.004", ledgerId: "813", tx: "0x01", url: "https://api.example/v1/fx", seller: "Example" },
  ],
  spent: { thinkingUsdc: "0.0173", toolsUsdc: "0.004", totalUsdc: "0.0213", thoughts: 3, purchases: 1 },
  ...over,
});

/** The API with the upto route, a worker that answers as told, and a buyer paying with x402's own upto client. */
function world(worker: (body: { task: string; budgetUsdc: string }) => Response | Promise<Response>) {
  const asked: Array<{ task: string; budgetUsdc: string }> = [];
  const app = new Hono();
  mountUptoRoutes(app, {
    sellerAddress: SELLER,
    network: "arc",
    facilitatorUrl: FACILITATOR,
    workerUrl: WORKER,
    onSettlement: () => {},
    log,
    fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      asked.push(body);
      return worker(body);
    }) as typeof fetch,
  });
  const signer = { address: buyer.address, signTypedData: (m: Parameters<typeof buyer.signTypedData>[0]) => buyer.signTypedData(m), readContract: async () => 0n };
  const client = new x402Client().register(NET, new UptoEvmScheme(signer as never));
  client.setSpendControls({ maxAmountPerPayment: false, allowedAssets: [{ network: NET, asset: "0x3600000000000000000000000000000000000000" }] });
  const pay = wrapFetchWithPayment(((input: RequestInfo | URL, init?: RequestInit) => (input instanceof Request ? app.request(input) : app.request(String(input), init))) as typeof fetch, client);
  return { app, pay, asked };
}

describe("the thinking agent, hired and billed by what it spent (x402 upto)", () => {
  it("asks for a ceiling of $0.10 and says, before anything is paid, how the bill is made", async () => {
    const res = await world(() => Response.json(run())).app.request("http://api.test/v1/upto/think?task=hello", { headers: { accept: "application/json" } });
    expect(res.status).toBe(402);
    expect(decode(res.headers.get("PAYMENT-REQUIRED")).accepts[0]).toMatchObject({ scheme: "upto", amount: "100000", payTo: SELLER, maxTimeoutSeconds: 300 });
    expect(await res.json()).toMatchObject({ ceilingUsdc: "0.10", feeUsdc: "0.005" });
  });

  it("charges what the run spent plus the fee, and shows every payment the agent made", async () => {
    settled.length = 0;
    const w = world(() => Response.json(run()));
    const res = await w.pay("http://api.test/v1/upto/think?task=What%20moved%20EURC%20today%3F");
    expect(res.status).toBe(200);
    expect(w.asked).toEqual([{ task: "What moved EURC today?", budgetUsdc: "0.095" }]);
    const body = await res.json();
    expect(body).toMatchObject({ answer: expect.stringMatching(/^EURC/), charged: { totalUsdc: "0.0263", spentUsdc: "0.0213", feeUsdc: "0.005", ceilingUsdc: "0.10" } });
    expect(body.steps).toHaveLength(2);
    expect(body.steps[0]).not.toHaveProperty("ledgerId");
    expect(settled).toEqual(["26300"]);
    expect(decode(res.headers.get("PAYMENT-RESPONSE"))).toMatchObject({ success: true, amount: "26300" });
  });

  it("charges nothing when the agent is busy, cannot be reached, or stopped before spending", async () => {
    settled.length = 0;
    const busy = await world(() => Response.json({ error: "busy" }, { status: 429 })).pay("http://api.test/v1/upto/think?task=hello%20there");
    expect(busy.status).toBe(503);
    expect((await busy.json()).charged).toBe(false);
    const down = await world(() => Promise.reject(new Error("ECONNREFUSED"))).pay("http://api.test/v1/upto/think?task=hello%20there");
    expect(down.status).toBe(503);
    const poor = await world(() => Response.json({ error: "the agent's wallet has $0.01" }, { status: 503 })).pay("http://api.test/v1/upto/think?task=hello%20there");
    expect((await poor.json()).error).toMatch(/wallet/);
    const nothing = await world(() => Response.json(run({ answer: null, stoppedBecause: "brain", steps: [], spent: { thinkingUsdc: "0", toolsUsdc: "0", totalUsdc: "0", thoughts: 0, purchases: 0 } }))).pay("http://api.test/v1/upto/think?task=hello%20there");
    expect(nothing.status).toBe(502);
    expect(settled).toEqual([]);
  });

  it("refuses a task it cannot take before asking the agent, and charges nothing for it", async () => {
    settled.length = 0;
    const w = world(() => Response.json(run()));
    expect((await w.pay("http://api.test/v1/upto/think?task=hi")).status).toBe(400);
    expect(w.asked).toHaveLength(0);
    expect(settled).toEqual([]);
  });

  it("charges for a run that spent but found no answer, and never more than the ceiling", () => {
    expect(thinkBill("0.0371")).toEqual({ totalUsdc: "0.0421", spentUsdc: "0.0371", feeUsdc: "0.005", ceilingUsdc: "0.10" });
    expect(thinkBill("0.099").totalUsdc).toBe("0.1");
  });
});
