-- Sellers who proved control of their payout wallet and may have payments settled by our facilitator.
CREATE TABLE IF NOT EXISTS facilitator_sellers (
  pay_to text PRIMARY KEY,
  registered_at timestamptz NOT NULL DEFAULT now(),
  issued_at text NOT NULL,
  signature text NOT NULL
);
INSERT INTO schema_migrations (version) VALUES (11) ON CONFLICT DO NOTHING;
