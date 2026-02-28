#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COUNCIL_SH="$SCRIPT_DIR/council.sh"
TALLY_SH="$SCRIPT_DIR/council-tally.sh"

usage() {
  cat <<'EOF'
Usage:
  run-deliberation.sh <session-uuid>

What it does:
  1) Fetches the council session context
  2) Spawns Oracle agent to analyze + cast vote
  3) Spawns Researcher agent to analyze + cast vote
  4) Runs council-tally.sh to finalize decision
EOF
}

json_error() {
  local msg="$1"
  python3 - <<'PY' "$msg"
import json,sys
print(json.dumps({"ok": False, "error": sys.argv[1]}, separators=(",", ":")))
PY
}

die() {
  json_error "$1"
  exit 1
}

[[ ${1:-} == "-h" || ${1:-} == "--help" ]] && { usage; exit 0; }
[[ $# -eq 1 ]] || { usage; exit 1; }

SESSION_ID="$1"
if ! [[ "$SESSION_ID" =~ ^[0-9a-fA-F-]{36}$ ]]; then
  die "Session id must be a UUID"
fi

if ! command -v openclaw >/dev/null 2>&1; then
  die "openclaw CLI not found in PATH"
fi

session_json="$($COUNCIL_SH status --session "$SESSION_ID")" || die "Unable to load session"

build_prompt() {
  local role="$1"
  python3 - <<'PY' "$role" "$SESSION_ID" "$session_json"
import json,sys
role=sys.argv[1]
session_id=sys.argv[2]
raw=sys.argv[3]
obj=json.loads(raw)
s=obj.get("session") or {}

prompt={
  "role": role,
  "instruction": (
    "You are participating in a Council deliberation. Analyze the prompt and cast exactly one vote "
    "using the council CLI in this workspace."
  ),
  "required_steps": [
    "Read session context.",
    "Choose one of: approve, reject, abstain.",
    f"Run: ~/openclaw/tools/council/council.sh vote --session {session_id} --voter {role} --vote <approve|reject|abstain> --confidence <0-1> --reasoning '<brief rationale>' --model '<model>'",
    "Return a concise summary with vote + confidence."
  ],
  "session": {
    "id": s.get("id"),
    "title": s.get("title"),
    "type": s.get("type"),
    "initiator": s.get("initiator"),
    "participants": s.get("participants"),
    "context": s.get("context", {})
  }
}
print(json.dumps(prompt, separators=(",", ":")))
PY
}

run_agent() {
  local role="$1"
  local prompt
  prompt="$(build_prompt "$role")"

  openclaw agent \
    --agent "$role" \
    --session-id "council-${SESSION_ID}-${role}" \
    --message "$prompt" \
    --timeout 900 \
    --json >/tmp/council-${SESSION_ID}-${role}.json
}

run_agent "oracle" || die "Oracle agent run failed"
run_agent "researcher" || die "Researcher agent run failed"

tally_json="$($TALLY_SH --session "$SESSION_ID")" || die "Failed to tally council decision"

python3 - <<'PY' "$SESSION_ID" "$tally_json"
import json,sys
sid=sys.argv[1]
tally=json.loads(sys.argv[2])
print(json.dumps({
  "ok": True,
  "action": "run_deliberation",
  "session_id": sid,
  "oracle_log": f"/tmp/council-{sid}-oracle.json",
  "researcher_log": f"/tmp/council-{sid}-researcher.json",
  "tally": tally
}, separators=(",", ":")))
PY
