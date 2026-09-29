/**
 * From Base: USDC an agent holds on Base, moved to its wallet on Arc.
 *
 * The road is Eco Routes, as from Solana. Eco quotes the move and hands back one transaction for its Portal on
 * Base, publishAndFund: the funder's USDC goes into a vault made for this one intent, and a solver burns the same
 * amount through Circle's CCTP V2 with Arc as the destination and the funder's Arc address as the recipient. USDC
 * is minted on Arc seconds later. Nobody holds the money in between, us included.
 *
 * The quote is data from a server, so nothing is signed until the transaction itself says what was asked: its
 * calldata is decoded here, not read from the summary beside it. The vault the funder lets take its USDC is the
 * one the Portal derives for that very intent, asked of the Portal on Base. Arrival is read on Arc.
 *
 * Base needs ETH for gas: two transactions, the approval and the Portal's, about a cent together.
 */
import { createPublicClient, createWalletClient, decodeAbiParameters, decodeFunctionData, erc20Abi, http, parseAbi, type Account, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { ARC_CCTP_DOMAIN, ARC_CHAIN_ID, arrivalOnArc, ECO_QUOTES, no, SweepRefused, USDC_ARC, usdcOnArc } from "./common.js";

export const BASE_CHAIN_ID = 8453;
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** Eco's Portal on Base, and the prover it uses for intents that settle on Base itself. */
export const ECO_PORTAL_BASE = "0xEC000064576f9C95a8623Bc0eff3db6d296ea6df";
export const ECO_LOCAL_PROVER_BASE = "0xeC00008537c1F26E739486BCFCC818d81234d5aD";
/** Circle's CCTP V2 TokenMessenger, at the same address on every EVM chain it runs on. */
export const CCTP_V2_TOKEN_MESSENGER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";

export const PORTAL_ABI = parseAbi([
  "struct TokenAmount { address token; uint256 amount; }",
  "struct Reward { uint64 deadline; address creator; address prover; uint256 nativeAmount; TokenAmount[] tokens; }",
  "function publishAndFund(uint64 destination, bytes route, Reward reward, bool allowPartial) payable returns (bytes32, address)",
  "function intentVaultAddress(uint64 destination, bytes route, Reward reward) view returns (address)",
]);
/** The Route struct inside publishAndFund's `route` bytes. */
export const ROUTE_ABI = [
  {
    type: "tuple",
    components: [
      { name: "salt", type: "bytes32" },
      { name: "deadline", type: "uint64" },
      { name: "portal", type: "address" },
      { name: "nativeAmount", type: "uint256" },
      { name: "tokens", type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] },
      { name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "data", type: "bytes" }, { name: "value", type: "uint256" }] },
    ],
  },
] as const;
const CCTP_ABI = parseAbi(["function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)"]);

type Q = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Reward = { deadline: bigint; creator: Address; prover: Address; nativeAmount: bigint; tokens: readonly { token: Address; amount: bigint }[] };

export interface CheckedEvmQuote {
  quoteId: string;
  intentHash: string | null;
  amount: bigint;
  /** The least that arrives on Arc, in micro-USDC. */
  minAmountOut: bigint;
  fee: bigint;
  etaSeconds: number;
  /** The Portal's transaction, as quoted: sent as it is once everything in it has been checked. */
  transaction: { to: Address; data: Hex };
  /** Where the funder's USDC goes; the lane checks it against the Portal before approving it. */
  vault: Address;
  /** The decoded arguments, for asking the Portal which vault is this intent's. */
  intent: { destination: bigint; route: Hex; reward: Reward };
}

const same = (a: unknown, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const isEvm = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const onlyUsdc = (tokens: readonly { token: string; amount: bigint }[], amount: bigint): boolean => tokens.length === 1 && same(tokens[0]!.token, USDC_BASE) && tokens[0]!.amount === amount;

/** Everything a Base-to-Arc quote must say before its transaction is signed. Throws SweepRefused with the first thing that differs. */
export function checkEcoQuoteEvm(q: Q, e: { funder: string; recipient: string; amount: bigint; maxFee: bigint; now: number }): CheckedEvmQuote {
  if (q?.source?.chainId !== BASE_CHAIN_ID || !same(q.source.token, USDC_BASE)) no("the quote is not for USDC on Base");
  if (q.source.amount !== e.amount.toString()) no(`the quote is for ${q.source.amount} micro-USDC, not ${e.amount}`);
  if (!same(q.source.funder, e.funder)) no("the quote is for another Base wallet");
  if (q.destination?.chainId !== ARC_CHAIN_ID || !same(q.destination.token, USDC_ARC)) no("the quote does not deliver USDC on Arc");
  if (!same(q.destination.recipient, e.recipient)) no("the quote delivers to another Arc address");
  const minAmountOut = BigInt(q.destination.minAmountOut ?? 0);
  if (minAmountOut <= 0n || minAmountOut > e.amount) no("the quote's amount out makes no sense");
  const fee = e.amount - minAmountOut;
  if (fee > e.maxFee) no(`the fee, ${fee} micro-USDC, is over the cap of ${e.maxFee}`);
  if (!(Number(q.expiresAt) > e.now)) no("the quote has expired: ask again");

  // What will be sent, read from the calldata itself.
  const tx = q.execution?.transaction;
  if (tx?.type !== "evm" || tx.chainId !== BASE_CHAIN_ID) no("the quote's transaction is not on Base");
  if (!same(tx.to, ECO_PORTAL_BASE)) no(`the transaction goes to ${tx.to}, not Eco's Portal`);
  if (String(tx.value ?? "0") !== "0") no("the transaction sends ETH along");
  let call: ReturnType<typeof decodeFunctionData<typeof PORTAL_ABI>>;
  try {
    call = decodeFunctionData({ abi: PORTAL_ABI, data: tx.data as Hex });
  } catch {
    return no("the transaction is not the Portal's publishAndFund");
  }
  if (call.functionName !== "publishAndFund") no("the transaction is not the Portal's publishAndFund");
  const [destination, routeBytes, reward, allowPartial] = call.args as readonly [bigint, Hex, Reward, boolean];
  // The burn happens on Base: the intent is local, and CCTP carries it to Arc.
  if (destination !== BigInt(BASE_CHAIN_ID)) no(`the intent settles on chain ${destination}, not on Base`);
  if (allowPartial) no("the intent may be funded in part");
  if (!same(reward.creator, e.funder)) no("the intent's refund goes to another wallet");
  if (!same(reward.prover, ECO_LOCAL_PROVER_BASE)) no(`the intent is proved by ${reward.prover}, not Eco's prover on Base`);
  if (reward.nativeAmount !== 0n || !onlyUsdc(reward.tokens, e.amount)) no("the intent pays the solver something other than the USDC asked");
  if (!(Number(reward.deadline) > e.now)) no("the intent's deadline has passed");

  let route: { portal: Address; deadline: bigint; nativeAmount: bigint; tokens: readonly { token: Address; amount: bigint }[]; calls: readonly { target: Address; data: Hex; value: bigint }[] };
  try {
    [route] = decodeAbiParameters(ROUTE_ABI, routeBytes) as unknown as [typeof route];
  } catch {
    return no("the intent's route cannot be read");
  }
  if (!same(route.portal, ECO_PORTAL_BASE)) no("the intent is not for Eco's Portal");
  if (route.nativeAmount !== 0n || !onlyUsdc(route.tokens, e.amount)) no("the intent moves another amount than the one asked");
  if (!(Number(route.deadline) > e.now)) no("the intent's route has expired");
  if (route.calls.length === 0) no("the intent makes no call");
  let burned = 0n;
  let delivered = 0n;
  for (const c of route.calls) {
    if (c.value !== 0n) no("a call in the intent sends ETH");
    if (same(c.target, USDC_BASE)) {
      // Only letting CCTP take the USDC it burns.
      let approve: ReturnType<typeof decodeFunctionData<typeof erc20Abi>> | null = null;
      try {
        approve = decodeFunctionData({ abi: erc20Abi, data: c.data });
      } catch {
        approve = null;
      }
      if (approve?.functionName !== "approve" || !same(approve.args[0] as string, CCTP_V2_TOKEN_MESSENGER)) no("the intent does something with USDC other than letting CCTP burn it");
      continue;
    }
    if (!same(c.target, CCTP_V2_TOKEN_MESSENGER)) no(`the intent calls ${c.target}, not Circle's CCTP`);
    let burn: ReturnType<typeof decodeFunctionData<typeof CCTP_ABI>>;
    try {
      burn = decodeFunctionData({ abi: CCTP_ABI, data: c.data });
    } catch {
      return no("the intent's call is not a CCTP burn");
    }
    const [amount, domain, mintRecipient, burnToken, , maxFee] = burn.args;
    if (domain !== ARC_CCTP_DOMAIN) no(`the burn goes to CCTP domain ${domain}, not Arc's (${ARC_CCTP_DOMAIN})`);
    if (mintRecipient.toLowerCase() !== `0x${e.recipient.slice(2).toLowerCase().padStart(64, "0")}`) no("the burn mints to another address on Arc");
    if (!same(burnToken, USDC_BASE)) no("the burn is not of USDC");
    burned += amount;
    delivered += amount - maxFee;
  }
  if (burned !== e.amount) no("the intent burns another amount than the one asked");
  if (delivered < minAmountOut) no("the burn could deliver less than the quote promises");

  const vault = q.execution.vault;
  if (!isEvm(vault)) no("the quote names no vault");
  const steps = (q.steps ?? []) as Array<{ estimatedDurationSec?: number }>;
  return {
    quoteId: String(q.id),
    intentHash: typeof q.intentHash === "string" ? q.intentHash : null,
    amount: e.amount,
    minAmountOut,
    fee,
    etaSeconds: steps.reduce((s, x) => s + (x.estimatedDurationSec ?? 0), 0),
    transaction: { to: ECO_PORTAL_BASE, data: tx.data as Hex },
    vault: vault as Address,
    intent: { destination, route: routeBytes, reward },
  };
}

export interface BaseLaneOptions {
  readonly baseRpc?: string;
  readonly arcRpc?: string;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string) => void;
}

export function baseLane(o: BaseLaneOptions = {}) {
  const transport = http(o.baseRpc ?? "https://mainnet.base.org");
  const pub = createPublicClient({ chain: base, transport });
  const arcRpc = o.arcRpc ?? "https://rpc.mainnet.arc.io";
  const doFetch = o.fetchImpl ?? fetch;
  const log = o.log ?? (() => {});

  const usdcOnBase = (owner: Address): Promise<bigint> => pub.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  const ethOnBase = (owner: Address): Promise<bigint> => pub.getBalance({ address: owner });
  const quote = async (funder: string, recipient: string, amount: bigint): Promise<Q> => {
    const res = await doFetch(ECO_QUOTES, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "exact-in", source: { chainId: BASE_CHAIN_ID, token: USDC_BASE, amount: amount.toString(), funder }, destination: { chainId: ARC_CHAIN_ID, token: USDC_ARC, recipient }, refundRecipient: funder, dappId: "cra-agent" }),
      signal: AbortSignal.timeout(20_000),
    });
    const q = (await res.json().catch(() => null)) as Q | null;
    if (!q?.id) throw new SweepRefused(`Eco gave no quote: ${q?.detail ?? q?.title ?? `HTTP ${res.status}`}`);
    return q;
  };

  return {
    usdcOnBase,
    ethOnBase,

    /**
     * Moves `amount` micro-USDC from the account's wallet on Base to `to` on Arc. With `dryRun`, stops once the quote,
     * its vault and the wallet's gas have been checked: nothing is signed or sent.
     */
    async move(account: Account, to: string, opts: { amount: bigint; maxFee?: bigint; dryRun?: boolean; waitMs?: number }) {
      if (!isEvm(to)) throw new SweepRefused("the recipient must be a 0x address on Arc");
      const funder = account.address;
      const amount = opts.amount;
      if (amount <= 0n) throw new SweepRefused("the amount must be more than zero");
      const [held, eth] = await Promise.all([usdcOnBase(funder), ethOnBase(funder)]);
      if (amount > held) throw new SweepRefused(`the wallet holds ${Number(held) / 1e6} USDC on Base, less than ${Number(amount) / 1e6}`);
      log(`Base wallet ${funder}: ${Number(held) / 1e6} USDC, ${Number(eth) / 1e18} ETH for gas`);

      // Eco charges about 0.013% from Base today; the cap refuses anything far above that: 0.01 USDC or 0.5%, whichever is more.
      const maxFee = opts.maxFee ?? (amount / 200n > 10_000n ? amount / 200n : 10_000n);
      const checked = checkEcoQuoteEvm(await quote(funder, to, amount), { funder, recipient: to, amount, maxFee, now: Math.floor(Date.now() / 1000) });
      // The vault is where the approval goes: it must be the one the Portal itself derives for this intent.
      const { destination, route, reward } = checked.intent;
      const derived = await pub.readContract({ address: ECO_PORTAL_BASE, abi: PORTAL_ABI, functionName: "intentVaultAddress", args: [destination, route, reward] });
      if (!same(derived, checked.vault)) throw new SweepRefused(`the quote names vault ${checked.vault}, but the Portal derives ${derived} for this intent`);
      log(`Eco quote ${checked.quoteId}: ${Number(amount) / 1e6} USDC in, at least ${Number(checked.minAmountOut) / 1e6} on Arc, fee ${Number(checked.fee) / 1e6}, about ${checked.etaSeconds} s`);

      // Two transactions on Base: the approval, when the vault may not already take this much, and the Portal's.
      const allowance = await pub.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: "allowance", args: [funder, checked.vault] });
      const fees = await pub.estimateFeesPerGas();
      const gasBudget = 400_000n * fees.maxFeePerGas * 2n + 5_000_000_000_000n; // plus the L1 data fee Base adds, generously
      if (eth < gasBudget) throw new SweepRefused(`the wallet has ${Number(eth) / 1e18} ETH on Base, less than the ${Number(gasBudget) / 1e18} its two transactions may need: send a little ETH on Base to ${funder}`);
      if (opts.dryRun) return { dryRun: true as const, checked, vault: checked.vault, needsApproval: allowance < amount, ethForGas: eth, usdcOnBase: held };

      const wallet = createWalletClient({ account, chain: base, transport });
      const before = await usdcOnArc(arcRpc, to, doFetch);
      let approvalTx: Hex | null = null;
      if (allowance < amount) {
        approvalTx = await wallet.writeContract({ address: USDC_BASE, abi: erc20Abi, functionName: "approve", args: [checked.vault, amount], chain: base, account });
        const r = await pub.waitForTransactionReceipt({ hash: approvalTx, timeout: 90_000 });
        if (r.status !== "success") throw new SweepRefused(`the approval failed on Base: ${approvalTx}`);
        log(`approved the intent's vault for ${Number(amount) / 1e6} USDC: ${approvalTx}`);
      }
      const hash = await wallet.sendTransaction({ to: checked.transaction.to, data: checked.transaction.data, value: 0n, chain: base, account });
      const sentAt = Date.now();
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
      if (receipt.status !== "success") throw new SweepRefused(`the Portal's transaction failed on Base: ${hash}`);
      log(`sent on Base: ${hash}; waiting for the USDC on Arc`);
      const { arrived, grew } = await arrivalOnArc(() => usdcOnArc(arcRpc, to, doFetch), before, checked.minAmountOut, sentAt + (opts.waitMs ?? 300_000));
      return { dryRun: false as const, checked, approvalTx, hash, arrived, arrivedUsdc: grew, seconds: Math.round((Date.now() - sentAt) / 1000) };
    },
  };
}
