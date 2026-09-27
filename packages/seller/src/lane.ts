/**
 * Solana Lane, second half: USDC a seller earned on Solana, moved to its wallet on Arc.
 *
 * The road is Eco Routes. Eco quotes the move and hands back one Solana instruction for its Portal program:
 * the seller deposits USDC there, and a solver burns it through Circle's CCTP V2 with Arc as the destination
 * and the seller's Arc address as the recipient. USDC is minted on Arc a few seconds later. Nobody holds the
 * money in between, us included.
 *
 * The quote is data from a server, so nothing is signed until it says exactly what was asked: the amount,
 * the Arc recipient, a fee under the cap, Eco's program, the seller as the only signer, and inside it a CCTP
 * burn to Arc's domain for that recipient. Arrival is then read on Arc, not taken on trust.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createKeyPairSignerFromPrivateKeyBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type KeyPairSigner,
} from "@solana/kit";

export const SOLANA_CHAIN_ID = 1399811149;
export const ARC_CHAIN_ID = 5042;
export const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_ARC = "0x3600000000000000000000000000000000000000";
/** Eco's Portal program on Solana: where the deposit goes. */
export const ECO_PORTAL = "EcooswwC1NggsckZyF5SeAL9WsgJs3UhPbrqY1apV73F";
/** Circle's CCTP V2 token messenger on Solana, and Arc's CCTP domain. */
export const CCTP_V2_SOLANA = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe";
export const ARC_CCTP_DOMAIN = 26;
const DEPOSIT_FOR_BURN = createHash("sha256").update("global:deposit_for_burn").digest().subarray(0, 8).toString("hex");
const ECO_QUOTES = "https://api.eco.com/v1/quotes";

export class SweepRefused extends Error {
  override readonly name = "SweepRefused";
}

interface EcoAccount {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}
export interface EcoInstruction {
  programId: string;
  accounts: EcoAccount[];
  /** Base64. */
  data: string;
}

export interface CheckedQuote {
  quoteId: string;
  intentHash: string | null;
  amount: bigint;
  /** The least that arrives on Arc, in micro-USDC. */
  minAmountOut: bigint;
  fee: bigint;
  etaSeconds: number;
  instruction: EcoInstruction;
}

type Q = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const no = (reason: string): never => {
  throw new SweepRefused(reason);
};
const isEvm = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/** The CCTP V2 burn one of the route's calls makes: amount, destination domain, recipient, fee cap. */
export function readBurn(dataHex: string): { amount: bigint; domain: number; recipient: string; maxFee: bigint } | null {
  try {
    const b = Buffer.from(dataHex.replace(/^0x/, ""), "hex");
    const len = b.readUInt32LE(0);
    const cd = b.subarray(4, 4 + len);
    if (cd.length < 96 || cd.subarray(0, 8).toString("hex") !== DEPOSIT_FOR_BURN) return null;
    const recipient32 = cd.subarray(20, 52);
    // An EVM address, left-padded to 32 bytes.
    if (!recipient32.subarray(0, 12).equals(Buffer.alloc(12))) return null;
    return { amount: cd.readBigUInt64LE(8), domain: cd.readUInt32LE(16), recipient: `0x${recipient32.subarray(12).toString("hex")}`, maxFee: cd.readBigUInt64LE(84) };
  } catch {
    return null;
  }
}

/** Everything a quote must say before its transaction is signed. Throws SweepRefused with the first thing that differs. */
export function checkEcoQuote(q: Q, e: { funder: string; recipient: string; amount: bigint; maxFee: bigint; now: number }): CheckedQuote {
  const recipient = e.recipient.toLowerCase();
  if (q?.source?.chainId !== SOLANA_CHAIN_ID || q.source.token !== USDC_SOLANA) no("the quote is not for USDC on Solana");
  if (q.source.amount !== e.amount.toString()) no(`the quote is for ${q.source.amount} micro-USDC, not ${e.amount}`);
  if (q.source.funder !== e.funder) no("the quote is for another Solana wallet");
  if (q.destination?.chainId !== ARC_CHAIN_ID || String(q.destination.token).toLowerCase() !== USDC_ARC) no("the quote does not deliver USDC on Arc");
  if (String(q.destination.recipient).toLowerCase() !== recipient) no("the quote delivers to another Arc address");
  const minAmountOut = BigInt(q.destination.minAmountOut ?? 0);
  if (minAmountOut <= 0n || minAmountOut > e.amount) no("the quote's amount out makes no sense");
  const fee = e.amount - minAmountOut;
  if (fee > e.maxFee) no(`the fee, ${fee} micro-USDC, is over the cap of ${e.maxFee}`);
  if (!(Number(q.expiresAt) > e.now)) no("the quote has expired: ask again");

  const tx = q.execution?.transaction;
  if (tx?.type !== "svm" || tx.chainId !== SOLANA_CHAIN_ID || tx.feePayer !== e.funder) no("the quote's transaction is not the seller's, on Solana");
  const ixs = tx.instructions as EcoInstruction[] | undefined;
  if (!Array.isArray(ixs) || ixs.length !== 1) no("the quote's transaction should be one instruction");
  const ix = ixs![0]!;
  if (ix.programId !== ECO_PORTAL) no(`the instruction is for ${ix.programId}, not Eco's Portal`);
  if (!ix.accounts.every((a) => !a.isSigner || a.pubkey === e.funder)) no("the instruction asks another account to sign");

  const intent = q.execution.intent;
  if (intent?.route?.portal !== ECO_PORTAL) no("the intent is not for Eco's Portal");
  const sum = (tokens: Array<{ token: string; amount: string }> | undefined) => (tokens ?? []).reduce((s, t) => (t.token === USDC_SOLANA ? s + BigInt(t.amount) : no("the intent moves a token other than USDC")), 0n);
  if (sum(intent.route.tokens) !== e.amount || sum(intent.reward?.tokens) !== e.amount) no("the intent moves another amount than the one asked");
  if (intent.reward?.creator !== e.funder) no("the intent's refund goes to another wallet");
  if (!(Number(intent.route.deadline) > e.now)) no("the intent's deadline has passed");

  const calls = intent.route.calls as Array<{ target: string; data: string }> | undefined;
  if (!Array.isArray(calls) || calls.length === 0) no("the intent makes no call");
  for (const call of calls!) {
    if (call.target !== CCTP_V2_SOLANA) no(`the intent calls ${call.target}, not Circle's CCTP`);
    const burn = readBurn(call.data);
    if (!burn) no("the intent's call is not a CCTP burn");
    if (burn!.domain !== ARC_CCTP_DOMAIN) no(`the burn goes to CCTP domain ${burn!.domain}, not Arc's (${ARC_CCTP_DOMAIN})`);
    if (burn!.recipient !== recipient) no("the burn mints to another address on Arc");
    if (burn!.amount - burn!.maxFee < minAmountOut) no("the burn could deliver less than the quote promises");
  }
  const steps = (q.steps ?? []) as Array<{ estimatedDurationSec?: number }>;
  return { quoteId: String(q.id), intentHash: typeof q.intentHash === "string" ? q.intentHash : null, amount: e.amount, minAmountOut, fee, etaSeconds: steps.reduce((s, x) => s + (x.estimatedDurationSec ?? 0), 0), instruction: ix };
}

/** A Solana key file: the 32-byte seed as hex (ours), or the JSON array of 64 bytes solana-keygen writes. */
export async function readSolanaSigner(path: string): Promise<KeyPairSigner> {
  const raw = readFileSync(path, "utf8").trim();
  let seed: Uint8Array;
  if (raw.startsWith("[")) {
    const bytes = JSON.parse(raw) as number[];
    if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error(`${path}: expected solana-keygen's array of 64 bytes`);
    seed = Uint8Array.from(bytes.slice(0, 32));
  } else if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    seed = Uint8Array.from(Buffer.from(raw, "hex"));
  } else {
    throw new Error(`${path}: expected a 32-byte seed in hex, or solana-keygen's JSON array`);
  }
  return createKeyPairSignerFromPrivateKeyBytes(seed);
}

const roleOf = (a: EcoAccount): AccountRole => (a.isSigner ? (a.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY);

export interface LaneOptions {
  readonly solanaRpc?: string;
  readonly arcRpc?: string;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string) => void;
}

export function solanaLane(o: LaneOptions = {}) {
  const rpc = createSolanaRpc(o.solanaRpc ?? "https://api.mainnet-beta.solana.com");
  const arcRpc = o.arcRpc ?? "https://rpc.mainnet.arc.io";
  const doFetch = o.fetchImpl ?? fetch;
  const log = o.log ?? (() => {});

  const usdcOnSolana = async (owner: string): Promise<bigint> => {
    const r = await rpc.getTokenAccountsByOwner(address(owner), { mint: address(USDC_SOLANA) }, { encoding: "jsonParsed" }).send();
    return r.value.reduce((s, a) => s + BigInt((a.account.data as unknown as { parsed: { info: { tokenAmount: { amount: string } } } }).parsed.info.tokenAmount.amount), 0n);
  };
  const solOnSolana = async (owner: string): Promise<bigint> => BigInt((await rpc.getBalance(address(owner)).send()).value);
  const usdcOnArc = async (owner: string): Promise<bigint> => {
    const res = await doFetch(arcRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC_ARC, data: `0x70a08231${owner.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"] }), signal: AbortSignal.timeout(15_000) });
    const d = (await res.json()) as { result?: string };
    return BigInt(d.result && d.result !== "0x" ? d.result : "0x0");
  };
  const quote = async (funder: string, recipient: string, amount: bigint): Promise<Q> => {
    const res = await doFetch(ECO_QUOTES, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "exact-in", source: { chainId: SOLANA_CHAIN_ID, token: USDC_SOLANA, amount: amount.toString(), funder }, destination: { chainId: ARC_CHAIN_ID, token: USDC_ARC, recipient }, refundRecipient: funder, dappId: "cra-agent" }),
      signal: AbortSignal.timeout(20_000),
    });
    const q = (await res.json().catch(() => null)) as Q | null;
    if (!q?.id) throw new SweepRefused(`Eco gave no quote: ${q?.detail ?? q?.title ?? `HTTP ${res.status}`}`);
    return q;
  };

  const message = async (signer: KeyPairSigner, ix: EcoInstruction) => {
    const { value: blockhash } = await rpc.getLatestBlockhash().send();
    return pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) =>
        appendTransactionMessageInstruction(
          {
            programAddress: address(ix.programId),
            accounts: ix.accounts.map((a) => ({ address: address(a.pubkey), role: roleOf(a), ...(a.isSigner ? { signer } : {}) })),
            data: Uint8Array.from(Buffer.from(ix.data, "base64")),
          },
          m,
        ),
    );
  };

  return {
    usdcOnSolana,
    solOnSolana,
    usdcOnArc,

    /**
     * Moves `amount` micro-USDC (all of it when absent) from the signer's Solana wallet to `to` on Arc. With
     * `dryRun`, stops after the quote's checks and a simulation of the transaction: nothing is signed or sent.
     */
    async sweep(signer: KeyPairSigner, to: string, opts: { amount?: bigint; maxFee?: bigint; dryRun?: boolean; waitMs?: number } = {}) {
      if (!isEvm(to)) throw new SweepRefused("--to must be a 0x address on Arc");
      const funder = signer.address;
      const [held, sol] = await Promise.all([usdcOnSolana(funder), solOnSolana(funder)]);
      const amount = opts.amount ?? held;
      if (amount <= 0n) throw new SweepRefused("there is no USDC to move in this Solana wallet");
      if (amount > held) throw new SweepRefused(`the wallet holds ${held} micro-USDC, less than ${amount}`);
      log(`Solana wallet ${funder}: ${Number(held) / 1e6} USDC, ${Number(sol) / 1e9} SOL for fees`);

      // Eco charges about 0.02% today; the cap refuses anything far above that: 0.01 USDC or 0.5%, whichever is more.
      const maxFee = opts.maxFee ?? (amount / 200n > 10_000n ? amount / 200n : 10_000n);
      const checked = checkEcoQuote(await quote(funder, to, amount), { funder, recipient: to, amount, maxFee, now: Math.floor(Date.now() / 1000) });
      log(`Eco quote ${checked.quoteId}: ${Number(amount) / 1e6} USDC in, at least ${Number(checked.minAmountOut) / 1e6} on Arc, fee ${Number(checked.fee) / 1e6}, about ${checked.etaSeconds} s`);

      const msg = await message(signer, checked.instruction);
      if (opts.dryRun) {
        const unsigned = getBase64EncodedWireTransaction(compileTransaction(msg));
        const sim = await rpc.simulateTransaction(unsigned, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }).send();
        return { dryRun: true as const, checked, simulation: { ok: sim.value.err === null, error: sim.value.err === null ? null : JSON.stringify(sim.value.err, (_, v) => (typeof v === "bigint" ? v.toString() : v)), logs: (sim.value.logs ?? []).slice(-6), units: sim.value.unitsConsumed === undefined || sim.value.unitsConsumed === null ? null : Number(sim.value.unitsConsumed) } };
      }

      const before = await usdcOnArc(to);
      const signed = await signTransactionMessageWithSigners(msg);
      const signature = getSignatureFromTransaction(signed);
      await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" }).send();
      log(`sent on Solana: ${signature}`);
      const sentAt = Date.now();
      for (;;) {
        const [status] = (await rpc.getSignatureStatuses([signature]).send()).value;
        if (status?.err) throw new SweepRefused(`the Solana transaction failed: ${JSON.stringify(status.err, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
        if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") break;
        if (Date.now() - sentAt > 90_000) throw new SweepRefused(`not confirmed on Solana after 90 s: look it up, ${signature}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
      log("confirmed on Solana; waiting for the USDC on Arc");
      const deadline = sentAt + (opts.waitMs ?? 300_000);
      let after = before;
      while (Date.now() < deadline) {
        after = await usdcOnArc(to).catch(() => after);
        if (after - before >= checked.minAmountOut) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
      const arrived = after - before >= checked.minAmountOut;
      return { dryRun: false as const, checked, signature, arrived, arrivedUsdc: after - before, seconds: Math.round((Date.now() - sentAt) / 1000) };
    },
  };
}
