-- Every network a listing's 402 offers, so the market can say who can pay it.
ALTER TABLE market_listings ADD COLUMN IF NOT EXISTS networks text[];
INSERT INTO schema_migrations (version) VALUES (9) ON CONFLICT DO NOTHING;
