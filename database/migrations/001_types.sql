-- 001: shared types.
-- Reference implementation: idempotent DDL for Aurora PostgreSQL 16.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'execution_status') THEN
    CREATE TYPE execution_status AS ENUM (
      'ENQUEUED',
      'IN_PROGRESS',
      'RETRYING',
      'SUCCEEDED',
      'FAILED_NON_RETRYABLE',
      'FAILED_EXHAUSTED',
      'FAILED_EXPIRED'
    );
  END IF;
END
$$;
