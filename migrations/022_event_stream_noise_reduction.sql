-- 022_event_stream_noise_reduction.sql
-- Task 276: Event stream noise reduction + actionable event views

-- Actionable events view: warnings/errors/critical only (hide info noise by default)
CREATE OR REPLACE VIEW cortana_actionable_events AS
SELECT
  id,
  timestamp,
  event_type,
  source,
  lower(COALESCE(severity, 'info')) AS severity,
  CASE lower(COALESCE(severity, 'info'))
    WHEN 'critical' THEN 4
    WHEN 'error' THEN 3
    WHEN 'warning' THEN 2
    ELSE 1
  END AS severity_rank,
  message,
  metadata
FROM cortana_events
WHERE lower(COALESCE(severity, 'info')) IN ('warning', 'error', 'critical')
ORDER BY timestamp DESC;

-- 15-minute rollup for repeated info events (same source/type/message)
CREATE OR REPLACE VIEW cortana_info_event_rollup_15m AS
SELECT
  date_trunc('hour', "timestamp")
    + floor(extract(minute FROM "timestamp") / 15) * interval '15 minutes' AS bucket_15m,
  source,
  event_type,
  lower(COALESCE(severity, 'info')) AS severity,
  message,
  count(*) AS occurrences,
  min("timestamp") AS first_seen,
  max("timestamp") AS last_seen
FROM cortana_events
WHERE lower(COALESCE(severity, 'info')) = 'info'
GROUP BY 1, 2, 3, 4, 5
HAVING count(*) > 1
ORDER BY bucket_15m DESC, occurrences DESC;
