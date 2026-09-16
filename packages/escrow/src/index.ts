/**
 * @cra-agent/escrow — the ERC-8183 rail for jobs that are too large or too slow for a nanopayment.
 *
 * Client → Provider → Evaluator. State machine: Open → Funded → Submitted → Completed | Rejected | Expired.
 * The evaluator is an injected address (brief: never hardcoded); by default the client evaluates its own jobs.
 * Escrowed USDC lives in the contract, separate from the agent's operating balance (phase 3 can invest it).
 */
import { formatUsdc6, usdc6, type Usdc6 } from "@cra-agent/accounting";
import { CHAINS, type ArcNetwork, type RailSigner } from "@cra-agent/identity";
import { createPublicClient, createWalletClient, http, keccak256, parseEventLogs, stringToHex, type Address, type Hex } from "viem";
import { AGENTIC_COMMERCE_ABI, ERC20_ABI } from "./abi.js";

export { AGENTIC_COMMERCE_ABI, ERC20_ABI } from "./abi.js";

/** From docs.arc.io/arc/tutorials/create-your-first-erc-8183-job (2026-09-14). Mainnet: no bytecode at this address
 * on chain 5042 (checked 2026-09-16), so the escrow rail is testnet-only until Circle deploys it. */
export const AGENTIC_COMMERCE: Record<ArcNetwork, Address | null> = {
  arcTestnet: "0x0747EEf0706327138c69792bF28Cd525089e4583",
  arc: null,
};
export const ARC_USDC: Address = "0x3600000000000000000000000000000000000000";
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export type JobStatus = "Open" | "Funded" | "Submitted" | "Completed" | "Rejected" | "Expired";
const STATUS: readonly JobStatus[] = ["Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"];

export function jobStatusFromCode(code: number): JobStatus {
  const s = STATUS[code];
  if (!s) throw new Error(`unknown ERC-8183 job status ${code}`);
  return s;
}

export interface Job {
  readonly id: bigint;
  readonly client: Address;
  readonly provider: Address;
  readonly evaluator: Address;
  readonly description: string;
  readonly budget: Usdc6;
  readonly budgetUsdc: string;
  readonly expiredAt: number;
  readonly status: JobStatus;
  readonly hook: Address;
}

/** Reasons are bytes32: keccak256 of a short string, so they stay cheap and greppable in logs. */
export const reasonHash = (text: string): Hex => keccak256(stringToHex(text));

export interface EscrowConfig {
  readonly network: ArcNetwork;
  readonly signer: RailSigner;
  readonly rpcUrl?: string;
  readonly contract?: Address;
  /** Default evaluator for jobs this agent creates. Omit = the agent itself. */
  readonly evaluator?: Address;
}

export interface EscrowClient {
  readonly address: Address;
  readonly contract: Address;
  readonly evaluator: Address;
  createJob(input: { provider: Address; description: string; expiresInSeconds: number; evaluator?: Address; hook?: Address }): Promise<{ jobId: bigint; txHash: Hex }>;
  setBudget(jobId: bigint, budget: Usdc6): Promise<{ txHash: Hex }>;
  /** Approves USDC for the contract if needed, then funds. Client only. */
  fund(jobId: bigint): Promise<{ txHash: Hex; approveTxHash: Hex | null; amount: Usdc6 }>;
  submit(jobId: bigint, deliverable: Hex): Promise<{ txHash: Hex }>;
  complete(jobId: bigint, reason: string): Promise<{ txHash: Hex }>;
  reject(jobId: bigint, reason: string): Promise<{ txHash: Hex }>;
  claimRefund(jobId: bigint): Promise<{ txHash: Hex }>;
  getJob(jobId: bigint): Promise<Job>;
  jobCount(): Promise<bigint>;
  fees(): Promise<{ platformBp: bigint; evaluatorBp: bigint }>;
}

export function createEscrowClient(cfg: EscrowConfig): EscrowClient {
  const known = cfg.contract ?? AGENTIC_COMMERCE[cfg.network];
  if (!known) throw new Error(`no ERC-8183 contract known for ${cfg.network}; pass contract explicitly`);
  const contract: Address = known;
  const chain = CHAINS[cfg.network];
  const transport = http(cfg.rpcUrl);
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ chain, transport, account: cfg.signer.account });
  const evaluator = cfg.evaluator ?? cfg.signer.address;

  async function write(functionName: "setBudget" | "fund" | "submit" | "complete" | "reject" | "claimRefund", args: readonly unknown[]): Promise<Hex> {
    const { request } = await pub.simulateContract({ address: contract, abi: AGENTIC_COMMERCE_ABI, functionName, args: args as never, account: cfg.signer.account });
    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted in ${hash}`);
    return hash;
  }

  return {
    address: cfg.signer.address,
    contract,
    evaluator,

    async createJob({ provider, description, expiresInSeconds, evaluator: ev, hook }) {
      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + expiresInSeconds);
      const { request } = await pub.simulateContract({ address: contract, abi: AGENTIC_COMMERCE_ABI, functionName: "createJob", args: [provider, ev ?? evaluator, expiredAt, description, hook ?? ZERO_ADDRESS], account: cfg.signer.account });
      const txHash = await wallet.writeContract(request);
      const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success") throw new Error(`createJob reverted in ${txHash}`);
      const [created] = parseEventLogs({ abi: AGENTIC_COMMERCE_ABI, eventName: "JobCreated", logs: receipt.logs });
      if (!created) throw new Error("createJob: no JobCreated event in receipt");
      return { jobId: created.args.jobId, txHash };
    },

    async setBudget(jobId, budget) {
      return { txHash: await write("setBudget", [jobId, budget, "0x"]) };
    },

    async fund(jobId) {
      const job = await this.getJob(jobId);
      if (job.status !== "Open") throw new Error(`job ${jobId} is ${job.status}, not Open`);
      if (job.budget === 0n) throw new Error(`job ${jobId} has no budget yet (the provider must call setBudget first)`);
      const allowance = await pub.readContract({ address: ARC_USDC, abi: ERC20_ABI, functionName: "allowance", args: [cfg.signer.address, contract] });
      let approveTxHash: Hex | null = null;
      if (allowance < job.budget) {
        const { request } = await pub.simulateContract({ address: ARC_USDC, abi: ERC20_ABI, functionName: "approve", args: [contract, job.budget], account: cfg.signer.account });
        approveTxHash = await wallet.writeContract(request);
        await pub.waitForTransactionReceipt({ hash: approveTxHash });
      }
      const txHash = await write("fund", [jobId, "0x"]);
      return { txHash, approveTxHash, amount: job.budget };
    },

    async submit(jobId, deliverable) {
      return { txHash: await write("submit", [jobId, deliverable, "0x"]) };
    },
    async complete(jobId, reason) {
      return { txHash: await write("complete", [jobId, reasonHash(reason), "0x"]) };
    },
    async reject(jobId, reason) {
      return { txHash: await write("reject", [jobId, reasonHash(reason), "0x"]) };
    },
    async claimRefund(jobId) {
      return { txHash: await write("claimRefund", [jobId]) };
    },

    async getJob(jobId) {
      const j = await pub.readContract({ address: contract, abi: AGENTIC_COMMERCE_ABI, functionName: "getJob", args: [jobId] });
      const budget = usdc6(j.budget);
      return { id: j.id, client: j.client, provider: j.provider, evaluator: j.evaluator, description: j.description, budget, budgetUsdc: formatUsdc6(budget), expiredAt: Number(j.expiredAt), status: jobStatusFromCode(j.status), hook: j.hook };
    },
    async jobCount() {
      return pub.readContract({ address: contract, abi: AGENTIC_COMMERCE_ABI, functionName: "jobCounter" });
    },
    async fees() {
      const [platformBp, evaluatorBp] = await Promise.all([
        pub.readContract({ address: contract, abi: AGENTIC_COMMERCE_ABI, functionName: "platformFeeBP" }),
        pub.readContract({ address: contract, abi: AGENTIC_COMMERCE_ABI, functionName: "evaluatorFeeBP" }),
      ]);
      return { platformBp, evaluatorBp };
    },
  };
}
