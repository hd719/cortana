#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
PSQL_BIN="/opt/homebrew/opt/postgresql@17/bin/psql"
DB_NAME="${CORTANA_DB:-cortana}"
SOURCE="task-board-completion-sync"
# shellcheck disable=SC1091
source "/Users/hd/openclaw/tools/lib/idempotency.sh"
EMIT_RUN_EVENT_SCRIPT="/Users/hd/openclaw/tools/task-board/emit-run-event.sh"

trap 'rollback_transaction' ERR

if [[ -f "$EMIT_RUN_EVENT_SCRIPT" ]]; then
  # shellcheck disable=SC1090
  source "$EMIT_RUN_EVENT_SCRIPT"
fi

if [[ ! -x "$PSQL_BIN" ]]; then
  echo '{"ok":false,"error":"psql_not_found"}'
  exit 1
fi

if ! command -v openclaw >/dev/null 2>&1; then
  echo '{"ok":false,"error":"openclaw_not_found"}'
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo '{"ok":false,"error":"jq_not_found"}'
  exit 1
fi

OPERATION_ID="$(generate_operation_id)"
OPERATION_TYPE="completion_sync_pass"
if check_idempotency "$OPERATION_ID"; then
  log_idempotency "$OPERATION_ID" "$OPERATION_TYPE" "skipped" '{"reason":"already_completed"}'
  jq -n '{ok:true, skipped:true, reason:"idempotent_operation_already_completed"}'
  exit 0
fi
log_idempotency "$OPERATION_ID" "$OPERATION_TYPE" "started" '{}'

SESSIONS_JSON="$(openclaw sessions --json --active 1440 --all-agents 2>/dev/null || echo '{"sessions":[]}')"

updates='[]'
while IFS= read -r row; do
  [[ -z "$row" ]] && continue

  key="$(echo "$row" | jq -r '.key // ""')"
  label="$(echo "$row" | jq -r '.label // ""')"
  run_id="$(echo "$row" | jq -r '.run_id // .runId // .sessionId // empty')"
  status="$(echo "$row" | jq -r 'if ((.status // .lastStatus // "") == "") then "unknown" else (.status // .lastStatus) end')"
  status_lc="$(echo "$status" | tr '[:upper:]' '[:lower:]')"

  # terminal outcome classification (task status + lifecycle event)
  outcome_status=""
  lifecycle_event=""
  if [[ "$status_lc" =~ ^(ok|done|completed|success)$ ]]; then
    outcome_status="completed"
    lifecycle_event="completed"
  elif [[ "$status_lc" =~ ^(timeout|timed_out)$ ]]; then
    outcome_status="failed"
    lifecycle_event="timeout"
  elif [[ "$status_lc" =~ ^(killed|kill|terminated)$ ]]; then
    outcome_status="failed"
    lifecycle_event="killed"
  elif [[ "$status_lc" =~ ^(failed|error|aborted|cancelled)$ ]]; then
    outcome_status="failed"
    lifecycle_event="failed"
  elif [[ "$(echo "$row" | jq -r '.abortedLastRun // false')" == "true" ]]; then
    outcome_status="failed"
    lifecycle_event="failed"
  else
    continue
  fi

  task_id="$($PSQL_BIN "$DB_NAME" -q -X -t -A -v ON_ERROR_STOP=1 -c "
    SELECT id
    FROM cortana_tasks
    WHERE status='in_progress'
      AND (
        (NULLIF('${run_id//\'/\'\'}','') IS NOT NULL AND run_id='${run_id//\'/\'\'}')
        OR (
          run_id IS NULL
          AND (
            assigned_to='${label//\'/\'\'}'
            OR assigned_to='${key//\'/\'\'}'
            OR COALESCE(metadata->>'subagent_label','')='${label//\'/\'\'}'
            OR COALESCE(metadata->>'subagent_session_key','')='${key//\'/\'\'}'
          )
        )
      )
    ORDER BY
      CASE WHEN NULLIF('${run_id//\'/\'\'}','') IS NOT NULL AND run_id='${run_id//\'/\'\'}' THEN 0 ELSE 1 END,
      updated_at DESC NULLS LAST,
      created_at DESC
    LIMIT 1;
  " | tr -d '[:space:]')"

  [[ -z "$task_id" ]] && continue

  outcome_text="Auto-synced from sub-agent ${label:-$key} (${status_lc})"
  outcome_sql="${outcome_text//\'/\'\'}"

  begin_transaction
  if [[ "$outcome_status" == "completed" ]]; then
    transaction_exec "
      UPDATE cortana_tasks
      SET status='completed',
          completed_at=COALESCE(completed_at,NOW()),
          outcome='${outcome_sql}',
          run_id=COALESCE(NULLIF('${run_id//\'/\'\'}',''), run_id),
          metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('completion_synced_at',NOW()::text,'subagent_status','${status_lc}','subagent_run_id',NULLIF('${run_id//\'/\'\'}',''))
      WHERE id=${task_id} AND status='in_progress';
    "
  else
    transaction_exec "
      UPDATE cortana_tasks
      SET status='failed',
          outcome='${outcome_sql}',
          run_id=COALESCE(NULLIF('${run_id//\'/\'\'}',''), run_id),
          metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('completion_synced_at',NOW()::text,'subagent_status','${status_lc}','subagent_run_id',NULLIF('${run_id//\'/\'\'}',''))
      WHERE id=${task_id} AND status='in_progress';
    "
  fi

  event_run_id="${run_id:-}"
  if [[ -z "$event_run_id" ]]; then
    event_run_id="session:${key}"
  fi
  event_meta="$(jq -cn --arg key "$key" --arg label "$label" --arg run_id "$run_id" --arg status "$status_lc" --arg mapped "$outcome_status" '{session_key:$key,label:$label,raw_run_id:($run_id|if length>0 then . else null end),status:$status,mapped_outcome:$mapped}')"
  if declare -F emit_run_event >/dev/null 2>&1; then
    emit_run_event "$event_run_id" "$task_id" "$lifecycle_event" "$SOURCE" "$event_meta" || true
  fi

  transaction_exec "
    INSERT INTO cortana_events (event_type, source, severity, message, metadata)
    VALUES (
      'task_completion_synced',
      '${SOURCE}',
      'info',
      'Synced task #${task_id} from sub-agent ${label:-$key} -> ${outcome_status}',
      jsonb_build_object('task_id',${task_id},'session_key','${key//\'/\'\'}','label','${label//\'/\'\'}','run_id',NULLIF('${run_id//\'/\'\'}',''),'status','${status_lc}','mapped_outcome','${outcome_status}','lifecycle_event','${lifecycle_event}')
    );
  "
  commit_transaction

  updates="$(echo "$updates" | jq --argjson task_id "$task_id" --arg label "$label" --arg key "$key" --arg run_id "$run_id" --arg status "$status_lc" --arg mapped "$outcome_status" '. + [{task_id:$task_id,label:$label,session_key:$key,run_id:$run_id,status:$status,mapped_outcome:$mapped}]')"
done < <(echo "$SESSIONS_JSON" | jq -c '.sessions[]? | select((.key // "") | contains(":subagent:"))')

log_idempotency "$OPERATION_ID" "$OPERATION_TYPE" "completed" "$(jq -cn --argjson synced_count "$(echo "$updates" | jq 'length')" '{synced_count:$synced_count}')"

jq -n --argjson synced "$updates" '{ok:true, synced_count:($synced|length), synced:$synced}'
