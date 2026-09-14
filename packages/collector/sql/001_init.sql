-- arc-rail collector schema v1. Append-only, raw JSON-RPC preserved next to parsed columns.
-- Amount columns are numeric(78,0) (uint256 fits). Hashes/addresses are bytea.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     integer PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per block. `raw` is the eth_getBlockByNumber header WITHOUT the transactions array
-- (transactions have their own raw). observed_at is only set when the block was seen live at
-- the head (null for backfilled blocks), so finality latency can be derived from live rows.
CREATE TABLE IF NOT EXISTS blocks (
  number                 bigint PRIMARY KEY,
  hash                   bytea NOT NULL UNIQUE,
  parent_hash            bytea NOT NULL,
  "timestamp"            bigint NOT NULL,
  miner                  bytea NOT NULL,
  gas_limit              bigint NOT NULL,
  gas_used               bigint NOT NULL,
  gas_used_ratio         double precision NOT NULL,
  base_fee_per_gas       numeric(78,0) NOT NULL,
  -- Arc puts the NEXT block's base fee in extraData (8-byte big-endian). Null if absent/malformed.
  next_base_fee_per_gas  numeric(78,0),
  extra_data             bytea NOT NULL,
  tx_count               integer NOT NULL,
  size_bytes             integer,
  state_root             bytea NOT NULL,
  receipts_root          bytea NOT NULL,
  transactions_root      bytea NOT NULL,
  raw                    jsonb NOT NULL,
  observed_at            timestamptz,
  observed_via           text,
  source_rpc             text NOT NULL,
  fetch_ms               integer,
  inserted_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS blocks_timestamp_idx ON blocks ("timestamp");
CREATE INDEX IF NOT EXISTS blocks_miner_idx ON blocks (miner);

CREATE TABLE IF NOT EXISTS transactions (
  block_number           bigint NOT NULL,
  tx_index               integer NOT NULL,
  hash                   bytea NOT NULL UNIQUE,
  "from"                 bytea NOT NULL,
  "to"                   bytea,                       -- null = contract creation
  value                  numeric(78,0) NOT NULL,      -- 18-decimal USDC units
  nonce                  bigint NOT NULL,
  gas                    bigint NOT NULL,
  gas_price              numeric(78,0),
  max_fee_per_gas        numeric(78,0),
  max_priority_fee_per_gas numeric(78,0),
  tx_type                smallint NOT NULL,
  chain_id               bigint,
  input_selector         bytea,                       -- first 4 bytes of calldata, null if empty
  input_size             integer NOT NULL,
  raw                    jsonb NOT NULL,
  PRIMARY KEY (block_number, tx_index)
);
CREATE INDEX IF NOT EXISTS transactions_from_idx ON transactions ("from");
CREATE INDEX IF NOT EXISTS transactions_to_idx ON transactions ("to");
CREATE INDEX IF NOT EXISTS transactions_selector_idx ON transactions (input_selector);

CREATE TABLE IF NOT EXISTS receipts (
  tx_hash                bytea PRIMARY KEY,
  block_number           bigint NOT NULL,
  tx_index               integer NOT NULL,
  status                 smallint NOT NULL,           -- 1 success, 0 reverted
  gas_used               bigint NOT NULL,
  cumulative_gas_used    bigint NOT NULL,
  effective_gas_price    numeric(78,0) NOT NULL,
  fee_usdc18             numeric(78,0) NOT NULL,      -- gas_used * effective_gas_price (accounting module)
  contract_address       bytea,
  logs_count             integer NOT NULL,
  raw                    jsonb NOT NULL,
  UNIQUE (block_number, tx_index)
);
CREATE INDEX IF NOT EXISTS receipts_failed_idx ON receipts (block_number) WHERE status = 0;

-- Logs are fully described by their columns; the receipt `raw` also carries them verbatim.
CREATE TABLE IF NOT EXISTS logs (
  block_number           bigint NOT NULL,
  log_index              integer NOT NULL,
  tx_index               integer NOT NULL,
  tx_hash                bytea NOT NULL,
  address                bytea NOT NULL,
  topic0                 bytea,
  topic1                 bytea,
  topic2                 bytea,
  topic3                 bytea,
  data                   bytea NOT NULL,
  PRIMARY KEY (block_number, log_index)
);
CREATE INDEX IF NOT EXISTS logs_address_topic0_idx ON logs (address, topic0, block_number);
CREATE INDEX IF NOT EXISTS logs_topic0_idx ON logs (topic0, block_number);

-- Top-level contract creations (receipt.contractAddress). Internal CREATE/CREATE2 from factories
-- are NOT visible without traces (debug_/trace_ are not exposed by Arc public RPCs as of
-- 2026-09-14); those can be reconstructed later from factory events using the raw logs.
CREATE TABLE IF NOT EXISTS contract_deploys (
  address                bytea PRIMARY KEY,
  deployer               bytea NOT NULL,
  tx_hash                bytea NOT NULL,
  block_number           bigint NOT NULL,
  tx_index               integer NOT NULL,
  block_timestamp        bigint NOT NULL,
  init_code_size         integer NOT NULL,
  init_code_hash         bytea NOT NULL,              -- keccak256(calldata) for later matching
  runtime_code_size      integer,                      -- filled by enrichment (eth_getCode)
  runtime_code_hash      bytea,
  success                boolean NOT NULL,
  inserted_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contract_deploys_block_idx ON contract_deploys (block_number);
CREATE INDEX IF NOT EXISTS contract_deploys_deployer_idx ON contract_deploys (deployer);

-- Best-effort revert reasons: eth_call replay of the failed tx against the parent block state.
CREATE TABLE IF NOT EXISTS tx_reverts (
  tx_hash                bytea PRIMARY KEY,
  block_number           bigint NOT NULL,
  replay_status          text NOT NULL,               -- 'reverted' | 'succeeded_on_replay' | 'rpc_error' | 'pending'
  revert_data            bytea,
  reason_kind            text,                        -- 'error_string' | 'panic' | 'custom' | 'empty'
  reason                 text,
  rpc_error              text,
  replayed_at            timestamptz,
  attempts               integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tx_reverts_pending_idx ON tx_reverts (block_number) WHERE replay_status = 'pending';

-- Every head poll, per endpoint. This is the finality-latency and RPC-lag dataset.
CREATE TABLE IF NOT EXISTS head_observations (
  observed_at            timestamptz NOT NULL,
  endpoint               text NOT NULL,
  latest                 bigint,
  finalized              bigint,
  safe                   bigint,
  latest_timestamp       bigint,                      -- block.timestamp of `latest`, for latency
  rtt_ms                 integer NOT NULL,
  error                  text
);
CREATE INDEX IF NOT EXISTS head_observations_time_idx ON head_observations (observed_at);

-- RPC failures (rate limits, timeouts, 5xx). Launch-day RPC behaviour is itself a dataset.
CREATE TABLE IF NOT EXISTS rpc_errors (
  at                     timestamptz NOT NULL DEFAULT now(),
  endpoint               text NOT NULL,
  method                 text NOT NULL,
  code                   integer,
  message                text NOT NULL,
  duration_ms            integer,
  block_number           bigint
);
CREATE INDEX IF NOT EXISTS rpc_errors_at_idx ON rpc_errors (at);

-- Addresses we know how to label. Editable at runtime; seeds come from docs.arc.io.
CREATE TABLE IF NOT EXISTS known_contracts (
  network                text NOT NULL,
  address                bytea NOT NULL,
  label                  text NOT NULL,
  protocol               text NOT NULL,
  source                 text NOT NULL,
  added_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, address)
);

-- Small key/value state (cursors, run metadata).
CREATE TABLE IF NOT EXISTS collector_state (
  key                    text PRIMARY KEY,
  value                  jsonb NOT NULL,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Ranges known to be missing, found by the gap scanner. Cleared by the backfill worker.
CREATE TABLE IF NOT EXISTS block_gaps (
  from_block             bigint PRIMARY KEY,
  to_block               bigint NOT NULL,
  found_at               timestamptz NOT NULL DEFAULT now(),
  attempts               integer NOT NULL DEFAULT 0,
  last_error             text
);

INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING;
