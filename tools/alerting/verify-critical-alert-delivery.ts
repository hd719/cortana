#!/usr/bin/env npx tsx
import db from "../lib/db.js";
const { runPsql, withPostgresPath } = db;

const DB_NAME = process.env.CORTANA_DB ?? "cortana";
const SOURCE = "alert-delivery-verifier";
const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS ?? "24");

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function queryText(sql: string): string {
  const result = runPsql(sql, {
    db: DB_NAME,
    args: ["-q", "-X", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
    env: withPostgresPath(process.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    return "";
  }
  return (result.stdout ?? "").toString().trim();
}

function logGap(
  intentId: string,
  alertType: string,
  targetChannel: string,
  expectedDeliveryTime: string,
  deliveredAt: string
): void {
  const status = deliveredAt ? "late_delivery" : "undelivered";
  const escMsg = sqlEscape(
    `Critical alert intent missing on-time delivery: intent_id=${intentId} alert_type=${alertType} status=${status}`
  );
  const escMeta = sqlEscape(
    JSON.stringify({
      intent_id: intentId,
      alert_type: alertType,
      target_channel: targetChannel,
      expected_delivery_time: expectedDeliveryTime,
      delivered_at: deliveredAt,
      status,
      lookback_hours: LOOKBACK_HOURS,
    })
  );

  runPsql(
    `
    INSERT INTO cortana_events (event_type, source, severity, message, metadata)
    VALUES (
      'critical_alert_delivery_gap',
      '${SOURCE}',
      'warning',
      '${escMsg}',
      '${escMeta}'::jsonb
    );
  `,
    {
      db: DB_NAME,
      args: ["-q", "-X", "-v", "ON_ERROR_STOP=1"],
      env: withPostgresPath(process.env),
      stdio: ["ignore", "ignore", "ignore"],
    }
  );
}

const psqlCheck = runPsql("SELECT 1;", {
  db: DB_NAME,
  args: ["-q", "-X", "-v", "ON_ERROR_STOP=1"],
  env: withPostgresPath(process.env),
});
if (psqlCheck.error || psqlCheck.status !== 0) {
  process.stdout.write('{"ok":false,"error":"psql_not_found"}\n');
  process.exit(1);
}

const report = queryText(`
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
`);

if (!report.trim()) {
  process.stdout.write('{"ok":false,"error":"empty_report"}\n');
  process.exit(1);
}

let hasGaps = false;
try {
  const parsed = JSON.parse(report);
  hasGaps = Boolean(parsed?.hasGaps);
} catch {
  hasGaps = false;
}

if (hasGaps) {
  const rows = queryText(`
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
    `);

  for (const line of rows.split("\n")) {
    if (!line.trim()) continue;
    const [intentId, alertType, targetChannel, expectedDeliveryTime, deliveredAt = ""] =
      line.split("|");
    if (!intentId) continue;
    logGap(intentId, alertType ?? "", targetChannel ?? "", expectedDeliveryTime ?? "", deliveredAt);
  }
}

process.stdout.write(`${report}\n`);
