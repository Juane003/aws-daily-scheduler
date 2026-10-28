-- 005: monthly partition management for executions and results (D11).
-- Retention is enforced with DROP of whole partitions, never with DELETE.
-- Intended to be called by a scheduled job (target design); the reference implementation
-- only ships the functions.

CREATE OR REPLACE FUNCTION ensure_monthly_partitions(parent regclass, from_month DATE, months_ahead INT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  month_start DATE;
  part_name   TEXT;
BEGIN
  FOR i IN 0..months_ahead LOOP
    month_start := (date_trunc('month', from_month) + make_interval(months => i))::date;
    part_name   := format('%s_%s', parent::text, to_char(month_start, 'YYYY_MM'));
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
      part_name, parent, month_start, (month_start + interval '1 month')::date
    );
  END LOOP;
END
$$;

-- Drops partitions whose whole range is older than retention_months before today's month.
CREATE OR REPLACE FUNCTION drop_expired_partitions(parent regclass, retention_months INT)
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff DATE := (date_trunc('month', current_date) - make_interval(months => retention_months))::date;
  part   RECORD;
BEGIN
  FOR part IN
    SELECT c.oid::regclass::text AS name,
           (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \(''([0-9-]+)''\)'))[1]::date AS upper_bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = parent
  LOOP
    IF part.upper_bound IS NOT NULL AND part.upper_bound <= cutoff THEN
      EXECUTE format('DROP TABLE IF EXISTS %s', part.name);
      RETURN NEXT part.name;
    END IF;
  END LOOP;
END
$$;

-- Bootstrap: current month plus the next two.
SELECT ensure_monthly_partitions('executions', current_date, 2);
SELECT ensure_monthly_partitions('results', current_date, 2);
