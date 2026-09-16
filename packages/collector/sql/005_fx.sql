-- EURC <-> USDC swaps observed on Arc: the executed rate, not a quote.
CREATE TABLE IF NOT EXISTS fx_trades (
  tx_hash       bytea PRIMARY KEY,
  block_number  bigint NOT NULL,
  "timestamp"   bigint NOT NULL,
  side          text NOT NULL,            -- 'EURC->USDC' | 'USDC->EURC'
  trader        bytea NOT NULL,
  venue         bytea,                    -- counterparty that took the other side
  eurc_amount   numeric(78,0) NOT NULL,   -- 6 decimals
  usdc_amount   numeric(78,0) NOT NULL,   -- 6 decimals
  rate          double precision NOT NULL -- USDC per EURC, as executed
);
CREATE INDEX IF NOT EXISTS fx_trades_ts_idx ON fx_trades ("timestamp" DESC);
CREATE INDEX IF NOT EXISTS fx_trades_venue_idx ON fx_trades (venue, "timestamp" DESC);
INSERT INTO schema_migrations (version) VALUES (5) ON CONFLICT DO NOTHING;
