#!/usr/bin/env bash
set -euo pipefail

# Auto-executable task dispatcher with circuit breakers + audit trail.

export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/local/bin:/usr/bin:/bin"

DB="${CORTANA_DB:-cortana}"
ROOT="${CORTANA_ROOT:-/Users/hd}"
ALLOW_PREFIX_1="$ROOT/Developer/cortana"
ALLOW_PREFIX_2="$ROOT/Developer/cortana-external"
LOG_DECISION_SCRIPT="/Users/hd/clawd/tools/log-decision.sh"
SOURCE="task-board-auto-executor"
# shellcheck disable=SC1091
source "/Users/hd/clawd/tools/lib/idempotency.sh"
EMIT_RUN_EVENT_SCRIPT="/Users/hd/clawd/tools/task-board/emit-run-event.sh"
MAX_FAILURES_PER_HOUR="${AUTO_EXEC_MAX_FAILURES_PER_HOUR:-3}"
PAUSE_MINUTES="${AUTO_EXEC_PAUSE_MINUTES:-60}"
ALLOW_TASK_TYPES="${AUTO_EXEC_ALLOW_TASK_TYPES:-research,analysis,maintenance,monitoring,reporting}"

log_task_decision() {
  local action_name="$1"
  local outcome="$2"
  local reasoning="$3"
  local confidence="${4:-0.9}"
  local task_id="${5:-}"
  local data_inputs='{}'

  if [[ -n "$task_id" ]]; then
    data_inputs="{\"task_id\":$task_id}"
  fi

  if [[ -x "$LOG_DECISION_SCRIPT" ]]; then
    "$LOG_DECISION_SCRIPT" "auto_executor" "task_execution" "$action_name" "$outcome" "$reasoning" "$confidence" "" "$task_id" "$data_inputs" >/dev/null 2>&1 || true
  fi
}

query_one() {
  psql "$DB" -t -A -c "$1"
}

sql_escape() {
  echo "$1" | sed "s/'/''/g"
}

trap 'rollback_transaction' ERR

if [[ -f "$EMIT_RUN_EVENT_SCRIPT" ]]; then
  # shellcheck disable=SC1090
  source "$EMIT_RUN_EVENT_SCRIPT"
fi

extract_run_id() {
  local text="$1"
  local candidate=""

  # Try JSON first (common for structured CLI output)
  candidate="$(printf '%s' "$text" | jq -r 'try (fromjson | .run_id // .runId // .id // empty) catch empty' 2>/dev/null | head -n1)"

  # Fallback: scrape run_id/runId tokens from plain text
  if [[ -z "$candidate" ]]; then
    candidate="$(printf '%s' "$text" | grep -Eio '(run_id|runId)[[:space:]]*[:=][[:space:]]*[A-Za-z0-9:_-]+' | head -n1 | sed -E 's/.*[:=][[:space:]]*//')"
  fi

  echo "$candidate"
}

audit_event() {
  local event_type="$1"
  local severity="$2"
  local message="$3"
  local metadata="${4:-{}}"
  local esc_msg esc_meta
  esc_msg="$(sql_escape "$message")"
  esc_meta="$(sql_escape "$metadata")"
  psql "$DB" -v ON_ERROR_STOP=1 -c "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('$event_type', '$SOURCE', '$severity', '$esc_msg', '$esc_meta'::jsonb);" >/dev/null 2>&1 || true
}

is_type_allowed() {
  local task_type="$1"
  local allowed_csv=",${ALLOW_TASK_TYPES},"
  [[ "$allowed_csv" == *",${task_type},"* ]]
}

circuit_breaker_check() {
  local recent_failures pause_until now_epoch
  recent_failures="$(query_one "
    SELECT COUNT(*)::int
    FROM cortana_events
    WHERE source='${SOURCE}'
      AND event_type='auto_executor_task_failed'
      AND timestamp >= NOW() - INTERVAL '1 hour';")"
  recent_failures="${recent_failures//[[:space:]]/}"
  recent_failures="${recent_failures:-0}"

  if (( recent_failures < MAX_FAILURES_PER_HOUR )); then
    return 0
  fi

  pause_until="$(query_one "
    SELECT COALESCE((metadata->>'pause_until')::timestamptz, NOW() - INTERVAL '1 second')
    FROM cortana_events
    WHERE source='${SOURCE}'
      AND event_type='auto_executor_circuit_breaker'
    ORDER BY timestamp DESC
    LIMIT 1;")"

  now_epoch="$(date +%s)"
  local pause_epoch
  pause_epoch="$(date -j -f '%Y-%m-%d %H:%M:%S%z' "$(echo "$pause_until" | sed 's/ /T/;s/\.\([0-9]*\)//' 2>/dev/null)" +%s 2>/dev/null || echo 0)"

  if [[ "$pause_epoch" -gt "$now_epoch" ]]; then
    audit_event "auto_executor_skipped_circuit_open" "warning" "Circuit breaker open; auto-executor paused" "{\"recent_failures\":${recent_failures},\"pause_until\":\"${pause_until}\"}"
    echo "Circuit breaker open until $pause_until"
    exit 0
  fi

  local new_pause
  new_pause="$(query_one "SELECT (NOW() + INTERVAL '${PAUSE_MINUTES} minutes')::text;")"
  audit_event "auto_executor_circuit_breaker" "warning" "Circuit breaker tripped due to repeated failures" "{\"recent_failures\":${recent_failures},\"max_failures_per_hour\":${MAX_FAILURES_PER_HOUR},\"pause_until\":\"${new_pause}\"}"
  echo "Circuit breaker tripped: ${recent_failures} failures/hour. Pausing for ${PAUSE_MINUTES} minutes."
  exit 0
}

rollback_if_possible() {
  local cwd="$1"
  local rollback_cmd="$2"
  [[ -z "$rollback_cmd" ]] && return 0

  local out rc
  set +e
  out="$(cd "$cwd" && bash -lc "$rollback_cmd" 2>&1)"
  rc=$?
  set -e

  local esc_out esc_cmd
  esc_out="$(sql_escape "$(echo "$out" | tail -n 40)")"
  esc_cmd="$(sql_escape "$rollback_cmd")"

  if [[ $rc -eq 0 ]]; then
    audit_event "auto_executor_rollback_success" "info" "Rollback succeeded" "{\"rollback_cmd\":\"${esc_cmd}\",\"output\":\"${esc_out}\"}"
  else
    audit_event "auto_executor_rollback_failed" "error" "Rollback failed" "{\"rollback_cmd\":\"${esc_cmd}\",\"output\":\"${esc_out}\",\"rc\":${rc}}"
  fi
}

circuit_breaker_check

TASK_ROW="$(query_one "
SELECT row_to_json(t)
FROM (
  SELECT id, title, description, execution_plan, metadata
  FROM cortana_tasks
  WHERE status='ready'
    AND auto_executable=TRUE
    AND (execute_at IS NULL OR execute_at <= NOW())
    AND (depends_on IS NULL OR NOT EXISTS (
      SELECT 1 FROM cortana_tasks t2
      WHERE t2.id = ANY(cortana_tasks.depends_on) AND t2.status != 'completed'
    ))
  ORDER BY priority ASC, created_at ASC
  LIMIT 1
) t;")"

if [[ -z "${TASK_ROW// /}" || "$TASK_ROW" == "" ]]; then
  log_task_decision "auto_executor_no_ready_tasks" "skipped" "No dependency-ready auto-executable tasks found" "0.99"
  audit_event "auto_executor_no_ready_tasks" "info" "No dependency-ready auto-executable tasks found" "{}"
  echo "No ready auto-executable tasks."
  exit 0
fi

TASK_ID="$(echo "$TASK_ROW" | jq -r '.id')"
TITLE="$(echo "$TASK_ROW" | jq -r '.title')"
PLAN="$(echo "$TASK_ROW" | jq -r '.execution_plan // ""')"
ASSIGNED="auto-executor"
TASK_TYPE="$(echo "$TASK_ROW" | jq -r '.metadata.task_type // "unknown"')"
OPERATION_ID="$(generate_operation_id)"
OPERATION_TYPE="auto_executor_task_${TASK_ID}"

if check_idempotency "$OPERATION_ID"; then
  log_idempotency "$OPERATION_ID" "$OPERATION_TYPE" "skipped" "$(jq -cn --argjson task_id "$TASK_ID" --arg reason "already_completed" '{task_id:$task_id,reason:$reason}')"
  echo "Skipping task #${TASK_ID}: operation ${OPERATION_ID} already completed."
  exit 0
fi

log_idempotency "$OPERATION_ID" "$OPERATION_TYPE" "started" "$(jq -cn --argjson task_id "$TASK_ID" --arg title "$TITLE" --arg task_type "$TASK_TYPE" '{task_id:$task_id,title:$title,task_type:$task_type}')"

if ! is_type_allowed "$TASK_TYPE"; then
  REASON="Skipped by task type allowlist: task_type='${TASK_TYPE}'"
  esc_reason="$(sql_escape "$REASON")"
  psql "$DB" -c "UPDATE cortana_tasks SET status='ready', outcome='${esc_reason}' WHERE id=${TASK_ID};" >/dev/null
  audit_event "auto_executor_task_type_blocked" "warning" "$REASON" "{\"task_id\":${TASK_ID},\"task_type\":\"${TASK_TYPE}\",\"allowlist\":\"${ALLOW_TASK_TYPES}\"}"
  echo "$REASON"
  exit 1
fi

# Autonomy Governor v2 gate: risk-score before execution.
GOVERNOR_JSON="$(python3 /Users/hd/clawd/tools/governor/risk_score.py --db "$DB" --task-json "$TASK_ROW" --actor "$ASSIGNED" --log --apply-task-state)"
GOVERNOR_DECISION="$(echo "$GOVERNOR_JSON" | jq -r '.decision')"
GOVERNOR_RISK="$(echo "$GOVERNOR_JSON" | jq -r '.risk_score')"
GOVERNOR_ACTION_TYPE="$(echo "$GOVERNOR_JSON" | jq -r '.action_type')"

if [[ "$GOVERNOR_DECISION" != "approved" ]]; then
  log_task_decision "auto_executor_governor_${GOVERNOR_DECISION}" "skipped" "Governor blocked execution (action_type=${GOVERNOR_ACTION_TYPE}, risk=${GOVERNOR_RISK})" "0.95" "$TASK_ID"
  audit_event "auto_executor_governor_block" "warning" "Governor blocked execution" "{\"task_id\":${TASK_ID},\"decision\":\"${GOVERNOR_DECISION}\",\"action_type\":\"${GOVERNOR_ACTION_TYPE}\",\"risk\":${GOVERNOR_RISK}}"
  echo "Governor ${GOVERNOR_DECISION}: task #${TASK_ID} queued/blocked (action_type=${GOVERNOR_ACTION_TYPE}, risk=${GOVERNOR_RISK})."
  exit 0
fi

RUN_ID="autoexec:${TASK_ID}:$(date +%s)"
RUN_EVENT_META="$(jq -cn --arg title "$TITLE" --arg task_type "$TASK_TYPE" --arg actor "$ASSIGNED" '{title:$title,task_type:$task_type,actor:$actor}')"
if declare -F emit_run_event >/dev/null 2>&1; then
  emit_run_event "$RUN_ID" "$TASK_ID" "queued" "$SOURCE" "$RUN_EVENT_META" || true
fi

# Mark in-progress only after governor approval.
begin_transaction
transaction_exec "UPDATE cortana_tasks SET status='in_progress', assigned_to='${ASSIGNED}', run_id=COALESCE(NULLIF(run_id,''), '${RUN_ID}') WHERE id=${TASK_ID};"
commit_transaction

if declare -F emit_run_event >/dev/null 2>&1; then
  emit_run_event "$RUN_ID" "$TASK_ID" "running" "$SOURCE" "$RUN_EVENT_META" || true
fi

CMD="$(echo "$TASK_ROW" | jq -r '.metadata.exec.command // empty')"
CWD="$(echo "$TASK_ROW" | jq -r '.metadata.exec.cwd // empty')"
ROLLBACK_CMD="$(echo "$TASK_ROW" | jq -r '.metadata.exec.rollback // empty')"

if [[ -z "$CMD" ]]; then
  CMD="$PLAN"
fi
if [[ -z "$CWD" ]]; then
  CWD="/Users/hd/Developer/cortana"
fi

case "$CWD" in
  "$ALLOW_PREFIX_1"*|"$ALLOW_PREFIX_2"*) ;;
  *)
    REASON="Skipped by whitelist: cwd '${CWD}' is outside allowed repos"
    esc_reason="$(sql_escape "$REASON")"
    psql "$DB" -c "UPDATE cortana_tasks SET status='ready', outcome='${esc_reason}' WHERE id=${TASK_ID};" >/dev/null
    log_task_decision "auto_executor_whitelist_block" "skipped" "$REASON" "0.98" "$TASK_ID"
    audit_event "auto_executor_whitelist_block" "warning" "$REASON" "{\"task_id\":${TASK_ID},\"cwd\":\"$(sql_escape "$CWD")\"}"
    echo "$REASON"
    exit 1
    ;;
esac

if [[ -z "$CMD" ]]; then
  REASON="Skipped: no executable command found in metadata.exec.command or execution_plan"
  esc_reason="$(sql_escape "$REASON")"
  psql "$DB" -c "UPDATE cortana_tasks SET status='ready', outcome='${esc_reason}' WHERE id=${TASK_ID};" >/dev/null
  log_task_decision "auto_executor_missing_command" "fail" "$REASON" "0.99" "$TASK_ID"
  audit_event "auto_executor_missing_command" "error" "$REASON" "{\"task_id\":${TASK_ID}}"
  echo "$REASON"
  exit 1
fi

if ! echo "$CMD" | grep -Eq '^(git (status|log|show|diff|fetch|pull|branch|rev-parse)|grep |find |ls |cat |head |tail |jq |python3? |node |npm (run )?test|go test|curl -s|openclaw |psql )'; then
  REASON="Skipped by command safelist: $CMD"
  esc_reason="$(sql_escape "$REASON")"
  psql "$DB" -c "UPDATE cortana_tasks SET status='ready', outcome='${esc_reason}' WHERE id=${TASK_ID};" >/dev/null
  log_task_decision "auto_executor_safelist_block" "skipped" "$REASON" "0.98" "$TASK_ID"
  audit_event "auto_executor_safelist_block" "warning" "$REASON" "{\"task_id\":${TASK_ID},\"cmd\":\"$(sql_escape "$CMD")\"}"
  echo "$REASON"
  exit 1
fi

audit_event "auto_executor_task_started" "info" "Starting auto-execution for task" "{\"task_id\":${TASK_ID},\"title\":\"$(sql_escape "$TITLE")\",\"task_type\":\"${TASK_TYPE}\",\"cwd\":\"$(sql_escape "$CWD")\",\"cmd\":\"$(sql_escape "$CMD")\"}"

set +e
OUT="$(cd "$CWD" && bash -lc "$CMD" 2>&1)"
RC=$?
set -e

SHORT_OUT="$(echo "$OUT" | tail -n 60)"
ESC_OUT="$(sql_escape "$SHORT_OUT")"
ESC_CMD="$(sql_escape "$CMD")"
RUN_ID="$(extract_run_id "$OUT")"
ESC_RUN_ID="$(sql_escape "$RUN_ID")"

if [[ $RC -eq 0 ]]; then
  psql "$DB" -v ON_ERROR_STOP=1 -c "
    UPDATE cortana_tasks
    SET status='completed',
        completed_at=NOW(),
        outcome='Auto-executed by auto-executor. cmd=${ESC_CMD}\\n${ESC_OUT}',
        assigned_to='${ASSIGNED}',
        run_id=COALESCE(NULLIF('${ESC_RUN_ID}',''), run_id),
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('last_auto_exec', NOW()::text, 'last_rc', 0, 'subagent_run_id', NULLIF('${ESC_RUN_ID}',''))
    WHERE id=${TASK_ID};" >/dev/null
  log_task_decision "auto_executor_task_${TASK_ID}" "success" "Task auto-executed successfully: ${TITLE}" "0.91" "$TASK_ID"
  audit_event "auto_executor_task_succeeded" "info" "Task auto-executed successfully" "{\"task_id\":${TASK_ID},\"rc\":0}"
  log_idempotency "$OPERATION_ID" "$OPERATION_TYPE" "completed" "$(jq -cn --argjson task_id "$TASK_ID" --arg title "$TITLE" --arg run_id "$RUN_ID" '{task_id:$task_id,title:$title,run_id:($run_id|if length>0 then . else null end),rc:0}')"
  echo "Done task #${TASK_ID}: ${TITLE}"
else
  rollback_if_possible "$CWD" "$ROLLBACK_CMD"
  psql "$DB" -v ON_ERROR_STOP=1 -c "
    UPDATE cortana_tasks
    SET status='ready',
        outcome='Auto-exec failed (rc=${RC}). cmd=${ESC_CMD}\\n${ESC_OUT}',
        assigned_to='${ASSIGNED}',
        run_id=COALESCE(NULLIF('${ESC_RUN_ID}',''), run_id),
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('last_auto_exec', NOW()::text, 'last_rc', ${RC}, 'subagent_run_id', NULLIF('${ESC_RUN_ID}',''))
    WHERE id=${TASK_ID};" >/dev/null
  log_task_decision "auto_executor_task_${TASK_ID}" "fail" "Task auto-execution failed rc=${RC}: ${TITLE}" "0.9" "$TASK_ID"
  audit_event "auto_executor_task_failed" "error" "Task auto-execution failed" "{\"task_id\":${TASK_ID},\"rc\":${RC},\"cmd\":\"${ESC_CMD}\",\"output\":\"${ESC_OUT}\"}"
  log_idempotency "$OPERATION_ID" "$OPERATION_TYPE" "failed" "$(jq -cn --argjson task_id "$TASK_ID" --arg title "$TITLE" --arg run_id "$RUN_ID" --argjson rc "$RC" '{task_id:$task_id,title:$title,run_id:($run_id|if length>0 then . else null end),rc:$rc}')"
  echo "Failed task #${TASK_ID} rc=${RC}: ${TITLE}"
  exit $RC
fi
