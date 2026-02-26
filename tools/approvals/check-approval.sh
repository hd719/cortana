#!/usr/bin/env bash
set -euo pipefail

# Usage: check-approval.sh <action_type> <agent_id> <risk_level> <rationale> [proposal_json]
#
# For P0/P1 actions: creates an mc_approval_requests row and prints APPROVAL_REQUIRED + the request ID
# For P2 with auto-approve conditions met: prints AUTO_APPROVED
# For P3: prints AUTO_APPROVED
#
# Cortana calls this before dispatching high-risk sub-agent work.
# If APPROVAL_REQUIRED is returned, Cortana must notify the user and wait.

export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

if [[ $# -lt 4 ]]; then
  echo "Usage: $0 <action_type> <agent_id> <risk_level> <rationale> [proposal_json]" >&2
  exit 1
fi

action_type="$1"
agent_id="$2"
risk_level="$(echo "$3" | tr '[:upper:]' '[:lower:]')"
rationale="$4"
proposal_json="${5:-"{}"}"
policy_file="/Users/hd/Developer/cortana-external/apps/mission-control/config/approval-policies.json"

case "$risk_level" in
  p0|p1|p2|p3) ;;
  *)
    echo "Error: risk_level must be one of p0|p1|p2|p3" >&2
    exit 1
    ;;
esac

is_json() {
  python3 - "$1" <<'PY'
import json,sys
try:
    json.loads(sys.argv[1])
    print("ok")
except Exception:
    sys.exit(1)
PY
}

if ! is_json "$proposal_json" >/dev/null; then
  echo "Error: proposal_json must be valid JSON" >&2
  exit 1
fi

new_uuid() {
  python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
}

json_bool() {
  [[ "$1" == "true" ]] && echo "true" || echo "false"
}

safe_action_type="${action_type//\'/\'\'}"
safe_agent_id="${agent_id//\'/\'\'}"
safe_rationale="${rationale//\'/\'\'}"
safe_proposal="${proposal_json//\'/\'\'}"

insert_event() {
  local approval_id="$1"
  local payload_json="$2"
  local safe_payload="${payload_json//\'/\'\'}"

  psql cortana <<SQL >/dev/null
INSERT INTO mc_approval_events (approval_id, event_type, actor, payload)
VALUES (
  '$approval_id'::uuid,
  'created',
  '$safe_agent_id',
  '$safe_payload'::jsonb
);
SQL
}

p2_auto_approve="true"
if [[ -f "$policy_file" ]]; then
  if ! p2_auto_approve="$(python3 - "$policy_file" "$action_type" <<'PY'
import json,sys
path,action_type = sys.argv[1], sys.argv[2]
try:
    with open(path, 'r', encoding='utf-8') as f:
        cfg = json.load(f)
except Exception:
    print('true')
    raise SystemExit(0)

# Default true unless policy explicitly disables.
auto = True

# Common shapes:
# {"p2":{"autoApprove":true}}
# {"riskLevels":{"p2":{"autoApprove":true}}}
# {"actions":{"deploy":{"p2":{"autoApprove":false}}}}
if isinstance(cfg, dict):
    p2 = None
    if isinstance(cfg.get('p2'), dict):
        p2 = cfg['p2']
    elif isinstance(cfg.get('riskLevels'), dict) and isinstance(cfg['riskLevels'].get('p2'), dict):
        p2 = cfg['riskLevels']['p2']
    if isinstance(p2, dict) and 'autoApprove' in p2:
        auto = bool(p2.get('autoApprove'))

    actions = cfg.get('actions')
    if isinstance(actions, dict):
        act = actions.get(action_type)
        if isinstance(act, dict):
            act_p2 = act.get('p2')
            if isinstance(act_p2, dict) and 'autoApprove' in act_p2:
                auto = bool(act_p2.get('autoApprove'))

print('true' if auto else 'false')
PY
)"; then
    p2_auto_approve="true"
  fi
fi

case "$risk_level" in
  p3)
    echo "AUTO_APPROVED"
    exit 0
    ;;

  p0|p1)
    approval_id="$(new_uuid)"
    psql cortana <<SQL >/dev/null
INSERT INTO mc_approval_requests (id, agent_id, action_type, proposal, rationale, risk_level, auto_approvable, status)
VALUES (
  '$approval_id'::uuid,
  '$safe_agent_id',
  '$safe_action_type',
  '$safe_proposal'::jsonb,
  '$safe_rationale',
  '$risk_level',
  false,
  'pending'
);
SQL

    insert_event "$approval_id" "{\"risk_level\":\"$risk_level\",\"status\":\"pending\",\"action_type\":\"$safe_action_type\"}"
    echo "APPROVAL_REQUIRED $approval_id"
    ;;

  p2)
    approval_id="$(new_uuid)"
    if [[ "$p2_auto_approve" == "true" ]]; then
      psql cortana <<SQL >/dev/null
INSERT INTO mc_approval_requests (id, agent_id, action_type, proposal, rationale, risk_level, auto_approvable, status)
VALUES (
  '$approval_id'::uuid,
  '$safe_agent_id',
  '$safe_action_type',
  '$safe_proposal'::jsonb,
  '$safe_rationale',
  'p2',
  true,
  'approved'
);
SQL
      insert_event "$approval_id" "{\"risk_level\":\"p2\",\"status\":\"approved\",\"auto_approvable\":true,\"action_type\":\"$safe_action_type\"}"
      echo "AUTO_APPROVED"
    else
      psql cortana <<SQL >/dev/null
INSERT INTO mc_approval_requests (id, agent_id, action_type, proposal, rationale, risk_level, auto_approvable, status)
VALUES (
  '$approval_id'::uuid,
  '$safe_agent_id',
  '$safe_action_type',
  '$safe_proposal'::jsonb,
  '$safe_rationale',
  'p2',
  false,
  'pending'
);
SQL
      insert_event "$approval_id" "{\"risk_level\":\"p2\",\"status\":\"pending\",\"auto_approvable\":false,\"action_type\":\"$safe_action_type\"}"
      echo "APPROVAL_REQUIRED $approval_id"
    fi
    ;;
esac
