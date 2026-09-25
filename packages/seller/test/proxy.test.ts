import { describe, expect, it } from "vitest";
import { createProxyApp, normalisePrice, parseRouteFlag, upstreamUrl } from "../src/proxy.js";
import { parseSellArgs } from "../src/sell-args.js";

const PAY_TO = "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74";

describe("the command line of cra-agent-sell", () => {
  it("turns one price into a price for everything, with specific paths ahead of it", () => {
    const a = parseSellArgs(["proxy", "--target", "https://api.example.com", "--pay-to", PAY_TO, "--price", "0.002", "--route", "GET /v1/render/*=0.05", "--free", "/health"]);
    expect(a.routes).toEqual([{ pattern: "GET /v1/render/*", price: "$0.05" }, { pattern: "/*", price: "$0.002" }]);
    expect(a).toMatchObject({ network: "arc", port: 8402, free: ["/health"] });
  });
  it("refuses to start without a target, a wallet or a price, and says which", () => {
    expect(() => parseSellArgs(["--pay-to", PAY_TO, "--price", "1"])).toThrow(/--target/);
    expect(() => parseSellArgs(["--target", "https://a.com", "--price", "1"])).toThrow(/--pay-to/);
    expect(() => parseSellArgs(["--target", "https://a.com", "--pay-to", PAY_TO])).toThrow(/price/);
    expect(() => parseSellArgs(["--target", "https://a.com", "--pay-to", PAY_TO, "--price", "free"])).toThrow(/not an amount/);
    expect(() => parseSellArgs(["--target", "https://a.com", "--pay-to", PAY_TO, "--price", "1", "--oops", "x"])).toThrow(/unknown option/);
  });
  it("reads an upstream header whose value has colons and equals signs in it", () => {
    const a = parseSellArgs(["--target", "https://a.com", "--pay-to", PAY_TO, "--price", "1", "--upstream-header", "Authorization: Bearer a=b:c"]);
    expect(a.upstreamHeaders).toEqual({ Authorization: "Bearer a=b:c" });
  });
  it("takes the Lightning connection as a file, never as the connection itself", () => {
    const base = ["--target", "https://a.com", "--pay-to", PAY_TO, "--price", "0.002"];
    expect(parseSellArgs([...base, "--pay-to-lightning", "/home/me/.secrets/nwc-receive"]).payToLightning).toBe("/home/me/.secrets/nwc-receive");
    expect(parseSellArgs(base).payToLightning).toBeUndefined();
    expect(() => parseSellArgs([...base, "--pay-to-lightning", "nostr+walletconnect://abc?relay=x&secret=y"])).toThrow(/file path, not the connection/);
  });
  it("parses prices and route flags", () => {
    expect(normalisePrice("0.002")).toBe("$0.002");
    expect(() => normalisePrice("0")).toThrow();
    expect(parseRouteFlag("/v1/x=0.01")).toEqual({ pattern: "/v1/x", price: "$0.01" });
    expect(() => parseRouteFlag("v1/x=0.01")).toThrow(/pattern/);
  });
});

describe("the paywall in front of an API", () => {
  const seen: Array<{ url: string; headers: Headers; method: string; body: string }> = [];
  const upstream = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers), method: init?.method ?? "GET", body: init?.body ? Buffer.from(init.body as ArrayBuffer).toString() : "" });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "x-upstream": "yes", "content-encoding": "gzip" } });
  }) as typeof fetch;
  const app = createProxyApp({ target: "https://api.example.com/base/", payTo: PAY_TO, network: "arc", routes: [{ pattern: "/*", price: "0.002" }], free: ["/health"], name: "Example", upstreamHeaders: { "x-api-key": "secret" }, fetch: upstream });

  it("keeps the target's own path in front of the request path", () => {
    expect(upstreamUrl("https://api.example.com/base/", "/v1/x?a=1")).toBe("https://api.example.com/base/v1/x?a=1");
    expect(upstreamUrl("https://api.example.com", "/v1/x")).toBe("https://api.example.com/v1/x");
  });

  it("serves a free path without asking for money, adds the upstream key and drops the payment headers", async () => {
    const res = await app.request("/health?deep=1", { headers: { "payment-signature": "abc", "x-custom": "kept" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const call = seen.at(-1)!;
    expect(call.url).toBe("https://api.example.com/base/health?deep=1");
    expect(call.headers.get("x-api-key")).toBe("secret");
    expect(call.headers.get("x-custom")).toBe("kept");
    expect(call.headers.get("payment-signature")).toBeNull();
    // The upstream's transport headers are not the buyer's business, and its key never comes back.
    expect(res.headers.get("x-upstream")).toBe("yes");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("x-api-key")).toBeNull();
  });

  it("says what is for sale to anyone who asks, without the upstream's address or key", async () => {
    const doc = (await (await app.request("/.well-known/x402")).json()) as Record<string, unknown>;
    expect(doc).toMatchObject({ name: "Example", network: "eip155:5042", payTo: PAY_TO, settlement: "circle-gateway", routes: [{ pattern: "/*", priceUsd: "0.002", description: null }] });
    expect(JSON.stringify(doc)).not.toMatch(/api\.example\.com|secret/);
  });
});
