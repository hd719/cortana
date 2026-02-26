#!/usr/bin/env bash
set -euo pipefail

PSQL_BIN="/opt/homebrew/opt/postgresql@17/bin/psql"
DB_NAME="${CORTANA_DB:-cortana}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RULES_FILE="${AUTO_CHAIN_RULES_FILE:-$ROOT_DIR/config/auto-chain-rules.json}"
SOURCE="task-board-auto-chain"

usage() {
  cat <<'EOF'
Auto-chain rules engine for cortana_tasks.

Usage:
  auto-chain.sh evaluate <completed_task_id>

Behavior:
  - Reads completed task title/outcome
  - Matches against config/auto-chain-rules.json
  - Outputs JSON recommendations
  - If rule.auto_execute=true, creates follow-up task(s) in cortana_tasks
  - Logs evaluation/actions to cortana_events
EOF
}

require_bins() {
  [[ -x "$PSQL_BIN" ]] || { echo '{"ok":false,"error":"psql_not_found"}'; exit 1; }
  command -v jq >/dev/null 2>&1 || { echo '{"ok":false,"error":"jq_not_found"}'; exit 1; }
  [[ -f "$RULES_FILE" ]] || { echo '{"ok":false,"error":"rules_file_missing","path":"'"$RULES_FILE"'"}'; exit 1; }
}

is_int() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

sql_escape() {
  echo "${1:-}" | sed "s/'/''/g"
}

psql_json() {
  local sql="$1"
  shift
  "$PSQL_BIN" "$DB_NAME" -X -q -t -A -v ON_ERROR_STOP=1 "$@" <<SQL
${sql}
SQL
}

fetch_task_json() {
  local task_id="$1"
  psql_json "SELECT row_to_json(t)::text FROM (SELECT id, title, description, outcome, status, priority, source FROM cortana_tasks WHERE id = :task_id LIMIT 1) t;" -v "task_id=$task_id"
}

log_event() {
  local event_type="$1"
  local severity="$2"
  local message="$3"
  local metadata_json="$4"
  local esc_message
  esc_message="$(sql_escape "$message")"

  psql_json "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES (:'event_type', :'source', :'severity', '$esc_message', :'metadata'::jsonb) RETURNING id;" \
    -v "event_type=$event_type" \
    -v "source=$SOURCE" \
    -v "severity=$severity" \
    -v "metadata=$metadata_json" >/dev/null || true
}

create_followup_task() {
  local completed_task_id="$1"
  local completed_title="$2"
  local next_action="$3"
  local agent_role="$4"

  local desc metadata_json
  desc="Auto-chain follow-up from completed task #${completed_task_id}: ${completed_title}. Suggested action: ${next_action}."
  metadata_json="$(jq -nc \
    --arg engine "auto-chain" \
    --arg role "$agent_role" \
    --arg next "$next_action" \
    --argjson from_id "$completed_task_id" \
    '{auto_chain:true, engine:$engine, agent_role:$role, next_action:$next, from_completed_task_id:$from_id}')"

  local esc_title esc_desc
  esc_title="$(sql_escape "$next_action")"
  esc_desc="$(sql_escape "$desc")"

  psql_json "
    INSERT INTO cortana_tasks (title, description, priority, auto_executable, source, status, metadata)
    VALUES ('$esc_title', '$esc_desc', 3, FALSE, 'auto-chain', 'pending', :'metadata'::jsonb)
    RETURNING id;
  " -v "metadata=$metadata_json"
}

cmd_evaluate() {
  local task_id="$1"

  local task_json
  task_json="$(fetch_task_json "$task_id")"
  if [[ -z "${task_json// }" ]]; then
    echo "{\"ok\":false,\"error\":\"task_not_found\",\"task_id\":$task_id}"
    exit 1
  fi

  local status title description outcome
  status="$(echo "$task_json" | jq -r '.status // ""')"
  title="$(echo "$task_json" | jq -r '.title // ""')"
  description="$(echo "$task_json" | jq -r '.description // ""')"
  outcome="$(echo "$task_json" | jq -r '.outcome // ""')"

  local match_text
  match_text="$title
$description
$outcome"

  local matched_rules
  matched_rules="$(jq -c --arg text "$match_text" '[.rules[] as $r | select($text | test($r.trigger_task_pattern; "i")) | $r]' "$RULES_FILE")"

  local matched_count
  matched_count="$(echo "$matched_rules" | jq 'length')"

  log_event "auto_chain_evaluated" "info" "Auto-chain evaluated task #$task_id (status=$status), matches=$matched_count" "$(jq -nc --argjson task_id "$task_id" --arg status "$status" --argjson matched_count "$matched_count" --arg rules_file "$RULES_FILE" '{task_id:$task_id,status:$status,matched_count:$matched_count,rules_file:$rules_file}')"

  local recs='[]'
  if [[ "$matched_count" -gt 0 ]]; then
    while IFS= read -r rule; do
      [[ -z "$rule" ]] && continue
      local trigger next_action agent_role auto_execute created_task_id event_msg
      trigger="$(echo "$rule" | jq -r '.trigger_task_pattern')"
      next_action="$(echo "$rule" | jq -r '.next_action')"
      agent_role="$(echo "$rule" | jq -r '.agent_role')"
      auto_execute="$(echo "$rule" | jq -r '.auto_execute')"
      created_task_id="null"

      if [[ "$auto_execute" == "true" ]]; then
        created_task_id="$(create_followup_task "$task_id" "$title" "$next_action" "$agent_role")"
        event_msg="Auto-chain created follow-up task #$created_task_id from completed task #$task_id"
        log_event "auto_chain_task_created" "info" "$event_msg" "$(jq -nc --argjson task_id "$task_id" --argjson created_task_id "$created_task_id" --arg trigger "$trigger" --arg next_action "$next_action" --arg agent_role "$agent_role" '{task_id:$task_id,created_task_id:$created_task_id,trigger_task_pattern:$trigger,next_action:$next_action,agent_role:$agent_role,auto_execute:true}')"
      else
        log_event "auto_chain_rule_matched" "info" "Auto-chain matched non-auto rule for task #$task_id" "$(jq -nc --argjson task_id "$task_id" --arg trigger "$trigger" --arg next_action "$next_action" --arg agent_role "$agent_role" '{task_id:$task_id,trigger_task_pattern:$trigger,next_action:$next_action,agent_role:$agent_role,auto_execute:false}')"
      fi

      recs="$(echo "$recs" | jq --arg trigger "$trigger" --arg next_action "$next_action" --arg agent_role "$agent_role" --argjson auto_execute "$auto_execute" --argjson created_task_id "$created_task_id" '. + [{trigger_task_pattern:$trigger,next_action:$next_action,agent_role:$agent_role,auto_execute:$auto_execute,created_task_id:$created_task_id}]')"
    done < <(echo "$matched_rules" | jq -c '.[]')
  fi

  jq -n \
    --argjson ok true \
    --argjson completed_task_id "$task_id" \
    --arg completed_task_status "$status" \
    --arg completed_task_title "$title" \
    --argjson matched_rules_count "$matched_count" \
    --arg rules_file "$RULES_FILE" \
    --argjson recommendations "$recs" \
    '{ok:$ok, completed_task_id:$completed_task_id, completed_task_status:$completed_task_status, completed_task_title:$completed_task_title, matched_rules_count:$matched_rules_count, rules_file:$rules_file, recommendations:$recommendations}'
}

main() {
  require_bins

  local cmd="${1:-}"
  case "$cmd" in
    evaluate)
      local task_id="${2:-}"
      is_int "$task_id" || { usage; echo '{"ok":false,"error":"invalid_task_id"}'; exit 1; }
      cmd_evaluate "$task_id"
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
