# @cra-agent/lightning

The x402 `exact` scheme on Bitcoin Lightning (`lnbtc`), as specified in x402's
[scheme_exact_lnbtc.md](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_lnbtc.md).

- `decodeBolt11` decodes invoices strictly and recovers the key that signed them; `encodeBolt11` signs.
- `httpBinding` / `mcpBinding` build the request hash an invoice's description hash must carry (JCS, RFC 8785).
- `issueLnbtcChallenge` asks the seller's node for a fresh invoice bound to the request and checks it.
- `checkLnbtcChallenge` and `payLnbtcChallenge` are the buyer's checks before paying, and the payload after.
- `settleLnbtc` is the facilitator's settlement: the spec's checks in order, its error reasons, the
  paid-but-expired window, and one atomic claim of `network:payment_hash` in a durable `ReplayStore`.
- `usdToMsat` prices a dollar amount in millisatoshis at a stated BTC/USD rate, rounding up.
- `lnbtcPaywall` is a seller's side apart from any web framework. `offer` makes the challenge for a 402, with
  a per-client limit on new invoices. `settle` checks a paid retry against the request that will run. The
  CRA API and `cra-agent-sell --pay-to-lightning` both use it.
- `PgReplayStore` (Postgres) and `FileReplayStore` (one local file, for a seller without a database) keep
  settled proofs past a restart.
- `lnbtcFacilitatorClient(url)` settles through an x402 facilitator that supports `lnbtc`, such as ours at
  `https://api.cra-agent.tech/facilitator`, in place of a local store: pass it to `lnbtcPaywall` as
  `facilitator`.
- `nwcReceiver` / `nwcPayer` reach a node over Nostr Wallet Connect. The receiver refuses a connection that
  could pay. `btcUsdRate` is the median of three exchanges, with no price when they disagree.

Tested against the spec's own vectors: its example invoice decodes and re-encodes byte for byte, its request
hashes match, and its example proof settles to the payment hash it names.
