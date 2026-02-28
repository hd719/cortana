#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
SOURCE="session-reconciler"
# shellcheck disable=SC1091
source "/Users/hd/openclaw/tools/lib/idempotency.sh"
trap 'rollback_transaction' ERR

SESSIONS_JSON="${OPENCLAW_SESSIONS_FILE:-$HOME/.openclaw/agents/main/sessions/sessions.json}"
DRY_RUN="${1:-}"

OPERATION_ID="$(generate_operation_id)"
OPERATION_TYPE="reconcile_sessions_pass"

if check_idempotency "$OPERATION_ID"; then
  log_idempotency "$OPERATION_ID" "$OPERATION_TYPE" "skipped" '{"reason":"already_completed"}'
  echo '{"ok":true,"skipped":true,"reason":"idempotent_operation_already_completed"}'
  exit 0
fi

log_idempotency "$OPERATION_ID" "$OPERATION_TYPE" "started" "$(jq -cn --arg sessions_file "$SESSIONS_JSON" --arg dry_run "$DRY_RUN" '{sessions_file:$sessions_file,dry_run:($dry_run=="--dry-run")}')"

set +e
RESULT="$(python3 - "$SESSIONS_JSON" "$DRY_RUN" <<'PY'
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sessions_file = Path(sys.argv[1]).expanduser()
dry_run = (sys.argv[2] == "--dry-run")

if not sessions_file.exists():
    print(json.dumps({"ok": False, "error": f"sessions file missing: {sessions_file}"}))
    sys.exit(1)

raw = json.loads(sessions_file.read_text())
if not isinstance(raw, dict):
    print(json.dumps({"ok": False, "error": "sessions.json is not an object map"}))
    sys.exit(1)

entries = raw
active_keys = set(entries.keys())
changed = 0
missing_files = []


def has_positive_completion_evidence(session_val: dict) -> bool:
    direct_status = str(session_val.get("status", "")).strip().lower()
    if direct_status in {"completed", "done", "success", "succeeded", "ok"}:
        return True

    outcome = session_val.get("outcome")
    if isinstance(outcome, dict):
        outcome_status = str(outcome.get("status", "")).strip().lower()
        if outcome_status in {"completed", "done", "success", "succeeded", "ok"}:
            return True

    result = session_val.get("result")
    if result not in (None, "", {}):
        return True

    explicit_done = session_val.get("done")
    if explicit_done is True:
        return True

    return False


for key, val in entries.items():
    if not isinstance(val, dict):
        continue
    session_file = val.get("sessionFile")
    if session_file and not Path(session_file).exists():
        missing_files.append(key)
        if has_positive_completion_evidence(val):
            val["status"] = "completed"
            val["reconciledReason"] = "session_file_missing_but_completion_evidence_present"
        else:
            val["status"] = "reconciled_unknown"
            val["reconciledReason"] = "session_disappeared_outcome_unknown"
        val["reconciledAt"] = int(time.time() * 1000)
        changed += 1

if changed and not dry_run:
    tmp = sessions_file.with_suffix(".tmp")
    bak = sessions_file.with_suffix(".json.bak")
    if sessions_file.exists():
        bak.write_text(sessions_file.read_text())
    tmp.write_text(json.dumps(entries, indent=2) + "\n")
    os.replace(tmp, sessions_file)


def psql(sql: str) -> str:
    proc = subprocess.run(["psql", "cortana", "-At", "-q", "-X", "-v", "ON_ERROR_STOP=1", "-c", sql], capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "psql failed")
    return proc.stdout.strip()

stuck = json.loads(psql("""
SELECT COALESCE(json_agg(t), '[]'::json)::text
FROM (
  SELECT id, agent, mission, session_key, started_at
  FROM cortana_covenant_runs
  WHERE (status = 'running' OR ended_at IS NULL)
  ORDER BY started_at ASC
) t;
"""))

orphans = []
for r in stuck:
    sk = r.get("session_key")
    if not sk or sk not in active_keys:
        orphans.append(r)

updated_runs = 0
run_events_emitted = 0
if orphans and not dry_run:
    ids = ",".join(str(int(r["id"])) for r in orphans)
    psql(f"""
UPDATE cortana_covenant_runs
SET status='reconciled_unknown',
    ended_at = COALESCE(ended_at, NOW()),
    summary = COALESCE(summary, '') || CASE WHEN COALESCE(summary,'')='' THEN '' ELSE E'\n' END || '[auto-reconciled] session disappeared, outcome unknown (no active session key)'
WHERE id IN ({ids});
""")
    updated_runs = len(orphans)

    for r in orphans:
        session_key = str(r.get("session_key") or "").strip()
        if not session_key:
            continue

        task_id = None
        try:
            task_raw = psql(f"""
SELECT id::text
FROM cortana_tasks
WHERE run_id = '{session_key.replace("'", "''")}'
ORDER BY updated_at DESC NULLS LAST, created_at DESC
LIMIT 1;
""")
            task_id = int(task_raw) if task_raw else None
        except Exception:
            task_id = None

        metadata = json.dumps({
            "session_key": session_key,
            "agent": r.get("agent"),
            "mission": r.get("mission"),
            "covenant_run_id": r.get("id"),
            "reason": "session_disappeared_outcome_unknown",
        }).replace("'", "''")

        task_expr = "NULL" if task_id is None else str(task_id)
        try:
            psql(f"""
INSERT INTO cortana_run_events (run_id, task_id, event_type, source, metadata)
VALUES (
  '{session_key.replace("'", "''")}',
  {task_expr},
  'reconciled_unknown',
  'session-reconciler',
  '{metadata}'::jsonb
);
""")
            run_events_emitted += 1
        except Exception:
            pass

print(json.dumps({
    "ok": True,
    "dry_run": dry_run,
    "sessions_reconciled": changed,
    "session_orphans": missing_files[:50],
    "runs_reconciled_unknown": updated_runs,
    "run_events_emitted": run_events_emitted,
    "run_orphans": orphans[:50],
}))
PY
)"
RC=$?
set -e

if [[ $RC -eq 0 ]]; then
  log_idempotency "$OPERATION_ID" "$OPERATION_TYPE" "completed" "$(echo "$RESULT" | jq -c . 2>/dev/null || echo '{}')"
else
  log_idempotency "$OPERATION_ID" "$OPERATION_TYPE" "failed" "$(jq -cn --arg rc "$RC" '{rc:($rc|tonumber)}')"
fi

echo "$RESULT"
exit $RC
