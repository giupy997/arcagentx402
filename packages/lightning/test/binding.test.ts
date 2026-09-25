import { describe, expect, it } from "vitest";
import { BindingError, checkParams, httpBinding, jcs, mcpBinding, type HttpRequestForBinding } from "../src/binding.js";

const get = (url: string, over: Partial<HttpRequestForBinding> = {}): HttpRequestForBinding => ({ method: "GET", url, body: null, header: () => null, ...over });

describe("request binding, from the spec's test vectors", () => {
  it("http:1: GET article A with no body and no bound headers", () => {
    const a = httpBinding(get("https://api.example.com/article/A"), { headers: [] });
    expect(jcs(a.binding)).toBe('{"bodyHash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","domain":"x402:exact:lnbtc:bolt11:http:1","headers":[],"method":"GET","url":"https://api.example.com/article/A"}');
    expect(a.requestHash).toBe("0d6623f775e025501fa7f0a30b54da25aad62b6ccfe35c85da38016711e6c018");
    expect(httpBinding(get("https://api.example.com/article/B"), { headers: [] }).requestHash).toBe("4a99860f75eed1ea8178a5db488e044173bc570c8a6210f2c8590cdf8622d509");
  });

  it("http:1: method, body and bound headers change the hash; absent and empty headers differ", () => {
    const base = httpBinding(get("https://api.example.com/article/A"), { headers: [] }).requestHash;
    expect(httpBinding(get("https://api.example.com/article/A", { method: "POST" }), { headers: [] }).requestHash).not.toBe(base);
    expect(httpBinding(get("https://api.example.com/article/A", { body: new Uint8Array([0x78]) }), { headers: [] }).requestHash).not.toBe(base);
    const absent = httpBinding(get("https://x.example/a"), { headers: ["accept"] }).requestHash;
    const empty = httpBinding(get("https://x.example/a", { header: () => "" }), { headers: ["accept"] }).requestHash;
    const json = httpBinding(get("https://x.example/a", { header: () => "  application/json " }), { headers: ["accept"] }).requestHash;
    const json2 = httpBinding(get("https://x.example/a", { header: () => "application/json" }), { headers: ["accept"] }).requestHash;
    expect(new Set([absent, empty, json]).size).toBe(3);
    expect(json).toBe(json2);
  });

  it("mcp:1: the spec's tool call and its independent changes", () => {
    const params = { server: "https://api.example.com/mcp", metadata: [] };
    const a = mcpBinding({ name: "get_article", arguments: { article: "A" } }, params);
    expect(jcs(a.binding)).toBe('{"arguments":{"article":"A"},"domain":"x402:exact:lnbtc:bolt11:mcp:1","metadata":[],"method":"tools/call","name":"get_article","server":"https://api.example.com/mcp"}');
    expect(a.requestHash).toBe("03941bfedc6af8a09b2f459fe83470284a76a8c75801caa9e1487a9276a693f4");
    expect(mcpBinding({ name: "get_article", arguments: { article: "B" } }, params).requestHash).toBe("b3e425970d64cd4f08fc4d57a11b76da59ce6a5760d92687398c91f063120678");
    expect(mcpBinding({ name: "delete_article", arguments: { article: "A" } }, params).requestHash).toBe("3a52bbf19dda8b5765a27246b12e805770298273b48526956c421f02fe043455");
    expect(mcpBinding({ name: "get_article", arguments: { article: "A" } }, { ...params, server: "https://other.example.com/mcp" }).requestHash).toBe("96903c29186c6aabc95e48abafd8ce3ad32b4060f5d5bf22cf75f3fbfe816e45");
    const bound = { server: "https://api.example.com/mcp", metadata: ["tenant"] };
    const absent = mcpBinding({ name: "get_article", arguments: { article: "A" } }, bound).binding as { metadata: Array<{ valueHash: string }> };
    const nul = mcpBinding({ name: "get_article", arguments: { article: "A" }, meta: { tenant: null } }, bound).binding as { metadata: Array<{ valueHash: string }> };
    expect(absent.metadata[0]!.valueHash).toBe("6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d");
    expect(nul.metadata[0]!.valueHash).toBe("c58dcb77cee9027d1f4b3207bd876d232e61f79ee9f9dbd4e6d834778da78b16");
    // Omitted arguments and {} are the same call; member order and whitespace do not matter.
    expect(mcpBinding({ name: "t" }, params).requestHash).toBe(mcpBinding({ name: "t", arguments: {} }, params).requestHash);
    expect(mcpBinding({ name: "t", arguments: { b: 1, a: [1, "x"] } }, params).requestHash).toBe(mcpBinding({ name: "t", arguments: JSON.parse('{ "a": [1,"x"], "b": 1 }') }, params).requestHash);
  });

  it("rejects malformed profiles and parameters instead of falling back", () => {
    expect(() => checkParams("http:2", { headers: [] })).toThrow(BindingError);
    expect(() => checkParams("http:1", {})).toThrow(BindingError);
    expect(() => checkParams("http:1", { headers: [], extra: 1 })).toThrow(BindingError);
    expect(() => checkParams("http:1", { headers: ["content-type", "accept"] })).toThrow(/ascending/);
    expect(() => checkParams("http:1", { headers: ["Accept"] })).toThrow(BindingError);
    expect(() => checkParams("http:1", { headers: ["payment-signature"] })).toThrow(BindingError);
    expect(() => checkParams("mcp:1", { server: "https://u:p@x.example/mcp", metadata: [] })).toThrow(BindingError);
    expect(() => checkParams("mcp:1", { server: "https://x.example/mcp", metadata: ["progressToken"] })).toThrow(BindingError);
    expect(() => httpBinding(get("https://api.example.com/a#frag"), { headers: [] })).toThrow(BindingError);
    expect(() => mcpBinding({ name: "t", arguments: null }, { server: "https://x.example/mcp", metadata: [] })).toThrow(BindingError);
    expect(() => jcs({ s: "\uD800" })).toThrow(BindingError);
  });
});
