-- 003: executions and results, partitioned by run_date (one partition per month, D11).
-- PRIMARY KEY (registry_id, run_date) is the UNIQUE(registry_id, run_date) guarantee of D12;
-- it includes the partition key, as PostgreSQL requires for unique constraints on partitioned tables.

CREATE TABLE IF NOT EXISTS executions (
  registry_id      BIGINT           NOT NULL,
  run_date         DATE             NOT NULL,
  provider_id      TEXT             NOT NULL,
  status           execution_status NOT NULL DEFAULT 'ENQUEUED',
  attempt          SMALLINT         NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  seq              SMALLINT         NOT NULL DEFAULT 0 CHECK (seq >= 0),
  enqueued_at      TIMESTAMPTZ      NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  next_attempt_at  TIMESTAMPTZ,
  last_http_status SMALLINT,
  last_error_type  TEXT,
  last_error       TEXT,
  PRIMARY KEY (registry_id, run_date)
) PARTITION BY RANGE (run_date);

CREATE INDEX IF NOT EXISTS executions_run_date_status_idx ON executions (run_date, status);
CREATE INDEX IF NOT EXISTS executions_provider_run_date_idx ON executions (provider_id, run_date);

CREATE TABLE IF NOT EXISTS results (
  registry_id     BIGINT      NOT NULL,
  run_date        DATE        NOT NULL,
  http_status     SMALLINT    NOT NULL,
  duration_ms     INTEGER     NOT NULL CHECK (duration_ms >= 0),
  -- Exactly one of response / response_s3_key: payloads > RESULT_INLINE_MAX_BYTES go to S3.
  response        JSONB,
  response_s3_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (registry_id, run_date),
  CONSTRAINT results_payload_location_chk
    CHECK ((response IS NULL) <> (response_s3_key IS NULL))
) PARTITION BY RANGE (run_date);
