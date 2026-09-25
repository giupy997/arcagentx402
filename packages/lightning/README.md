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

Tested against the spec's own vectors: its example invoice decodes and re-encodes byte for byte, its request
hashes match, and its example proof settles to the payment hash it names.
