-- What a seller on the market says about itself for catalogues: a category and tags, from its 402's
-- resource (the x402 Bazaar's service metadata) and its /.well-known/x402.

ALTER TABLE market_listings ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE market_listings ADD COLUMN IF NOT EXISTS tags text[];

INSERT INTO schema_migrations (version) VALUES (17) ON CONFLICT DO NOTHING;
