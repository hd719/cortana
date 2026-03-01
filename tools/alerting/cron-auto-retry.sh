#!/usr/bin/env bash
set -euo pipefail

JOBS_FILE="${JOBS_FILE:-$HOME/.openclaw/cron/jobs.json}"
PSQL_BIN="/opt/homebrew/opt/postgresql@17/bin/psql"
DB_NAME="${DB_NAME:-cortana}"
SOURCE="heartbeat"
EVENT_TYPE="cron_auto_retry"

python3 - <<'PY' "$JOBS_FILE" "$PSQL_BIN" "$DB_NAME" "$SOURCE" "$EVENT_TYPE"
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

jobs_file = Path(sys.argv[1]).expanduser()
psql_bin = sys.argv[2]
db_name = sys.argv[3]
source = sys.argv[4]
event_type = sys.argv[5]


def emit(payload, code=0):
    print(json.dumps(payload, separators=(",", ":")))
    sys.exit(code)


def load_jobs(path: Path):
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def norm_str(value, default=""):
    if value is None:
        return default
    return str(value)


def parse_failures(state):
    if not isinstance(state, dict):
        return None
    raw = state.get("consecutiveFailures")
    if raw is None:
        raw = state.get("consecutiveErrors")
    try:
        return int(raw)
    except Exception:
        return None


def build_failed_jobs(data):
    jobs = data.get("jobs") if isinstance(data, dict) else None
    if not isinstance(jobs, list):
        return []
    failed = []
    for job in jobs:
        if not isinstance(job, dict):
            continue
        state = job.get("state")
        failures = parse_failures(state)
        if failures is None or failures < 1:
            continue
        failed.append(
            {
                "jobId": norm_str(job.get("id")),
                "name": norm_str(job.get("name"), "unknown"),
                "previousFailures": failures,
            }
        )
    return failed


def sql_escape(value: str) -> str:
    return value.replace("'", "''")


def psql_env():
    env = os.environ.copy()
    env["PATH"] = "/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    env.setdefault("PGHOST", "localhost")
    env.setdefault("PGUSER", env.get("USER", "hd"))
    return env


def log_event(severity: str, message: str, metadata: dict):
    if not os.path.isfile(psql_bin) or not os.access(psql_bin, os.X_OK):
        return
    meta_json = json.dumps(metadata, separators=(",", ":"))
    sql = (
        "INSERT INTO cortana_events (event_type, source, severity, message, metadata) "
        f"VALUES ('{sql_escape(event_type)}', '{sql_escape(source)}', '{sql_escape(severity)}', "
        f"'{sql_escape(message)}', '{sql_escape(meta_json)}'::jsonb);"
    )
    try:
        subprocess.run(
            [psql_bin, db_name, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql],
            env=psql_env(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except Exception:
        return


data = load_jobs(jobs_file)
if data is None:
    emit(
        {
            "ok": False,
            "error": "jobs file missing or unreadable",
            "jobsFile": str(jobs_file),
            "retried": [],
        },
        code=1,
    )

failed_jobs = build_failed_jobs(data)
results = []
any_failed = False

for job in failed_jobs:
    job_id = job.get("jobId", "")
    name = job.get("name", "unknown")
    prev_failures = int(job.get("previousFailures") or 0)

    rc = 0
    try:
        proc = subprocess.run(
            ["openclaw", "cron", "run", job_id],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            check=False,
        )
        rc = int(proc.returncode)
    except Exception:
        rc = 127

    result = {
        "jobId": job_id,
        "name": name,
        "previousFailures": prev_failures,
        "retryExitCode": rc,
    }
    results.append(result)

    if rc != 0:
        any_failed = True

    severity = "info" if rc == 0 else "warning"
    msg = f"Cron auto-retry: {name} ({job_id}) exit {rc}"
    log_event(severity, msg, result)

summary = {
    "ok": not any_failed,
    "retried": results,
    "retryCount": len(results),
    "failedRetryCount": sum(1 for r in results if int(r.get("retryExitCode", 0)) != 0),
    "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
}

emit(summary, code=1 if any_failed else 0)
PY
