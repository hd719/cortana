#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
DB_NAME="${DB_NAME:-cortana}"

psql_q() {
  psql "$DB_NAME" -v ON_ERROR_STOP=1 -t -A "$@"
}

feedback_total="$(psql_q -c "SELECT COUNT(*) FROM cortana_feedback;" | tr -d '[:space:]')"
mc_total="$(psql_q -c "SELECT COUNT(*) FROM mc_feedback_items;" | tr -d '[:space:]')"
feedback_tasks_total="$(psql_q -c "SELECT COUNT(*) FROM cortana_tasks WHERE source = 'feedback';" | tr -d '[:space:]')"

# Optional visibility because existing bridge currently writes source='feedback_loop'
feedback_loop_tasks_total="$(psql_q -c "SELECT COUNT(*) FROM cortana_tasks WHERE source = 'feedback_loop';" | tr -d '[:space:]')"

lag_count="$(psql_q -c "
SELECT COUNT(*)
FROM cortana_feedback f
WHERE NOT EXISTS (
  SELECT 1
  FROM mc_feedback_items m
  WHERE COALESCE(m.summary,'') = COALESCE(f.context,'')
    AND ABS(EXTRACT(EPOCH FROM (m.created_at - f.timestamp))) <= 300
);
" | tr -d '[:space:]')"

stuck_count="$(psql_q -c "
SELECT COUNT(*)
FROM mc_feedback_items m
LEFT JOIN LATERAL (
  SELECT f.id, f.applied
  FROM cortana_feedback f
  WHERE COALESCE(f.context,'') = COALESCE(m.summary,'')
    AND ABS(EXTRACT(EPOCH FROM (m.created_at - f.timestamp))) <= 300
  ORDER BY ABS(EXTRACT(EPOCH FROM (m.created_at - f.timestamp))) ASC
  LIMIT 1
) cf ON TRUE
WHERE m.created_at < NOW() - INTERVAL '24 hours'
  AND (
    COALESCE(cf.applied, FALSE) = FALSE
    OR NOT EXISTS (
      SELECT 1
      FROM cortana_tasks t
      WHERE t.metadata->>'feedback_id' = m.id::text
    )
  );
" | tr -d '[:space:]')"

lag_rows="$(psql_q -F $'\t' -c "
SELECT
  f.id::text,
  to_char(f.timestamp AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS feedback_ts_et,
  LEFT(COALESCE(f.context,''), 120) AS context
FROM cortana_feedback f
WHERE NOT EXISTS (
  SELECT 1
  FROM mc_feedback_items m
  WHERE COALESCE(m.summary,'') = COALESCE(f.context,'')
    AND ABS(EXTRACT(EPOCH FROM (m.created_at - f.timestamp))) <= 300
)
ORDER BY f.timestamp ASC
LIMIT 10;
")"

stuck_rows="$(psql_q -F $'\t' -c "
SELECT
  m.id::text,
  to_char(m.created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI:SS') AS created_et,
  COALESCE(m.status, '') AS status,
  COALESCE(m.remediation_status, '') AS remediation_status,
  LEFT(COALESCE(m.summary,''), 100) AS summary,
  COALESCE((
    SELECT MIN(t.id)::text
    FROM cortana_tasks t
    WHERE t.metadata->>'feedback_id' = m.id::text
  ), '') AS linked_task_id
FROM mc_feedback_items m
LEFT JOIN LATERAL (
  SELECT f.id, f.applied
  FROM cortana_feedback f
  WHERE COALESCE(f.context,'') = COALESCE(m.summary,'')
    AND ABS(EXTRACT(EPOCH FROM (m.created_at - f.timestamp))) <= 300
  ORDER BY ABS(EXTRACT(EPOCH FROM (m.created_at - f.timestamp))) ASC
  LIMIT 1
) cf ON TRUE
WHERE m.created_at < NOW() - INTERVAL '24 hours'
  AND (
    COALESCE(cf.applied, FALSE) = FALSE
    OR NOT EXISTS (
      SELECT 1
      FROM cortana_tasks t
      WHERE t.metadata->>'feedback_id' = m.id::text
    )
  )
ORDER BY m.created_at ASC
LIMIT 10;
")"

severity="info"
if [[ "${lag_count:-0}" -gt 0 || "${stuck_count:-0}" -gt 0 ]]; then
  severity="warning"
fi

message="pipeline reconciliation: feedback=${feedback_total}, mc_feedback_items=${mc_total}, tasks_source_feedback=${feedback_tasks_total}, lag=${lag_count}, stuck=${stuck_count}"

psql "$DB_NAME" -v ON_ERROR_STOP=1 -c "
INSERT INTO cortana_events (event_type, source, severity, message, metadata)
VALUES (
  'feedback_pipeline_reconciliation',
  'pipeline-reconciliation.sh',
  '${severity}',
  '${message}',
  jsonb_build_object(
    'feedback_total', ${feedback_total},
    'mc_feedback_items_total', ${mc_total},
    'cortana_tasks_source_feedback_total', ${feedback_tasks_total},
    'cortana_tasks_source_feedback_loop_total', ${feedback_loop_tasks_total},
    'lag_count', ${lag_count},
    'stuck_count', ${stuck_count},
    'generated_at', NOW()
  )
);
" >/dev/null

cat <<EOF
=== Feedback Pipeline Reconciliation ===
Generated: $(date '+%Y-%m-%d %H:%M:%S %Z')

Stage counts:
- cortana_feedback: ${feedback_total}
- mc_feedback_items: ${mc_total}
- cortana_tasks (source='feedback'): ${feedback_tasks_total}
- cortana_tasks (source='feedback_loop'): ${feedback_loop_tasks_total}

Gaps:
- Lag (in cortana_feedback, missing in mc_feedback_items): ${lag_count}
- Stuck >24h (unapplied or no linked task): ${stuck_count}

Lag sample (up to 10):
id	feedback_ts_et	context
${lag_rows:-<none>}

Stuck sample (up to 10):
id	created_et	status	remediation_status	summary	linked_task_id
${stuck_rows:-<none>}

Logged cortana_events event_type='feedback_pipeline_reconciliation' severity='${severity}'.
EOF
