/**
 * @cra-agent/lane: USDC to Arc, from Solana or from Base.
 *
 * Both roads are Eco Routes: a solver burns the USDC through Circle's CCTP V2 with Arc as the destination, and it is
 * minted on Arc seconds later. Eco's quote is checked before anything is signed, down to the burn inside it, and
 * arrival is read on Arc. A seller uses it to bring home what it earned on Solana (`cra-agent-sell sweep`); an agent
 * uses it to fund itself on Arc from where its dollars are (`cra-agent fund`).
 */
export { ARC_CCTP_DOMAIN, ARC_CHAIN_ID, SweepRefused, USDC_ARC, usdcOnArc } from "./common.js";
export { checkEcoQuote, readBurn, readSolanaSigner, solanaLane, CCTP_V2_SOLANA, ECO_PORTAL, SOLANA_CHAIN_ID, USDC_SOLANA, type CheckedQuote, type EcoInstruction, type LaneOptions } from "./solana.js";
export { baseLane, checkEcoQuoteEvm, BASE_CHAIN_ID, CCTP_V2_TOKEN_MESSENGER, ECO_LOCAL_PROVER_BASE, ECO_PORTAL_BASE, PORTAL_ABI, ROUTE_ABI, USDC_BASE, type BaseLaneOptions, type CheckedEvmQuote } from "./base.js";
