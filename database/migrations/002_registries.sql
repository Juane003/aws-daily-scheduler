-- 002: registries — the table from the problem statement plus the precomputed slot (D1).

CREATE TABLE IF NOT EXISTS registries (
  id          BIGINT      PRIMARY KEY,
  provider_id TEXT        NOT NULL,
  endpoint    TEXT        NOT NULL,
  http_method TEXT        NOT NULL DEFAULT 'POST'
              CHECK (http_method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  body        JSONB       NOT NULL,
  -- uint32(sha256(id::text)[0..4]) % 1440, computed by the application (src/common/slot.ts).
  slot        SMALLINT    NOT NULL CHECK (slot BETWEEN 0 AND 1439),
  enabled     BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dispatcher query: WHERE slot = $1 AND enabled AND id > $cursor ORDER BY id LIMIT 1000.
-- (slot, id) lets the keyset pagination walk the index; INCLUDE makes it index-only.
CREATE INDEX IF NOT EXISTS registries_slot_enabled_idx
  ON registries (slot, id) INCLUDE (provider_id)
  WHERE enabled;

CREATE INDEX IF NOT EXISTS registries_provider_idx ON registries (provider_id);
