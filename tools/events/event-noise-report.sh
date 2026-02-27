#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

DB="${DB:-cortana}"
HOURS="${1:-24}"
MIN_SEVERITY="${2:-warning}"

if ! [[ "$HOURS" =~ ^[0-9]+$ ]]; then
  echo "Usage: $0 [hours] [min_severity: info|warning|error|critical]" >&2
  exit 1
fi

case "$MIN_SEVERITY" in
  info) MIN_RANK=1 ;;
  warning) MIN_RANK=2 ;;
  error) MIN_RANK=3 ;;
  critical) MIN_RANK=4 ;;
  *)
    echo "Invalid min_severity: $MIN_SEVERITY" >&2
    echo "Use one of: info warning error critical" >&2
    exit 1
    ;;
esac

echo "== Noise pattern (last ${HOURS}h) =="
psql "$DB" -P pager=off -c "
  SELECT event_type, source, lower(COALESCE(severity,'info')) AS severity, COUNT(*) AS n
  FROM cortana_events
  WHERE timestamp >= NOW() - INTERVAL '${HOURS} hours'
  GROUP BY event_type, source, lower(COALESCE(severity,'info'))
  ORDER BY n DESC
  LIMIT 20;
"

echo
echo "== Severity-filtered rollup (>=${MIN_SEVERITY}) by hour/signature =="
psql "$DB" -P pager=off -c "
  WITH filtered AS (
    SELECT
      *,
      CASE lower(COALESCE(severity,'info'))
        WHEN 'critical' THEN 4
        WHEN 'error' THEN 3
        WHEN 'warning' THEN 2
        ELSE 1
      END AS severity_rank
    FROM cortana_events
    WHERE timestamp >= NOW() - INTERVAL '${HOURS} hours'
  ),
  grouped AS (
    SELECT
      date_trunc('hour', timestamp) AS hour_bucket,
      source,
      event_type,
      lower(COALESCE(severity,'info')) AS severity,
      message,
      COUNT(*) AS occurrences,
      MIN(timestamp) AS first_seen,
      MAX(timestamp) AS last_seen,
      MAX(severity_rank) AS severity_rank
    FROM filtered
    WHERE severity_rank >= ${MIN_RANK}
    GROUP BY 1,2,3,4,5
  )
  SELECT hour_bucket, severity, source, event_type, occurrences, message, first_seen, last_seen
  FROM grouped
  ORDER BY hour_bucket DESC, occurrences DESC, severity_rank DESC
  LIMIT 60;
"

echo
echo "== Info-noise rollup (15m identical entries, count > 1) =="
psql "$DB" -P pager=off -c "
  SELECT bucket_15m, source, event_type, occurrences, message, first_seen, last_seen
  FROM cortana_info_event_rollup_15m
  WHERE bucket_15m >= NOW() - INTERVAL '${HOURS} hours'
  ORDER BY bucket_15m DESC, occurrences DESC
  LIMIT 60;
"

echo
echo "== Subagent failure aggregation (per hour) =="
psql "$DB" -P pager=off -c "
  SELECT
    date_trunc('hour', timestamp) AS hour_bucket,
    COUNT(*) AS subagent_failures,
    MIN(timestamp) AS first_seen,
    MAX(timestamp) AS last_seen,
    CONCAT(COUNT(*), ' subagent failures in 1h') AS summary
  FROM cortana_events
  WHERE event_type = 'subagent_failure'
    AND lower(COALESCE(severity,'info')) IN ('warning','error','critical')
    AND timestamp >= NOW() - INTERVAL '${HOURS} hours'
  GROUP BY 1
  HAVING COUNT(*) > 0
  ORDER BY hour_bucket DESC;
"
