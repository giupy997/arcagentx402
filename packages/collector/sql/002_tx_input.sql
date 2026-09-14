-- Full calldata as its own column so the tx raw JSON can be stored without it (raw mode "compact").
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS input bytea;
INSERT INTO schema_migrations (version) VALUES (2) ON CONFLICT DO NOTHING;
