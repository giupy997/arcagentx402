import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc20Abi, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SweepRefused } from "../src/common.js";
import { baseLane, checkEcoQuoteEvm, ECO_PORTAL_BASE, PORTAL_ABI, ROUTE_ABI } from "../src/base.js";
import quote from "./fixtures/eco-quote-base-arc.json";

// A real quote from Eco (29 Sep 2026): 1 USDC from our agent's wallet on Base to the same address on Arc.
const AGENT = "0xe5a67b7ddf06A6e63A8e0423195aA3b76002cF2B";
const OTHER = "0x000000000000000000000000000000000000dEaD";
const ok = { funder: AGENT, recipient: AGENT, amount: 1_000_000n, maxFee: 10_000n, now: quote.expiresAt - 30 };
const copy = () => JSON.parse(JSON.stringify(quote)) as typeof quote;
const CCTP = parseAbi(["function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)"]);

type Route = { salt: Hex; deadline: bigint; portal: Hex; nativeAmount: bigint; tokens: { token: Hex; amount: bigint }[]; calls: { target: Hex; data: Hex; value: bigint }[] };
/** The quote's transaction, taken apart, changed, and put back together: what a tampered quote would carry. */
function tamper(change: (t: { destination: bigint; route: Route; reward: any; allowPartial: boolean }) => void) {
  const q = copy();
  const call = decodeFunctionData({ abi: PORTAL_ABI, data: q.execution.transaction.data as Hex });
  const [destination, routeBytes, reward, allowPartial] = call.args as any;
  const [route] = decodeAbiParameters(ROUTE_ABI, routeBytes) as any;
  const t = { destination, route: { ...route, calls: [...route.calls], tokens: [...route.tokens] }, reward: { ...reward, tokens: [...reward.tokens] }, allowPartial };
  change(t);
  q.execution.transaction.data = encodeFunctionData({ abi: PORTAL_ABI, functionName: "publishAndFund", args: [t.destination, encodeAbiParameters(ROUTE_ABI, [t.route as any]), t.reward, t.allowPartial] });
  return q;
}
const burnCall = (over: Partial<{ amount: bigint; domain: number; recipient: Hex; maxFee: bigint }> = {}) => ({
  target: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" as Hex,
  value: 0n,
  data: encodeFunctionData({ abi: CCTP, functionName: "depositForBurn", args: [over.amount ?? 1_000_000n, over.domain ?? 26, `0x${(over.recipient ?? AGENT).slice(2).toLowerCase().padStart(64, "0")}` as Hex, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", `0x${"0".repeat(64)}` as Hex, over.maxFee ?? 130n, 1000] }),
});
const refused = (q: unknown, e = ok) => {
  try {
    checkEcoQuoteEvm(q as Record<string, unknown>, e);
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(SweepRefused);
    return (err as Error).message;
  }
};

describe("checking Eco's Base-to-Arc quote before anything is signed", () => {
  it("accepts the real quote, read from its calldata", () => {
    const c = checkEcoQuoteEvm(quote, ok);
    expect(c).toMatchObject({ amount: 1_000_000n, minAmountOut: 999_870n, fee: 130n, etaSeconds: 7, vault: quote.execution.vault });
    expect(c.transaction.to).toBe(ECO_PORTAL_BASE);
    expect(c.intent.destination).toBe(8453n);
  });

  it("refuses a quote that pays someone else, anywhere it could be said", () => {
    const summary = copy();
    summary.destination.recipient = OTHER;
    expect(refused(summary)).toMatch(/another Arc address/);
    expect(refused(tamper((t) => void (t.route.calls[1] = burnCall({ recipient: OTHER }))))).toMatch(/mints to another address/);
    expect(refused(tamper((t) => void (t.reward.creator = OTHER)))).toMatch(/refund goes to another wallet/);
  });

  it("refuses another chain, another contract, another prover, a partial funding or a bigger fee", () => {
    expect(refused(tamper((t) => void (t.route.calls[1] = burnCall({ domain: 6 }))))).toMatch(/CCTP domain 6/);
    expect(refused(tamper((t) => void (t.route.calls[1] = burnCall({ maxFee: 5000n }))))).toMatch(/less than the quote promises/);
    expect(refused(tamper((t) => void (t.reward.prover = OTHER)))).toMatch(/not Eco's prover/);
    expect(refused(tamper((t) => void (t.allowPartial = true)))).toMatch(/funded in part/);
    expect(refused(tamper((t) => void (t.destination = 5042n)))).toMatch(/settles on chain 5042/);
    const to = copy();
    to.execution.transaction.to = OTHER;
    expect(refused(to)).toMatch(/not Eco's Portal/);
    const value = copy();
    value.execution.transaction.value = "1";
    expect(refused(value)).toMatch(/sends ETH/);
    expect(refused(quote, { ...ok, maxFee: 129n })).toMatch(/over the cap/);
    expect(refused(quote, { ...ok, now: quote.expiresAt + 1 })).toMatch(/expired/);
    expect(refused(quote, { ...ok, amount: 2_000_000n })).toMatch(/not 2000000/);
  });

  it("refuses any call in the intent other than letting CCTP burn the USDC and burning it", () => {
    const transfer = { target: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Hex, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [OTHER, 1_000_000n] }) };
    expect(refused(tamper((t) => void t.route.calls.push(transfer)))).toMatch(/other than letting CCTP burn it/);
    expect(refused(tamper((t) => void t.route.calls.push({ target: OTHER, value: 0n, data: "0x" })))).toMatch(/not Circle's CCTP/);
    expect(refused(tamper((t) => void t.route.calls.push(burnCall())))).toMatch(/burns another amount/);
  });
});

describe("the lane from Base, up to the point of signing", () => {
  afterEach(() => void vi.useRealTimers());

  /** Base as far as the lane asks it, and Eco answering with the real quote. */
  function chain(o: { vault?: string; eth?: bigint; allowance?: bigint; portalRefuses?: boolean } = {}) {
    const sent: string[] = [];
    const spenders: string[] = [];
    const word = (v: bigint | string) => `0x${(typeof v === "bigint" ? v.toString(16) : v.slice(2).toLowerCase()).padStart(64, "0")}`;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://api.eco.com")) return Response.json(quote);
      const { id, method, params } = JSON.parse(String(init!.body));
      sent.push(method);
      const result = (() => {
        if (method === "eth_chainId") return "0x2105";
        if (method === "eth_getBalance") return `0x${(o.eth ?? 10n ** 15n).toString(16)}`;
        if (method === "eth_maxPriorityFeePerGas") return "0x100000";
        if (method === "eth_getBlockByNumber") return { baseFeePerGas: "0x1000000", number: "0x1", timestamp: "0x1", transactions: [] };
        if (method === "eth_call") {
          const data: string = params[0].data;
          if (data.startsWith("0x70a08231")) return word(2_000_000n); // USDC balanceOf
          if (data.startsWith("0xdd62ed3e")) {
            spenders.push(`0x${data.slice(98, 138)}`);
            return word(o.allowance ?? 0n); // allowance
          }
          if (data.startsWith("0xdf00f8fa") && o.portalRefuses) return { error: { code: 3, message: "execution reverted", data: `0x07b90620${"82".repeat(32)}` } }; // InsufficientFunds(bytes32)
          return word(o.vault ?? quote.execution.vault); // the Portal's intentVaultAddress
        }
        throw new Error(`unexpected ${method}`);
      })();
      if (result && typeof result === "object" && "error" in result) return Response.json({ jsonrpc: "2.0", id, error: result.error });
      return Response.json({ jsonrpc: "2.0", id, result });
    }) as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);
    return { lane: baseLane({ baseRpc: "http://base.test", arcRpc: "http://arc.test", fetchImpl }), sent, spenders };
  }
  const account = privateKeyToAccount("0x0000000000000000000000000000000000000000000000000000000000000003");
  const as = (addr: string) => ({ ...account, address: addr as Hex });

  it("checks the quote, the vault against the Portal and the gas, and sends nothing on a dry run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((quote.expiresAt - 30) * 1000);
    const { lane, sent, spenders } = chain();
    const r = await lane.move(as(AGENT), AGENT, { amount: 1_000_000n, dryRun: true });
    expect(r).toMatchObject({ dryRun: true, vault: quote.execution.vault, needsApproval: true });
    // The Portal is what takes the USDC in publishAndFund, on an allowance only the funder's own calls can spend.
    expect(spenders).toEqual([ECO_PORTAL_BASE.toLowerCase()]);
    expect(sent).not.toContain("eth_sendRawTransaction");
    vi.unstubAllGlobals();
  });

  it("tries the Portal's transaction before sending it, and refuses with the Portal's own reason", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((quote.expiresAt - 30) * 1000);
    const { lane, sent } = chain({ allowance: 1_000_000n, portalRefuses: true });
    await expect(lane.move(as(AGENT), AGENT, { amount: 1_000_000n })).rejects.toThrow(/Portal would refuse the transaction \(InsufficientFunds\)/);
    expect(sent).not.toContain("eth_sendRawTransaction");
    vi.unstubAllGlobals();
  });

  it("refuses a vault the Portal does not derive for the intent, and a wallet without gas", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((quote.expiresAt - 30) * 1000);
    await expect(chain({ vault: OTHER }).lane.move(as(AGENT), AGENT, { amount: 1_000_000n, dryRun: true })).rejects.toThrow(/the Portal derives/);
    await expect(chain({ eth: 0n }).lane.move(as(AGENT), AGENT, { amount: 1_000_000n, dryRun: true })).rejects.toThrow(/send a little ETH on Base/);
    await expect(chain().lane.move(as(AGENT), AGENT, { amount: 3_000_000n, dryRun: true })).rejects.toThrow(/less than 3/);
    vi.unstubAllGlobals();
  });
});
