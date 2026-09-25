-- Lightning proofs already settled (x402 `exact` on `lnbtc`). A preimage is bearer proof of payment and
-- Lightning has no public spent marker, so each `network:payment_hash` may be claimed once, atomically, in a
-- store that survives restarts. A row stays at least an hour past the time its invoice could still settle.

CREATE TABLE IF NOT EXISTS lnbtc_settlements (
  key          text PRIMARY KEY,               -- network + ":" + payment_hash, the spec's consumption key
  keep_until   timestamptz NOT NULL,
  settled_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lnbtc_settlements_keep_idx ON lnbtc_settlements (keep_until);

INSERT INTO schema_migrations (version) VALUES (15) ON CONFLICT DO NOTHING;
