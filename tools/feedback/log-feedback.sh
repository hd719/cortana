#!/usr/bin/env bash
set -euo pipefail

# Usage: log-feedback.sh <category> <severity> <summary> [details_json] [agent_id] [task_id]
# Inserts into mc_feedback_items in cortana DB

export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 <category> <severity> <summary> [details_json] [agent_id] [task_id]" >&2
  exit 1
fi

category="$1"
severity="$2"
summary="$3"
details_json="${4:-"{}"}"
agent_id="${5:-}"
task_id="${6:-}"
source="user"
status="new"
feedback_id="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"

json_escape() {
  python3 - "$1" <<'PY'
import json,sys
print(json.dumps(sys.argv[1]))
PY
}

sql_lit_or_null() {
  local v="$1"
  if [[ -z "$v" ]]; then
    echo "NULL"
  else
    printf "'%s'" "${v//\'/\'\'}"
  fi
}

is_uuid() {
  [[ "$1" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]
}

# Normalize recurrence key from details.lesson when present, else summary
recurrence_key="$(python3 - "$details_json" "$summary" <<'PY'
import json,re,sys
raw = sys.argv[1]
summary = sys.argv[2]
lesson = ""
try:
    obj = json.loads(raw) if raw else {}
    if isinstance(obj, dict):
        lesson = str(obj.get('lesson') or '')
except Exception:
    lesson = ""
base = lesson if lesson else summary
s = re.sub(r'\s+', ' ', base.lower().strip())
s = re.sub(r'[^a-z0-9 ]', '', s)
print(s[:50].strip())
PY
)"

lesson_text="$(python3 - "$details_json" <<'PY'
import json,sys
raw=sys.argv[1]
lesson=""
try:
    obj=json.loads(raw) if raw else {}
    if isinstance(obj, dict):
        lesson=str(obj.get('lesson') or '')
except Exception:
    lesson=""
print(lesson)
PY
)"

# category -> legacy feedback_type
feedback_type="correction"
case "$category" in
  correction) feedback_type="correction" ;;
  preference) feedback_type="preference" ;;
  policy)
    if [[ "$severity" == "low" ]]; then
      feedback_type="approval"
    else
      feedback_type="rejection"
    fi
    ;;
  *) feedback_type="correction" ;;
esac

safe_details="${details_json//\'/\'\'}"
safe_summary="${summary//\'/\'\'}"
safe_agent_id="${agent_id//\'/\'\'}"
safe_recurrence="${recurrence_key//\'/\'\'}"
safe_lesson="${lesson_text//\'/\'\'}"

if [[ -n "$task_id" ]] && is_uuid "$task_id"; then
  task_sql="'$task_id'::uuid"
else
  task_sql="NULL"
fi

if [[ -n "$agent_id" ]]; then
  agent_sql="'${safe_agent_id}'"
else
  agent_sql="NULL"
fi

if [[ -n "$recurrence_key" ]]; then
  recurrence_sql="'${safe_recurrence}'"
else
  recurrence_sql="NULL"
fi

psql cortana -q -c "
INSERT INTO mc_feedback_items (id, task_id, agent_id, source, category, severity, summary, details, recurrence_key, status)
VALUES (
  '${feedback_id}'::uuid,
  ${task_sql},
  ${agent_sql},
  '${source}',
  '${category}',
  '${severity}',
  '${safe_summary}',
  '${safe_details}'::jsonb,
  ${recurrence_sql},
  '${status}'
);
" -q -c "
INSERT INTO cortana_feedback (feedback_type, context, lesson, applied)
VALUES (
  '${feedback_type}',
  '${safe_summary}',
  '${safe_lesson}',
  FALSE
);
"

echo "$feedback_id"
