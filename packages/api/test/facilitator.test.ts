import { describe, expect, it } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { verifyMessage } from "viem";
import { registrationMessage } from "../src/facilitator-message.js";
import { registrationMessage as webMessage } from "../../web/src/registration-message.js";

describe("registering a seller's wallet", () => {
  it("signs and verifies the same text the page shows", async () => {
    const key = generatePrivateKey();
    const acct = privateKeyToAccount(key);
    const issuedAt = new Date().toISOString();
    expect(webMessage(acct.address, issuedAt)).toBe(registrationMessage(acct.address, issuedAt));
    const signature = await acct.signMessage({ message: registrationMessage(acct.address, issuedAt) });
    expect(await verifyMessage({ address: acct.address, message: registrationMessage(acct.address, issuedAt), signature })).toBe(true);
    // Another wallet's signature over the same text does not register this address.
    const other = privateKeyToAccount(generatePrivateKey());
    const forged = await other.signMessage({ message: registrationMessage(acct.address, issuedAt) });
    expect(await verifyMessage({ address: acct.address, message: registrationMessage(acct.address, issuedAt), signature: forged })).toBe(false);
  });
});
