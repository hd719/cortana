#!/usr/bin/env bash
set -euo pipefail

PSQL_BIN="/opt/homebrew/opt/postgresql@17/bin/psql"
DB_NAME="${CORTANA_DB:-cortana}"
SOURCE="research-pipeline"
EVENT_SOURCE="task-board-research-to-tasks"

usage() {
  cat <<'EOF'
Convert research recommendations into cortana_tasks.

Usage:
  research-to-tasks.sh [--input <file>] [--dry-run]

Input format (JSON array):
[
  {
    "title": "Task title",
    "description": "Task details",
    "priority": 1,
    "agent_role": "huragok",
    "auto_executable": true
  }
]

Notes:
- Reads JSON from --input file if provided, otherwise stdin.
- In dry-run mode, no tasks are created.
EOF
}

require_bins() {
  [[ -x "$PSQL_BIN" ]] || { echo '{"ok":false,"error":"psql_not_found"}'; exit 1; }
  command -v jq >/dev/null 2>&1 || { echo '{"ok":false,"error":"jq_not_found"}'; exit 1; }
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

log_event() {
  local event_type="$1"
  local severity="$2"
  local message="$3"
  local metadata_json="$4"
  local esc_message
  esc_message="$(sql_escape "$message")"

  psql_json "
    INSERT INTO cortana_events (event_type, source, severity, message, metadata)
    VALUES (:'event_type', :'source', :'severity', '$esc_message', :'metadata'::jsonb)
    RETURNING id;
  " \
    -v "event_type=$event_type" \
    -v "source=$EVENT_SOURCE" \
    -v "severity=$severity" \
    -v "metadata=$metadata_json" >/dev/null || true
}

read_input_json() {
  local input_file="$1"
  if [[ -n "$input_file" ]]; then
    [[ -f "$input_file" ]] || { echo "{\"ok\":false,\"error\":\"input_file_not_found\",\"path\":\"$input_file\"}"; exit 1; }
    cat "$input_file"
  else
    cat
  fi
}

create_task() {
  local title="$1"
  local description="$2"
  local priority="$3"
  local agent_role="$4"
  local auto_executable="$5"

  local status="ready"
  local execute_at_sql="NULL"
  if [[ "$auto_executable" == "true" ]]; then
    execute_at_sql="CURRENT_TIMESTAMP"
  fi

  local metadata_json
  metadata_json="$(jq -nc \
    --arg agent_role "$agent_role" \
    --arg pipeline "research-pipeline" \
    --arg created_by "research-to-tasks.sh" \
    '{agent_role:$agent_role, pipeline:$pipeline, created_by:$created_by}')"

  local esc_title esc_description
  esc_title="$(sql_escape "$title")"
  esc_description="$(sql_escape "$description")"

  psql_json "
    INSERT INTO cortana_tasks
      (title, description, priority, status, auto_executable, execute_at, source, metadata)
    VALUES
      ('$esc_title', '$esc_description', :priority, '$status', :auto_executable, $execute_at_sql, '$SOURCE', :'metadata'::jsonb)
    RETURNING row_to_json(t)::text
    FROM (
      SELECT id, title, priority, status, auto_executable, execute_at, source, created_at
      FROM cortana_tasks
      WHERE id = currval(pg_get_serial_sequence('cortana_tasks','id'))
    ) t;
  " -v "priority=$priority" -v "auto_executable=$auto_executable" -v "metadata=$metadata_json"
}

main() {
  require_bins

  local input_file=""
  local dry_run="false"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --input|-i)
        input_file="${2:-}"
        [[ -n "$input_file" ]] || { usage; echo '{"ok":false,"error":"missing_input_file"}'; exit 1; }
        shift 2
        ;;
      --dry-run)
        dry_run="true"
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        usage
        echo "{\"ok\":false,\"error\":\"unknown_arg\",\"arg\":\"$1\"}"
        exit 1
        ;;
    esac
  done

  local input_json
  input_json="$(read_input_json "$input_file")"

  # Validate and normalize
  local normalized
  normalized="$(echo "$input_json" | jq -c '
    if type != "array" then error("input_must_be_array") else . end
    | map({
        title: (.title // ""),
        description: (.description // ""),
        priority: ((.priority // 3) | tonumber),
        agent_role: (.agent_role // "builder"),
        auto_executable: ((.auto_executable // false) | if type=="boolean" then . else (tostring == "true") end)
      })
    | map(
        if (.title | length) == 0 then error("title_required") else . end
        | .priority = (if .priority < 1 then 1 elif .priority > 5 then 5 else .priority end)
      )
  ')"

  local count
  count="$(echo "$normalized" | jq 'length')"

  local created='[]'
  local idx=0
  while [[ "$idx" -lt "$count" ]]; do
    local rec title description priority agent_role auto_executable
    rec="$(echo "$normalized" | jq -c ".[$idx]")"
    title="$(echo "$rec" | jq -r '.title')"
    description="$(echo "$rec" | jq -r '.description')"
    priority="$(echo "$rec" | jq -r '.priority')"
    agent_role="$(echo "$rec" | jq -r '.agent_role')"
    auto_executable="$(echo "$rec" | jq -r '.auto_executable')"

    if [[ "$dry_run" == "true" ]]; then
      created="$(echo "$created" | jq \
        --arg title "$title" \
        --arg description "$description" \
        --argjson priority "$priority" \
        --arg agent_role "$agent_role" \
        --argjson auto_executable "$auto_executable" \
        '. + [{dry_run:true,id:null,title:$title,description:$description,priority:$priority,status:"ready",auto_executable:$auto_executable,source:"research-pipeline",metadata:{agent_role:$agent_role,pipeline:"research-pipeline",created_by:"research-to-tasks.sh"}}]')"
    else
      local task_json
      task_json="$(create_task "$title" "$description" "$priority" "$agent_role" "$auto_executable")"
      created="$(echo "$created" | jq --argjson task "$task_json" --arg agent_role "$agent_role" '. + [($task + {metadata:{agent_role:$agent_role,pipeline:"research-pipeline",created_by:"research-to-tasks.sh"}})]')"

      log_event "research_task_created" "info" "Created task from research recommendation" "$(jq -nc \
        --arg title "$title" \
        --arg agent_role "$agent_role" \
        --argjson auto_executable "$auto_executable" \
        --argjson task "$(echo "$task_json")" \
        '{title:$title,agent_role:$agent_role,auto_executable:$auto_executable,task:$task}')"
    fi

    idx=$((idx + 1))
  done

  local report
  report="$(jq -n \
    --argjson ok true \
    --arg source "$SOURCE" \
    --argjson dry_run "$dry_run" \
    --argjson input_count "$count" \
    --argjson created "$created" \
    '{ok:$ok,source:$source,dry_run:$dry_run,input_count:$input_count,created_count:($created|length),created:$created}')"

  log_event "research_to_tasks_run" "info" "Processed research recommendations into tasks" "$(echo "$report" | jq -c '.')"

  echo "$report"
}

main "$@"
