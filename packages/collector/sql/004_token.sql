-- Token events for the public tokenomics page: buyback burns and USDC payouts, read straight from chain.
CREATE TABLE IF NOT EXISTS token_events (
  block_number bigint NOT NULL,
  log_index    integer NOT NULL,
  tx_hash      bytea NOT NULL,
  "timestamp"  bigint NOT NULL,
  kind         text NOT NULL,            -- 'burn' (CRA to the dead address) | 'payout' (USDC out of the distributor)
  "from"       bytea NOT NULL,
  "to"         bytea NOT NULL,
  amount       numeric(78,0) NOT NULL,   -- raw units: 18 decimals for CRA, 6 for USDC
  PRIMARY KEY (block_number, log_index)
);
CREATE INDEX IF NOT EXISTS token_events_kind_ts_idx ON token_events (kind, "timestamp" DESC);
CREATE INDEX IF NOT EXISTS token_events_ts_idx ON token_events ("timestamp" DESC);
INSERT INTO schema_migrations (version) VALUES (4) ON CONFLICT DO NOTHING;
