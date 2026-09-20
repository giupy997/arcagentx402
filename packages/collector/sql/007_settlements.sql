-- Every payment our paid routes verified, and how it ended. Written by the API, shown on /status.
CREATE TABLE IF NOT EXISTS settlements (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  -- direct: settled one by one by our facilitator. gateway: batched by Circle. base: the discovery rail.
  rail text NOT NULL,
  network text NOT NULL,
  -- settled | failed | not_charged (valid payment, handler failed, authorization dropped unused)
  outcome text NOT NULL,
  payer text,
  pay_to text NOT NULL,
  amount_usdc6 bigint NOT NULL,
  -- a transaction hash on the direct rail, the facilitator's transfer id on a batched one
  tx text,
  reason text,
  -- path only: a query string is the buyer's business
  route text
);
CREATE INDEX IF NOT EXISTS settlements_at_idx ON settlements (at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS settlements_tx_idx ON settlements (tx) WHERE tx IS NOT NULL;
INSERT INTO schema_migrations (version) VALUES (7) ON CONFLICT DO NOTHING;
