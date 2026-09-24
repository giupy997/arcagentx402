-- Payments made by signed authorization (EIP-3009 transferWithAuthorization / receiveWithAuthorization).
-- This is how x402 settles an "exact" payment on EVM when Circle Gateway is not batching it: the buyer
-- signs, a relayer (usually a facilitator) submits, the token moves the money in one transfer. One row
-- per authorization, with the transfer it moved and who submitted it. Extracted from the receipts the
-- collector reads for every block (light mode included); blocks read before this existed are filled
-- once from the chain. Gateway-batched payments are not here: they settle as one transfer per batch,
-- not one per payment.

CREATE TABLE IF NOT EXISTS direct_payments (
  block_number           bigint NOT NULL,
  log_index              integer NOT NULL,            -- of the AuthorizationUsed log
  tx_hash                bytea NOT NULL,
  "timestamp"            bigint NOT NULL,
  token                  bytea NOT NULL,              -- the EIP-3009 contract: USDC, EURC, any other
  payer                  bytea NOT NULL,              -- the authorizer: whose signature moved the money
  payee                  bytea NOT NULL,
  amount                 numeric(78,0) NOT NULL,      -- token base units (6 decimals for USDC and EURC)
  nonce                  bytea NOT NULL,
  relayer                bytea NOT NULL,              -- tx.from: who submitted it and paid the gas
  called                 bytea,                       -- tx.to: the token itself, or a contract that batches
  PRIMARY KEY (block_number, log_index)
);
CREATE INDEX IF NOT EXISTS direct_payments_payee_idx ON direct_payments (payee, block_number);
CREATE INDEX IF NOT EXISTS direct_payments_payer_idx ON direct_payments (payer, block_number);
CREATE INDEX IF NOT EXISTS direct_payments_relayer_idx ON direct_payments (relayer, block_number);
CREATE INDEX IF NOT EXISTS direct_payments_timestamp_idx ON direct_payments ("timestamp");

INSERT INTO schema_migrations (version) VALUES (12) ON CONFLICT DO NOTHING;
