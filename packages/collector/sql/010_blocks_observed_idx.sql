-- The finality figure reads the last hour of blocks by when we saw them; without this it scanned them all.
CREATE INDEX IF NOT EXISTS blocks_observed_at_idx ON blocks (observed_at) WHERE observed_at IS NOT NULL;
ANALYZE blocks;
INSERT INTO schema_migrations (version) VALUES (10) ON CONFLICT DO NOTHING;
