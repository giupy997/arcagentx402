-- Generalise fx_trades into executed prices for any token quoted in USDC.
ALTER TABLE fx_trades ADD COLUMN IF NOT EXISTS base bytea;
ALTER TABLE fx_trades ADD COLUMN IF NOT EXISTS base_symbol text;
UPDATE fx_trades SET base = '\xbef5f6d51cb62b58e6a8f77868681825c6fe21c1'::bytea, base_symbol = 'EURC' WHERE base IS NULL;
ALTER TABLE fx_trades ALTER COLUMN base SET NOT NULL;
ALTER TABLE fx_trades ALTER COLUMN base_symbol SET NOT NULL;
-- side used to be EURC->USDC; store it as a direction instead, so it reads the same for any pair
ALTER TABLE fx_trades ADD COLUMN IF NOT EXISTS direction text;
UPDATE fx_trades SET direction = CASE WHEN side LIKE 'EURC->%' THEN 'sell' ELSE 'buy' END WHERE direction IS NULL;
ALTER TABLE fx_trades ALTER COLUMN direction SET NOT NULL;
CREATE INDEX IF NOT EXISTS fx_trades_base_ts_idx ON fx_trades (base_symbol, "timestamp" DESC);
INSERT INTO schema_migrations (version) VALUES (6) ON CONFLICT DO NOTHING;
