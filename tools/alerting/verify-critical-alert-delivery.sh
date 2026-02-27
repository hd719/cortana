#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
PSQL_BIN="/opt/homebrew/opt/postgresql@17/bin/psql"
DB_NAME="${CORTANA_DB:-cortana}"
SOURCE="alert-delivery-verifier"
LOOKBACK_HOURS="${LOOKBACK_HOURS:-24}"

query_json() {
  "$PSQL_BIN" "$DB_NAME" -q -X -t -A -v ON_ERROR_STOP=1 -c "$1"
}

sql_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

log_gap() {
  local intent_id="$1"
  local alert_type="$2"
  local target_channel="$3"
  local expected_delivery_time="$4"
  local delivered_at="$5"

  local status="undelivered"
  if [[ -n "$delivered_at" ]]; then
    status="late_delivery"
  fi

  local esc_msg esc_meta
  esc_msg="$(sql_escape "Critical alert intent missing on-time delivery: intent_id=${intent_id} alert_type=${alert_type} status=${status}")"
  esc_meta="$(sql_escape "{\"intent_id\":\"${intent_id}\",\"alert_type\":\"${alert_type}\",\"target_channel\":\"${target_channel}\",\"expected_delivery_time\":\"${expected_delivery_time}\",\"delivered_at\":\"${delivered_at}\",\"status\":\"${status}\",\"lookback_hours\":${LOOKBACK_HOURS}}")"

  "$PSQL_BIN" "$DB_NAME" -q -X -v ON_ERROR_STOP=1 -c "
    INSERT INTO cortana_events (event_type, source, severity, message, metadata)
    VALUES (
      'critical_alert_delivery_gap',
      '${SOURCE}',
      'warning',
      '${esc_msg}',
      '${esc_meta}'::jsonb
    );
  " >/dev/null 2>&1 || true
}

if [[ ! -x "$PSQL_BIN" ]]; then
  echo '{"ok":false,"error":"psql_not_found"}'
  exit 1
fi

REPORT="$(query_json "
WITH windows AS (
  SELECT NOW() - (INTERVAL '1 hour' * ${LOOKBACK_HOURS}) AS since_ts,
         NOW() AS now_ts
),
intents AS (
  SELECT
    e.id,
    e.timestamp AS intent_logged_at,
    COALESCE(e.metadata->>'intent_id','') AS intent_id,
    COALESCE(e.metadata->>'alert_type','generic') AS alert_type,
    COALESCE(e.metadata->>'target_channel','unknown') AS target_channel,
    NULLIF(e.metadata->>'expected_delivery_time','')::timestamptz AS expected_delivery_time
  FROM cortana_events e, windows w
  WHERE e.event_type='alert_intent'
    AND e.timestamp >= w.since_ts
),
valid_intents AS (
  SELECT *
  FROM intents
  WHERE intent_id <> ''
    AND expected_delivery_time IS NOT NULL
),
confirmations AS (
  SELECT
    COALESCE(e.metadata->>'intent_id','') AS intent_id,
    MIN(e.timestamp) FILTER (WHERE COALESCE(e.metadata->>'status','')='delivered') AS delivered_at
  FROM cortana_events e, windows w
  WHERE e.timestamp >= w.since_ts
    AND e.event_type='alert_delivery'
    AND e.source='telegram-delivery-guard'
    AND COALESCE(e.metadata->>'intent_id','') <> ''
  GROUP BY 1
),
joined AS (
  SELECT
    i.intent_id,
    i.alert_type,
    i.target_channel,
    i.intent_logged_at,
    i.expected_delivery_time,
    c.delivered_at,
    CASE
      WHEN c.delivered_at IS NULL THEN 'undelivered'
      WHEN c.delivered_at > i.expected_delivery_time THEN 'late_delivery'
      ELSE 'delivered_on_time'
    END AS verification_status
  FROM valid_intents i
  LEFT JOIN confirmations c USING (intent_id)
),
due_intents AS (
  SELECT j.*
  FROM joined j, windows w
  WHERE j.expected_delivery_time <= w.now_ts
),
summary_by_type AS (
  SELECT
    alert_type,
    COUNT(*)::int AS due_count,
    COUNT(*) FILTER (WHERE verification_status = 'delivered_on_time')::int AS delivered_on_time_count,
    COUNT(*) FILTER (WHERE verification_status <> 'delivered_on_time')::int AS missing_or_late_count
  FROM due_intents
  GROUP BY alert_type
)
SELECT json_build_object(
  'ok', true,
  'lookbackHours', ${LOOKBACK_HOURS},
  'generatedAt', NOW(),
  'summaryByType', COALESCE((SELECT json_agg(row_to_json(s)) FROM summary_by_type s), '[]'::json),
  'undeliveredIntents', COALESCE((
    SELECT json_agg(row_to_json(x))
    FROM (
      SELECT intent_id, alert_type, target_channel, expected_delivery_time, delivered_at, verification_status
      FROM due_intents
      WHERE verification_status <> 'delivered_on_time'
      ORDER BY expected_delivery_time ASC
    ) x
  ), '[]'::json),
  'hasGaps', EXISTS(SELECT 1 FROM due_intents WHERE verification_status <> 'delivered_on_time')
)::text;
")"

if [[ -z "${REPORT// }" ]]; then
  echo '{"ok":false,"error":"empty_report"}'
  exit 1
fi

HAS_GAPS="$(echo "$REPORT" | /usr/bin/python3 -c 'import json,sys; d=json.load(sys.stdin); print("true" if d.get("hasGaps") else "false")')"
if [[ "$HAS_GAPS" == "true" ]]; then
  while IFS='|' read -r intent_id alert_type target_channel expected_delivery_time delivered_at; do
    [[ -z "$intent_id" ]] && continue
    log_gap "$intent_id" "$alert_type" "$target_channel" "$expected_delivery_time" "$delivered_at"
  done < <(
    query_json "
    WITH windows AS (
      SELECT NOW() - (INTERVAL '1 hour' * ${LOOKBACK_HOURS}) AS since_ts,
             NOW() AS now_ts
    ),
    intents AS (
      SELECT
        COALESCE(e.metadata->>'intent_id','') AS intent_id,
        COALESCE(e.metadata->>'alert_type','generic') AS alert_type,
        COALESCE(e.metadata->>'target_channel','unknown') AS target_channel,
        NULLIF(e.metadata->>'expected_delivery_time','')::timestamptz AS expected_delivery_time
      FROM cortana_events e, windows w
      WHERE e.event_type='alert_intent'
        AND e.timestamp >= w.since_ts
    ),
    valid_intents AS (
      SELECT *
      FROM intents
      WHERE intent_id <> '' AND expected_delivery_time IS NOT NULL
    ),
    confirmations AS (
      SELECT
        COALESCE(e.metadata->>'intent_id','') AS intent_id,
        MIN(e.timestamp) FILTER (WHERE COALESCE(e.metadata->>'status','')='delivered') AS delivered_at
      FROM cortana_events e, windows w
      WHERE e.timestamp >= w.since_ts
        AND e.event_type='alert_delivery'
        AND e.source='telegram-delivery-guard'
        AND COALESCE(e.metadata->>'intent_id','') <> ''
      GROUP BY 1
    )
    SELECT
      i.intent_id || '|' ||
      i.alert_type || '|' ||
      i.target_channel || '|' ||
      i.expected_delivery_time::text || '|' ||
      COALESCE(c.delivered_at::text,'')
    FROM valid_intents i
    LEFT JOIN confirmations c USING (intent_id), windows w
    WHERE i.expected_delivery_time <= w.now_ts
      AND (c.delivered_at IS NULL OR c.delivered_at > i.expected_delivery_time)
    ORDER BY i.expected_delivery_time ASC;
    "
  )
fi

echo "$REPORT"
