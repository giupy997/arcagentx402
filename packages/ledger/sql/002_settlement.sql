-- Where the batched settlement landed on chain, once it does.
ALTER TABLE rail_payments ADD COLUMN IF NOT EXISTS settlement_tx text;
ALTER TABLE rail_payments ADD COLUMN IF NOT EXISTS settled_onchain_at timestamptz;
CREATE INDEX IF NOT EXISTS rail_payments_awaiting_proof_idx ON rail_payments (pay_to, at) WHERE status = 'settled' AND settlement_tx IS NULL;
INSERT INTO rail_schema_migrations (version) VALUES (2) ON CONFLICT DO NOTHING;
