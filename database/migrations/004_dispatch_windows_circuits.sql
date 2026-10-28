-- 004: dispatcher bookkeeping (D3) and per-provider circuit breaker state (D8).

CREATE TABLE IF NOT EXISTS dispatch_windows (
  run_date        DATE        NOT NULL,
  slot            SMALLINT    NOT NULL CHECK (slot BETWEEN 0 AND 1439),
  status          TEXT        NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETED')),
  jobs_dispatched INTEGER     NOT NULL DEFAULT 0 CHECK (jobs_dispatched >= 0),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  PRIMARY KEY (run_date, slot)
);

-- Alarm query: windows stuck in PROCESSING for more than 10 minutes.
CREATE INDEX IF NOT EXISTS dispatch_windows_processing_idx
  ON dispatch_windows (started_at)
  WHERE status = 'PROCESSING';

CREATE TABLE IF NOT EXISTS provider_circuits (
  provider_id          TEXT        PRIMARY KEY,
  state                TEXT        NOT NULL DEFAULT 'CLOSED'
                       CHECK (state IN ('CLOSED', 'OPEN', 'HALF_OPEN')),
  consecutive_failures INTEGER     NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  cooldown_seconds     INTEGER     NOT NULL DEFAULT 60 CHECK (cooldown_seconds > 0),
  open_until           TIMESTAMPTZ,
  half_open_owner      TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT provider_circuits_open_until_chk
    CHECK (state <> 'OPEN' OR open_until IS NOT NULL),
  CONSTRAINT provider_circuits_owner_chk
    CHECK (state = 'HALF_OPEN' OR half_open_owner IS NULL)
);
