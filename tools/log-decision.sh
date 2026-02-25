#!/usr/bin/env bash
set -euo pipefail

# Usage:
# ./log-decision.sh <trigger_type> <action_type> <action_name> <outcome> [reasoning] [confidence] [event_id] [task_id] [data_inputs_json]

if [[ $# -lt 4 ]]; then
  echo "Usage: $0 <trigger_type> <action_type> <action_name> <outcome> [reasoning] [confidence] [event_id] [task_id] [data_inputs_json]" >&2
  exit 1
fi

TRIGGER_TYPE="$1"
ACTION_TYPE="$2"
ACTION_NAME="$3"
OUTCOME="$4"
REASONING="${5:-}"
CONFIDENCE="${6:-}"
EVENT_ID="${7:-}"
TASK_ID="${8:-}"
DATA_INPUTS_JSON="${9:-}"

# Generate UUID trace id
if command -v uuidgen >/dev/null 2>&1; then
  TRACE_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
else
  TRACE_ID="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
fi

# Optional value normalization for SQL casts
if [[ -z "$CONFIDENCE" ]]; then
  CONFIDENCE=""
fi
if [[ -z "$EVENT_ID" ]]; then
  EVENT_ID=""
fi
if [[ -z "$TASK_ID" ]]; then
  TASK_ID=""
fi
if [[ -z "$DATA_INPUTS_JSON" ]]; then
  DATA_INPUTS_JSON="{}"
fi

export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

psql cortana \
  -v ON_ERROR_STOP=1 \
  -v trace_id="$TRACE_ID" \
  -v trigger_type="$TRIGGER_TYPE" \
  -v action_type="$ACTION_TYPE" \
  -v action_name="$ACTION_NAME" \
  -v outcome="$OUTCOME" \
  -v reasoning="$REASONING" \
  -v confidence="$CONFIDENCE" \
  -v event_id="$EVENT_ID" \
  -v task_id="$TASK_ID" \
  -v data_inputs="$DATA_INPUTS_JSON" \
  <<'SQL' >/dev/null
INSERT INTO cortana_decision_traces (
  trace_id,
  trigger_type,
  action_type,
  action_name,
  outcome,
  reasoning,
  confidence,
  event_id,
  task_id,
  data_inputs,
  metadata,
  completed_at
) VALUES (
  :'trace_id',
  :'trigger_type',
  :'action_type',
  :'action_name',
  :'outcome',
  NULLIF(:'reasoning', ''),
  NULLIF(:'confidence', '')::numeric,
  NULLIF(:'event_id', '')::bigint,
  NULLIF(:'task_id', '')::bigint,
  COALESCE(NULLIF(:'data_inputs', ''), '{}')::jsonb,
  jsonb_build_object('logged_by', 'tools/log-decision.sh'),
  CASE WHEN :'outcome' IN ('success', 'fail', 'skipped') THEN NOW() ELSE NULL END
);
SQL

echo "$TRACE_ID"
