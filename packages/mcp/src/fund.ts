/**
 * `cra-agent fund`: money for the agent on Arc, from where its dollars are.
 *
 * Most agents hold USDC on Base or on Solana; paying on Arc needs it in Circle Gateway on Arc. This brings it over
 * through Eco and Circle's CCTP (@cra-agent/lane checks Eco's quote before anything is signed), then deposits what
 * arrived into Gateway, keeping a little in the wallet for Arc's gas, which is paid in USDC. From Base it is the
 * agent's own key, the same address as on Arc; from Solana, a Solana key file of its own.
 *
 * It is the owner's command, run from a terminal. The model has no tool for it: moving money between chains is not
 * something an agent decides by itself.
 */
import { parseUsdc6, type Usdc6 } from "@cra-agent/accounting";

export interface FundArgs {
  /** Micro-USDC to move. */
  amount: bigint;
  from: "base" | "solana";
  solanaKeyFile?: string;
  maxFee?: bigint;
  /** Deposit what arrives into Circle Gateway. */
  deposit: boolean;
  /** Micro-USDC left in the wallet on Arc, for gas. */
  keep: bigint;
  dryRun: boolean;
}

const USDC = /^\d{1,9}(\.\d{1,6})?$/;
export const FUND_USAGE = "usage: fund <usdc> --from base|solana [--solana-key-file <file>] [--max-fee <usdc>] [--keep 0.01] [--no-deposit] [--dry-run]";

export function parseFundArgs(args: readonly string[]): FundArgs {
  const valued = new Set(["--from", "--solana-key-file", "--max-fee", "--keep"]);
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valued.has(a)) {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} needs a value. ${FUND_USAGE}`);
      flags.set(a, v);
    } else if (a.startsWith("--")) flags.set(a, "");
    else positional.push(a);
  }
  const amount = positional[0];
  if (!amount || !USDC.test(amount) || parseUsdc6(amount) === 0n) throw new Error(`the amount is USDC, like 5 or 2.5. ${FUND_USAGE}`);
  const from = flags.get("--from");
  if (from !== "base" && from !== "solana") throw new Error(`--from base or --from solana. ${FUND_USAGE}`);
  const keyFile = flags.get("--solana-key-file");
  if (from === "solana" && !keyFile) throw new Error("--from solana needs --solana-key-file: the Solana wallet's key, as our hex seed or solana-keygen's JSON");
  const usdc = (name: string): bigint | undefined => {
    const v = flags.get(name);
    if (v === undefined) return undefined;
    if (!USDC.test(v)) throw new Error(`${name} is an amount in USDC, like 0.01`);
    return parseUsdc6(v);
  };
  const maxFee = usdc("--max-fee");
  return {
    amount: parseUsdc6(amount),
    from,
    ...(keyFile ? { solanaKeyFile: keyFile } : {}),
    ...(maxFee === undefined ? {} : { maxFee }),
    deposit: !flags.has("--no-deposit"),
    keep: usdc("--keep") ?? parseUsdc6("0.01"),
    dryRun: flags.has("--dry-run"),
  };
}

/** What goes into Gateway: what arrived, but never the last `keep` of the wallet, which pays Arc's gas. */
export function depositAmount(arrived: bigint, walletNow: bigint, keep: bigint): Usdc6 {
  const spendable = walletNow > keep ? walletNow - keep : 0n;
  return (arrived < spendable ? arrived : spendable) as Usdc6;
}
