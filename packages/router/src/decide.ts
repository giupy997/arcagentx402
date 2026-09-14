/**
 * Rail choice as a pure function (brief §6): testable on its own, separate from execution.
 */
import { compareUsdc6, parseUsdc6, type Usdc6 } from "@cra-agent/accounting";

export type RailChoice = "nanopayment" | "escrow";

export interface RouteInput {
  readonly amount: Usdc6;
  /** "call": pay-per-request resource. "job": deliverable produced over time (ERC-8183 shape). */
  readonly kind: "call" | "job";
  /** The seller offers Gateway batched settlement (x402 extra.name === "GatewayWalletBatched"). */
  readonly supportsBatching: boolean;
  /** Seconds the seller allows for payment completion. */
  readonly maxTimeoutSeconds: number;
}

export interface RouteThresholds {
  /** Above this amount a single call goes to escrow instead of a nanopayment. */
  readonly escrowAbove: Usdc6;
}

export const DEFAULT_THRESHOLDS: RouteThresholds = { escrowAbove: parseUsdc6("5") };

export interface RouteDecision {
  readonly rail: RailChoice;
  readonly reason: string;
}

export function chooseRail(input: RouteInput, t: RouteThresholds = DEFAULT_THRESHOLDS): RouteDecision {
  if (input.kind === "job") return { rail: "escrow", reason: "job with a deliverable: ERC-8183 escrow with evaluator" };
  if (compareUsdc6(input.amount, t.escrowAbove) > 0) return { rail: "escrow", reason: `amount above nanopayment threshold ${t.escrowAbove}` };
  if (input.supportsBatching) return { rail: "nanopayment", reason: "pay-per-call, seller supports Gateway batched settlement" };
  return { rail: "nanopayment", reason: "pay-per-call, on-chain exact settlement (seller does not batch)" };
}
