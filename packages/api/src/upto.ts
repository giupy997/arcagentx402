/**
 * Routes billed by use (x402 `upto`): the buyer signs for a ceiling, and we take what the call cost.
 *
 * The first is the thinking agent, hired. The buyer sends a task and signs for up to $0.10. The agent pays for
 * its thoughts and its tools from its own wallet, under its own limits, on the worker next to this process
 * (think-worker.ts in @cra-agent/mcp). The buyer is charged what the run spent plus a flat fee that pays the gas
 * of settling, never more than the ceiling, and nothing when the run could not start. The buyer signs once and
 * sends no transaction: USDC on Arc takes a permit, and our facilitator submits it with the payment.
 */
import type { Hono } from "hono";
import type { Logger } from "pino";
import { addUsdc6, compareUsdc6, formatUsdc6, headroomUsdc6, parseUsdc6 } from "@cra-agent/accounting";
import { charge, createSeller, type DiscoveryRail, type SettlementEvent, type SolanaRail } from "@cra-agent/seller";

export const THINK_CEILING_USDC = "0.10";
/** Settling an upto payment with its permit uses about 180,000 gas: $0.0036 at Arc's 20 gwei. */
export const THINK_FEE_USDC = "0.005";
const TASK_MAX_CHARS = 500;
/** The worker ends a run by its own deadline (150 s); this waits a little longer for the last call to land. */
const WAIT_MS = 180_000;

interface ThinkStep {
  kind: string;
  detail: string;
  costUsdc: string;
  ledgerId?: string | null;
  [k: string]: unknown;
}
interface ThinkRun {
  answer: string | null;
  stoppedBecause: string;
  steps: ThinkStep[];
  spent: { thinkingUsdc: string; toolsUsdc: string; totalUsdc: string; thoughts: number; purchases: number };
}

export interface UptoOptions {
  sellerAddress: string;
  network: "arc" | "arcTestnet";
  /** The facilitator that settles upto on Arc: ours, on this host. */
  facilitatorUrl: string;
  /** The think worker, on this host. */
  workerUrl: string;
  onSettlement: (e: SettlementEvent) => void | Promise<void>;
  log: Logger;
  /** The same ceiling on Base, settled and catalogued by Coinbase's facilitator. */
  discovery?: DiscoveryRail;
  /** And on Solana: an escrow deposit, of which only the charge is claimed. */
  solana?: SolanaRail;
  fetchImpl?: typeof fetch;
}

/** What a finished run costs the buyer: what it spent plus the fee, at most the ceiling. */
export function thinkBill(spentUsdc: string): { totalUsdc: string; spentUsdc: string; feeUsdc: string; ceilingUsdc: string } {
  const ceiling = parseUsdc6(THINK_CEILING_USDC);
  const spent = parseUsdc6(spentUsdc);
  const due = addUsdc6(spent, parseUsdc6(THINK_FEE_USDC));
  const total = compareUsdc6(due, ceiling) > 0 ? ceiling : due;
  return { totalUsdc: formatUsdc6(total), spentUsdc: formatUsdc6(spent), feeUsdc: THINK_FEE_USDC, ceilingUsdc: THINK_CEILING_USDC };
}

export function mountUptoRoutes(app: Hono, o: UptoOptions): void {
  const fetchImpl = o.fetchImpl ?? fetch;
  // What the agent may spend: the ceiling less the fee, so what it spends plus the fee always fits under the ceiling.
  const budgetUsdc = formatUsdc6(headroomUsdc6(parseUsdc6(THINK_CEILING_USDC), parseUsdc6(THINK_FEE_USDC)));
  const about = {
    route: "GET /v1/upto/think?task=<your question>",
    scheme: "upto",
    ceilingUsdc: THINK_CEILING_USDC,
    feeUsdc: THINK_FEE_USDC,
    billing: `you sign for up to $${THINK_CEILING_USDC}; you are charged what the agent spent on its thoughts and tools, plus $${THINK_FEE_USDC}, never more than that; nothing when the run could not start`,
    agent: "the thinking agent of cra-agent.tech/think: it buys its thoughts from an LLM paid per call on Arc and its tools from the bazaar, and answers with every payment it made",
    payment: "one signature: a Permit2 authorization for the ceiling, bound to our facilitator, and an EIP-2612 permit for Arc's USDC. No approval transaction, no gas on your side.",
    networks: [
      "Arc, settled by our facilitator",
      ...(o.discovery ? ["Base, settled by Coinbase's facilitator: Permit2 for the ceiling, with an EIP-2612 permit, so no approval transaction there either"] : []),
      ...(o.solana ? ["Solana, settled by Coinbase's facilitator: the ceiling goes into an escrow, the charge is claimed from it and the rest refunded"] : []),
    ],
  };

  const seller = createSeller({
    sellerAddress: o.sellerAddress,
    network: o.network,
    serviceName: "CRA AGENT think",
    settlement: "direct",
    facilitatorUrl: o.facilitatorUrl,
    onSettlement: o.onSettlement,
    ...(o.discovery ? { discovery: o.discovery } : {}),
    ...(o.solana ? { solana: o.solana } : {}),
  });
  seller.route("GET /v1/upto/think", `$${THINK_CEILING_USDC}`, {
    upto: true,
    // The run takes up to three minutes and the settlement comes after it: the buyer's signature must outlast both.
    maxTimeoutSeconds: 300,
    description: `Ask the thinking agent anything. It pays for its own thoughts and tools on Arc; you pay what it spent plus $${THINK_FEE_USDC}, up to $${THINK_CEILING_USDC}.`,
    preview: about,
    inputSchema: { type: "object", properties: { task: { type: "string", description: `What you want answered, 3 to ${TASK_MAX_CHARS} characters.`, example: "What moved EURC against USDC on Arc today?" } }, required: ["task"] },
    inputExample: { task: "What moved EURC against USDC on Arc today?" },
    // The shape of an answer, from a real run (28 Sep 2026), trimmed to one step.
    outputExample: {
      task: "What did Circle announce about Arc this week? Two facts with sources.",
      answer: "1. Circle launched Arc mainnet on September 16, 2026 (Circle press release). 2. Arc uses USDC as its gas token (Cointelegraph).",
      stoppedBecause: "answered",
      charged: { totalUsdc: "0.023265", spentUsdc: "0.018265", feeUsdc: THINK_FEE_USDC, ceilingUsdc: THINK_CEILING_USDC },
      spent: { thinkingUsdc: "0.011265", toolsUsdc: "0.007", totalUsdc: "0.018265", thoughts: 3, purchases: 1 },
      steps: [{ kind: "buy", detail: "web search", costUsdc: "0.007", seller: "Exa", status: 200 }],
    },
  });
  app.use("/v1/upto/*", seller.middleware());

  app.get("/v1/upto", (c) => c.json({ ...about, network: seller.network, payTo: seller.sellerAddress, settledBy: "our facilitator, which lists upto at /facilitator/supported with the address your authorization must name" }));

  app.get("/v1/upto/think", async (c) => {
    // Paid or not, a request is checked before anything runs: a refusal here is never charged.
    const task = (c.req.query("task") ?? "").trim();
    if (task.length < 3 || task.length > TASK_MAX_CHARS) return c.json({ error: `task: between 3 and ${TASK_MAX_CHARS} characters`, charged: false }, 400);
    let res: Response;
    try {
      res = await fetchImpl(`${o.workerUrl}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task, budgetUsdc }), signal: AbortSignal.timeout(WAIT_MS) });
    } catch (err) {
      o.log.warn({ err: (err as Error).message }, "upto think: worker not answering");
      return c.json({ error: "the agent is not answering right now", charged: false }, 503);
    }
    if (res.status === 429) return c.json({ error: "the agent is working on another task: try again in a minute", charged: false }, 503);
    if (!res.ok) {
      const said = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
      return c.json({ error: said ?? `the agent answered ${res.status}`, charged: false }, 503);
    }
    const run = (await res.json()) as ThinkRun;
    // A run that stopped before its first paid call cost nothing, so it is not charged, not even the fee.
    if (run.answer === null && parseUsdc6(run.spent.totalUsdc) === 0n) return c.json({ error: `the agent stopped before spending anything (${run.stoppedBecause})`, charged: false }, 502);
    const bill = thinkBill(run.spent.totalUsdc);
    charge(c, `$${bill.totalUsdc}`);
    return c.json({
      task,
      answer: run.answer,
      stoppedBecause: run.stoppedBecause,
      charged: bill,
      spent: run.spent,
      // Every payment the agent made, with its settlement id: the ledger's own row numbers stay here.
      steps: run.steps.map(({ ledgerId: _ledgerId, ...s }) => s),
    });
  });
  o.log.info({ route: "GET /v1/upto/think", ceilingUsdc: THINK_CEILING_USDC, feeUsdc: THINK_FEE_USDC, worker: o.workerUrl }, "upto routes mounted");
}
