/**
 * @cra-agent/facilitator: a private x402 facilitator.
 *
 * The verification and settlement of the `exact` scheme come from the x402 SDK. What is ours is the
 * service around it: what it agrees to settle (see guard.ts), the three HTTP routes a resource
 * server talks to, and a health route that says how much gas money is left.
 */
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { Hono } from "hono";
import { createPublicClient, createWalletClient, http, publicActions, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { refuse, type GuardRules } from "./guard.js";

export { refuse, type GuardRules, type GuardedRequirements } from "./guard.js";

export interface FacilitatorOptions {
  readonly chain: Chain;
  /** CAIP-2 id of the chain, e.g. eip155:5042. */
  readonly network: string;
  readonly rpcUrl: string;
  /** Key of the account that submits settlements and pays their gas. Keep little in it. */
  readonly privateKey: Hex;
  readonly rules: GuardRules;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}

export function createFacilitator(opts: FacilitatorOptions) {
  const log = opts.log ?? (() => {});
  const account = privateKeyToAccount(opts.privateKey);
  const transport = http(opts.rpcUrl);
  const wallet = createWalletClient({ account, chain: opts.chain, transport }).extend(publicActions);
  const pub = createPublicClient({ chain: opts.chain, transport });
  const signer = toFacilitatorEvmSigner({ ...wallet, address: account.address } as unknown as Parameters<typeof toFacilitatorEvmSigner>[0], { confirmationTimeoutMs: 30_000 });

  const facilitator = new x402Facilitator().register(opts.network as `${string}:${string}`, new ExactEvmScheme(signer));
  const guard = async (ctx: { requirements: PaymentRequirements }) => {
    const reason = refuse(ctx.requirements, opts.rules);
    if (reason) {
      log("refused", { reason, payTo: ctx.requirements.payTo, network: ctx.requirements.network });
      return { abort: true as const, reason };
    }
    return undefined;
  };
  // Both doors: a payment refused at verify must not be settleable by calling settle directly.
  facilitator.onBeforeVerify(guard).onBeforeSettle(guard);
  facilitator.onAfterSettle(async ({ result, requirements }) => log(result.success ? "settled" : "settle_failed", { tx: result.transaction, payer: result.payer, amount: requirements.amount, payTo: requirements.payTo, reason: result.errorReason }));

  const app = new Hono();
  type Body = { paymentPayload?: PaymentPayload; paymentRequirements?: PaymentRequirements };
  const read = async (c: { req: { json(): Promise<unknown> } }): Promise<Body | null> => {
    const b = (await c.req.json().catch(() => null)) as Body | null;
    return b?.paymentPayload && b.paymentRequirements ? b : null;
  };

  app.get("/supported", (c) => c.json(facilitator.getSupported()));
  app.post("/verify", async (c) => {
    const b = await read(c);
    if (!b) return c.json({ isValid: false, invalidReason: "invalid_request" }, 400);
    try {
      return c.json(await facilitator.verify(b.paymentPayload!, b.paymentRequirements!));
    } catch (err) {
      return c.json({ isValid: false, invalidReason: (err as Error).message.slice(0, 200) });
    }
  });
  app.post("/settle", async (c) => {
    const b = await read(c);
    if (!b) return c.json({ success: false, errorReason: "invalid_request", transaction: "", network: opts.network }, 400);
    try {
      return c.json(await facilitator.settle(b.paymentPayload!, b.paymentRequirements!));
    } catch (err) {
      return c.json({ success: false, errorReason: (err as Error).message.slice(0, 200), transaction: "", network: opts.network });
    }
  });
  app.get("/health", async (c) => {
    try {
      // On Arc the gas is USDC, held as the native balance with 18 decimals.
      const balance = await pub.getBalance({ address: account.address });
      return c.json({ ok: balance > 0n, signer: account.address, network: opts.network, gasBalanceWei: balance.toString(), settlesFor: [...opts.rules.payTo] });
    } catch (err) {
      return c.json({ ok: false, signer: account.address, error: (err as Error).message.slice(0, 160) }, 503);
    }
  });

  return { app, facilitator, address: account.address };
}
