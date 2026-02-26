#!/usr/bin/env bash
set -euo pipefail

# Auto-executable task dispatcher
# Picks one dependency-ready auto_executable task and executes allowed plans.
# Allowed actions are intentionally limited to local repo code/data fetch ops.

export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/local/bin:/usr/bin:/bin"

DB="${CORTANA_DB:-cortana}"
ROOT="${CORTANA_ROOT:-/Users/hd}"
ALLOW_PREFIX_1="$ROOT/Developer/cortana"
ALLOW_PREFIX_2="$ROOT/Developer/cortana-external"
LOG_DECISION_SCRIPT="/Users/hd/clawd/tools/log-decision.sh"

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

TASK_ROW="$(query_one "
SELECT row_to_json(t)
FROM (
  SELECT id, title, description, execution_plan, metadata
  FROM cortana_tasks
  WHERE status='pending'
    AND auto_executable=TRUE
    AND (execute_at IS NULL OR execute_at <= NOW())
    AND (depends_on IS NULL OR NOT EXISTS (
      SELECT 1 FROM cortana_tasks t2
      WHERE t2.id = ANY(cortana_tasks.depends_on) AND t2.status != 'done'
    ))
  ORDER BY priority ASC, created_at ASC
  LIMIT 1
) t;")"

if [[ -z "${TASK_ROW// /}" || "$TASK_ROW" == "" ]]; then
  log_task_decision "auto_executor_no_ready_tasks" "skipped" "No dependency-ready auto-executable tasks found" "0.99"
  echo "No ready auto-executable tasks."
  exit 0
fi

TASK_ID="$(echo "$TASK_ROW" | jq -r '.id')"
TITLE="$(echo "$TASK_ROW" | jq -r '.title')"
PLAN="$(echo "$TASK_ROW" | jq -r '.execution_plan // ""')"
ASSIGNED="auto-executor"

# Autonomy Governor v2 gate: risk-score before execution.
GOVERNOR_JSON="$(python3 /Users/hd/clawd/tools/governor/risk_score.py --db "$DB" --task-json "$TASK_ROW" --actor "$ASSIGNED" --log --apply-task-state)"
GOVERNOR_DECISION="$(echo "$GOVERNOR_JSON" | jq -r '.decision')"
GOVERNOR_RISK="$(echo "$GOVERNOR_JSON" | jq -r '.risk_score')"
GOVERNOR_ACTION_TYPE="$(echo "$GOVERNOR_JSON" | jq -r '.action_type')"

if [[ "$GOVERNOR_DECISION" != "approved" ]]; then
  log_task_decision "auto_executor_governor_${GOVERNOR_DECISION}" "skipped" "Governor blocked execution (action_type=${GOVERNOR_ACTION_TYPE}, risk=${GOVERNOR_RISK})" "0.95" "$TASK_ID"
  echo "Governor ${GOVERNOR_DECISION}: task #${TASK_ID} queued/blocked (action_type=${GOVERNOR_ACTION_TYPE}, risk=${GOVERNOR_RISK})."
  exit 0
fi

# Mark in-progress only after governor approval.
psql "$DB" -v ON_ERROR_STOP=1 -c "UPDATE cortana_tasks SET status='in_progress', assigned_to='${ASSIGNED}' WHERE id=${TASK_ID};" >/dev/null

# Determine command source:
# 1) metadata.exec.command and metadata.exec.cwd (preferred structured)
# 2) fallback execution_plan as command string
CMD="$(echo "$TASK_ROW" | jq -r '.metadata.exec.command // empty')"
CWD="$(echo "$TASK_ROW" | jq -r '.metadata.exec.cwd // empty')"

if [[ -z "$CMD" ]]; then
  CMD="$PLAN"
fi
if [[ -z "$CWD" ]]; then
  CWD="/Users/hd/Developer/cortana"
fi

# Whitelist guardrails
case "$CWD" in
  "$ALLOW_PREFIX_1"*|"$ALLOW_PREFIX_2"*) ;;
  *)
    REASON="Skipped by whitelist: cwd '${CWD}' is outside allowed repos"
    esc_reason="$(sql_escape "$REASON")"
    psql "$DB" -c "UPDATE cortana_tasks SET status='pending', outcome='${esc_reason}' WHERE id=${TASK_ID};" >/dev/null
    log_task_decision "auto_executor_whitelist_block" "skipped" "$REASON" "0.98" "$TASK_ID"
    echo "$REASON"
    exit 1
    ;;
esac

if [[ -z "$CMD" ]]; then
  REASON="Skipped: no executable command found in metadata.exec.command or execution_plan"
  esc_reason="$(sql_escape "$REASON")"
  psql "$DB" -c "UPDATE cortana_tasks SET status='pending', outcome='${esc_reason}' WHERE id=${TASK_ID};" >/dev/null
  log_task_decision "auto_executor_missing_command" "fail" "$REASON" "0.99" "$TASK_ID"
  echo "$REASON"
  exit 1
fi

# Additional command safelist (read/fetch/code-intel only)
if ! echo "$CMD" | grep -Eq '^(git (status|log|show|diff|fetch|pull|branch|rev-parse)|grep |find |ls |cat |head |tail |jq |python3? |node |npm (run )?test|go test|curl -s|openclaw |psql )'; then
  REASON="Skipped by command safelist: $CMD"
  esc_reason="$(sql_escape "$REASON")"
  psql "$DB" -c "UPDATE cortana_tasks SET status='pending', outcome='${esc_reason}' WHERE id=${TASK_ID};" >/dev/null
  log_task_decision "auto_executor_safelist_block" "skipped" "$REASON" "0.98" "$TASK_ID"
  echo "$REASON"
  exit 1
fi

set +e
OUT="$(cd "$CWD" && bash -lc "$CMD" 2>&1)"
RC=$?
set -e

SHORT_OUT="$(echo "$OUT" | tail -n 60)"
ESC_OUT="$(sql_escape "$SHORT_OUT")"
ESC_CMD="$(sql_escape "$CMD")"

if [[ $RC -eq 0 ]]; then
  psql "$DB" -v ON_ERROR_STOP=1 -c "
    UPDATE cortana_tasks
    SET status='done',
        completed_at=NOW(),
        outcome='Auto-executed by auto-executor. cmd=${ESC_CMD}\\n${ESC_OUT}',
        assigned_to='${ASSIGNED}',
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('last_auto_exec', NOW()::text, 'last_rc', 0)
    WHERE id=${TASK_ID};" >/dev/null
  log_task_decision "auto_executor_task_${TASK_ID}" "success" "Task auto-executed successfully: ${TITLE}" "0.91" "$TASK_ID"
  echo "Done task #${TASK_ID}: ${TITLE}"
else
  psql "$DB" -v ON_ERROR_STOP=1 -c "
    UPDATE cortana_tasks
    SET status='pending',
        outcome='Auto-exec failed (rc=${RC}). cmd=${ESC_CMD}\\n${ESC_OUT}',
        assigned_to='${ASSIGNED}',
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('last_auto_exec', NOW()::text, 'last_rc', ${RC})
    WHERE id=${TASK_ID};" >/dev/null
  log_task_decision "auto_executor_task_${TASK_ID}" "fail" "Task auto-execution failed rc=${RC}: ${TITLE}" "0.9" "$TASK_ID"
  echo "Failed task #${TASK_ID} rc=${RC}: ${TITLE}"
  exit $RC
fi
