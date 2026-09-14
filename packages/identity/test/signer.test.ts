import { describe, expect, it } from "vitest";
import { CAIP2, createSigner } from "../src/index.js";

describe("createSigner", () => {
  it("secp256k1 derives the expected address", () => {
    const s = createSigner({ scheme: "secp256k1", privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" });
    expect(s.address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(s.scheme).toBe("secp256k1");
    expect(typeof s.account.signTypedData).toBe("function");
  });
  it("post-quantum scheme is a parameter, not an assumption: rejected explicitly today", () => {
    expect(() => createSigner({ scheme: "slh-dsa-sha2-128s", privateKey: "0x00" })).toThrow(/post-quantum/);
  });
  it("knows the Arc CAIP-2 ids", () => {
    expect(CAIP2.arcTestnet).toBe("eip155:5042002");
    expect(CAIP2.arc).toBe("eip155:5042");
  });
});
