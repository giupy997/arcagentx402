-- Lightning proofs our open facilitator settled for any seller (x402 `exact` on `lnbtc`): which node was
-- paid and how much, to count them honestly. The claim that stops a second use is the row in
-- lnbtc_settlements; this table only describes it. No preimage and no payer: Lightning reveals none.

CREATE TABLE IF NOT EXISTS facilitator_lnbtc (
  network      text NOT NULL,
  payment_hash text NOT NULL,
  pay_to       text NOT NULL,                  -- the seller's node key
  amount_msat  bigint NOT NULL,
  settled_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, payment_hash)
);
CREATE INDEX IF NOT EXISTS facilitator_lnbtc_at_idx ON facilitator_lnbtc (settled_at);

INSERT INTO schema_migrations (version) VALUES (16) ON CONFLICT DO NOTHING;
