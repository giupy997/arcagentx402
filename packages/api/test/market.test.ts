import { describe, expect, it } from "vitest";
import { clean, NotListable, probe, readChallenge } from "../src/market.js";

const ARC = "eip155:5042";
const PAY_TO = "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74";
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64");

describe("what a listing is allowed to say about itself", () => {
  it("reads the Arc price and payee from a v2 header, and from a v1 body", () => {
    const v2 = b64({ x402Version: 2, resource: { url: "https://a.com/x", description: "Forecasts" }, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "9", payTo: PAY_TO }, { scheme: "exact", network: ARC, amount: "2000", payTo: PAY_TO, extra: { name: "GatewayWalletBatched" } }] });
    const a = readChallenge(v2, "", ARC);
    expect(a.accept).toMatchObject({ network: ARC, amount: "2000", payTo: PAY_TO });
    expect(a.description).toBe("Forecasts");
    const v1 = JSON.stringify({ accepts: [{ scheme: "exact", network: ARC, maxAmountRequired: "1500", payTo: PAY_TO }] });
    expect(readChallenge(undefined, v1, ARC).accept.amount).toBe("1500");
  });

  it("refuses an endpoint that is not on Arc, or whose requirements make no sense", () => {
    expect(() => readChallenge(b64({ accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1", payTo: PAY_TO }] }), "", ARC)).toThrow(/does not take payment on Arc/);
    expect(() => readChallenge(b64({ accepts: [{ scheme: "exact", network: ARC, amount: "lots", payTo: PAY_TO }] }), "", ARC)).toThrow(NotListable);
    expect(() => readChallenge(b64({ accepts: [{ scheme: "exact", network: ARC, amount: "1", payTo: "0x123" }] }), "", ARC)).toThrow(NotListable);
    expect(() => readChallenge(undefined, "<html>pay me</html>", ARC)).toThrow(/not an x402 endpoint/);
  });

  it("keeps a stranger's text to one bounded printable line", () => {
    expect(clean("  Weather\n\n<b>now</b>\tfor agents  ", 80)).toBe("Weather <b>now</b> for agents");
    expect(clean("x".repeat(500), 80)).toHaveLength(80);
    expect(clean(42, 80)).toBeNull();
    expect(clean("   ", 80)).toBeNull();
  });

  it("will not probe an address that is not public https", async () => {
    await expect(probe("http://example.com/x", ARC)).rejects.toThrow(/https/);
    await expect(probe("https://127.0.0.1/x", ARC)).rejects.toThrow(/public/);
    await expect(probe("https://localhost/x", ARC)).rejects.toThrow(/public/);
    await expect(probe(`https://example.com/${"a".repeat(400)}`, ARC)).rejects.toThrow(/too long/);
  });
});
