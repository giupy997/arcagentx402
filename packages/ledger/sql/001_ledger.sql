-- Every payment attempt by the rail, whatever the outcome. This is the proprietary dataset:
-- real prices, latencies and failure rates per endpoint. Schema meant to last.
CREATE TABLE IF NOT EXISTS rail_payments (
  id               bigserial PRIMARY KEY,
  at               timestamptz NOT NULL DEFAULT now(),
  agent_id         text NOT NULL,
  rail             text NOT NULL,                 -- 'nanopayment' | 'escrow'
  url              text NOT NULL,
  host             text NOT NULL,
  method           text NOT NULL DEFAULT 'GET',
  network          text NOT NULL,                 -- CAIP-2
  scheme           text NOT NULL,                 -- x402 scheme
  asset            text NOT NULL,                 -- token address
  pay_to           text NOT NULL,                 -- counterparty (lowercase)
  amount_usdc6     numeric(78,0) NOT NULL,
  status           text NOT NULL,                 -- quoted | rejected | signed | settled | failed
  reason           text,                          -- policy rule / error
  http_status      integer,
  latency_ms       integer,
  tx_hash          text,
  payer            text,
  settled_at       timestamptz,
  meta             jsonb
);
CREATE INDEX IF NOT EXISTS rail_payments_agent_at_idx ON rail_payments (agent_id, at DESC);
CREATE INDEX IF NOT EXISTS rail_payments_payto_at_idx ON rail_payments (pay_to, at DESC);
CREATE INDEX IF NOT EXISTS rail_payments_host_idx ON rail_payments (host, at DESC);
-- open exposure = signed but neither settled nor failed
CREATE INDEX IF NOT EXISTS rail_payments_open_idx ON rail_payments (pay_to) WHERE status = 'signed';

CREATE TABLE IF NOT EXISTS rail_schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO rail_schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING;
