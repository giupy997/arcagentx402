-- Runs of `cra-agent think --record`: an agent that pays for its own thinking, kept step by step while it
-- runs so cra-agent.tech/think can show it live and replay it after. Every payment in a run is also a row
-- in rail_payments; a step names its ledger row and the settlement id. Written by the CLI, read by the API.

CREATE TABLE IF NOT EXISTS think_runs (
  id            bigserial PRIMARY KEY,
  agent         text NOT NULL,                  -- the wallet that paid for everything in the run
  network       text NOT NULL,                  -- CAIP-2
  task          text NOT NULL,
  model         text NOT NULL,
  brain_url     text NOT NULL,
  brain_name    text,                           -- who sells the brain, as the bazaar lists it
  budget_usdc   numeric(20,6) NOT NULL,
  ceiling_usdc  numeric(20,6) NOT NULL,         -- the most one thought may cost
  policy        jsonb,                          -- the limits every payment in the run was checked against
  status        text NOT NULL DEFAULT 'running', -- running | answered | budget | steps | brain | failed
  phase         jsonb,                          -- while running: the call that is out right now
  phase_at      timestamptz,
  steps         jsonb NOT NULL DEFAULT '[]'::jsonb,
  answer        text,
  spent         jsonb,                          -- {thinkingUsdc, toolsUsdc, totalUsdc, thoughts, purchases}
  error         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX IF NOT EXISTS think_runs_started_idx ON think_runs (started_at DESC);

INSERT INTO schema_migrations (version) VALUES (14) ON CONFLICT DO NOTHING;
