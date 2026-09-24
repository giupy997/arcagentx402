-- Who is behind an address that pays or gets paid on Arc, when something public says so: a catalogue
-- that lists it as the payee of an endpoint, a 402 challenge, the ERC-8004 registry, a facilitator's own
-- /supported. Every row names its source, and a source is replaced whole each time it is read again,
-- so a label is never more than what its source still says. Written by the API.

CREATE TABLE IF NOT EXISTS address_labels (
  address                bytea NOT NULL,
  role                   text NOT NULL,               -- seller: paid by x402 buyers. facilitator: submits payments. agent: an ERC-8004 agent's owner or wallet
  name                   text NOT NULL,
  url                    text,                        -- where it says so: an endpoint, a catalogue, an agent card
  source                 text NOT NULL,               -- ours | market | circle | erc8004 | facilitator
  detail                 text,
  seen_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (address, role, source, name)
);
CREATE INDEX IF NOT EXISTS address_labels_source_idx ON address_labels (source);

INSERT INTO schema_migrations (version) VALUES (13) ON CONFLICT DO NOTHING;
