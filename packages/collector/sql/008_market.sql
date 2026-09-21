-- Paid endpoints on Arc that anyone may add to the public marketplace. Nothing here is taken on the
-- submitter's word: every column below comes from probing the URL and reading its 402.
CREATE TABLE IF NOT EXISTS market_listings (
  id bigserial PRIMARY KEY,
  url text NOT NULL UNIQUE,
  host text NOT NULL,
  name text,
  description text,
  pay_to text NOT NULL,
  network text NOT NULL,
  amount_usdc6 bigint NOT NULL,
  -- gateway: batched through Circle Gateway. direct: a plain authorization some facilitator settles.
  rail text NOT NULL,
  -- what the seller's own /.well-known/x402 lists, when it has one
  routes jsonb,
  added_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz NOT NULL DEFAULT now(),
  ok boolean NOT NULL DEFAULT true,
  fails integer NOT NULL DEFAULT 0,
  -- set by hand to take a listing off the page
  hidden boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS market_listings_host_idx ON market_listings (host);
INSERT INTO schema_migrations (version) VALUES (8) ON CONFLICT DO NOTHING;
