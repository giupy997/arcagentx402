-- Per-block aggregates by operation type. Written in both modes; in "light" mode this is what
-- keeps fee-by-operation and failure-rate data without storing transactions and receipts.
CREATE TABLE IF NOT EXISTS block_stats (
  block_number      bigint PRIMARY KEY,
  "timestamp"       bigint NOT NULL,
  tx_count          integer NOT NULL,
  failed            integer NOT NULL,
  native_transfers  integer NOT NULL,
  erc20_transfers   integer NOT NULL,
  contract_calls    integer NOT NULL,
  deploys           integer NOT NULL,
  fee_native        numeric(78,0) NOT NULL,   -- sum of fees (18-dec USDC) per class
  fee_erc20         numeric(78,0) NOT NULL,
  fee_calls         numeric(78,0) NOT NULL,
  fee_deploys       numeric(78,0) NOT NULL,
  fee_total         numeric(78,0) NOT NULL,
  gas_used          bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS block_stats_ts_idx ON block_stats ("timestamp");
INSERT INTO schema_migrations (version) VALUES (3) ON CONFLICT DO NOTHING;
