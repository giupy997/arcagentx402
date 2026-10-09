import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findSignedReceipt, inspectReceipt } from "../../router/src/receipt.js";

// The sample that cra-agent.tech/verify loads. If it stops verifying, the page shows a broken receipt to everyone.
const sample = JSON.parse(readFileSync(fileURLToPath(new URL("../public/receipt-sample.json", import.meta.url)), "utf8"));

describe("the sample receipt on /verify", () => {
  it("is signed twice and both signatures hold", async () => {
    const signed = findSignedReceipt(sample)!;
    expect(signed.postQuantum?.scheme).toBe("slh-dsa-sha2-128s");
    expect(await inspectReceipt(signed)).toMatchObject({ wallet: { ok: true }, limits: { ok: true }, postQuantum: { ok: true }, arc: null, valid: true });
  });

  it("cannot be taken for a payment: it says it is a sample and names no settlement", () => {
    expect(sample.message).toMatchObject({ status: "sample", settlementId: "", network: "eip155:5042" });
  });
});
