#!/usr/bin/env python3
"""Sub-agent reaper: clean stale runs and sync task board."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


RUN_STORE_PATH = Path(
    os.environ.get("OPENCLAW_SUBAGENT_RUNS_PATH", os.path.expanduser("~/.openclaw/subagents/runs.json"))
)
DB_NAME = "cortana"
ACTIVE_MINUTES = 1440
STALE_STATUSES = {"running", "in_progress"}


def now_ms() -> int:
    return int(time.time() * 1000)


def iso_from_ms(ms: int | None) -> str | None:
    if not ms:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, indent=2) + "\n"
    with tempfile.NamedTemporaryFile("w", dir=str(path.parent), delete=False) as tmp:
        tmp.write(payload)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp_name = tmp.name
    os.replace(tmp_name, path)


def resolve_psql() -> str:
    candidates = [
        os.environ.get("PSQL_BIN"),
        "/opt/homebrew/opt/postgresql@17/bin/psql",
        "psql",
    ]
    for c in candidates:
        if not c:
            continue
        if c == "psql":
            proc = subprocess.run(["/usr/bin/env", "bash", "-lc", "command -v psql"], capture_output=True, text=True)
            if proc.returncode == 0 and proc.stdout.strip():
                return "psql"
            continue
        if Path(c).exists():
            return c
    return "psql"


def run_sessions(active_minutes: int = ACTIVE_MINUTES) -> dict[str, Any]:
    cmd = ["openclaw", "sessions", "--json", "--active", str(active_minutes), "--all-agents"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "openclaw sessions failed")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Invalid JSON from openclaw sessions: {e}") from e


def sql_quote(value: str | None) -> str:
    return (value or "").replace("'", "''")


def collect_session_ids(session: dict[str, Any]) -> set[str]:
    ids = {
        str(session.get("sessionId") or "").strip(),
        str(session.get("runId") or "").strip(),
        str(session.get("run_id") or "").strip(),
        str(session.get("key") or "").strip(),
    }
    return {i for i in ids if i}


def collect_run_ids(run: dict[str, Any]) -> set[str]:
    ids = {
        str(run.get("childSessionKey") or "").strip(),
        str(run.get("runId") or "").strip(),
        str(run.get("sessionId") or "").strip(),
    }
    return {i for i in ids if i}


def log_reaped_event(*, psql_bin: str, metadata: dict[str, Any], message: str) -> tuple[bool, str | None]:
    msg_sql = message.replace("'", "''")
    meta_sql = json.dumps(metadata).replace("'", "''")
    sql = (
        "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ("
        "'subagent_reaped', 'subagent-reaper', 'warning', "
        f"'{msg_sql}', '{meta_sql}'::jsonb"
        ");"
    )
    try:
        proc = subprocess.run([psql_bin, DB_NAME, "-X", "-c", sql], capture_output=True, text=True)
    except FileNotFoundError:
        return False, f"psql not found ({psql_bin})"
    if proc.returncode != 0:
        return False, (proc.stderr.strip() or proc.stdout.strip() or "psql insert failed")
    return True, None


def reset_tasks(
    *,
    psql_bin: str,
    run_id: str,
    label: str | None,
    child_key: str | None,
    outcome: str,
) -> tuple[bool, str | None, int]:
    conditions: list[str] = []
    run_q = sql_quote(run_id)
    label_q = sql_quote(label)
    child_q = sql_quote(child_key)

    if run_id:
        conditions.append(f"run_id='{run_q}'")
        conditions.append(f"COALESCE(metadata->>'subagent_run_id','')='{run_q}'")
    if label:
        conditions.append(f"assigned_to='{label_q}'")
        conditions.append(f"COALESCE(metadata->>'subagent_label','')='{label_q}'")
    if child_key:
        conditions.append(f"assigned_to='{child_q}'")
        conditions.append(f"COALESCE(metadata->>'subagent_session_key','')='{child_q}'")

    if not conditions:
        return True, None, 0

    outcome_q = sql_quote(outcome)
    sql = (
        "UPDATE cortana_tasks SET "
        f"status='ready', outcome='{outcome_q}', updated_at=NOW() "
        "WHERE status='in_progress' AND ("
        + " OR ".join(conditions)
        + ") RETURNING id;"
    )
    proc = subprocess.run([psql_bin, DB_NAME, "-X", "-t", "-A", "-c", sql], capture_output=True, text=True)
    if proc.returncode != 0:
        return False, (proc.stderr.strip() or proc.stdout.strip() or "task update failed"), 0

    rows = [line.strip() for line in (proc.stdout or "").splitlines() if line.strip()]
    return True, None, len(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description="Reap stale sub-agent runs and sync task board")
    parser.add_argument("--max-age-hours", type=float, default=2.0)
    parser.add_argument("--dry-run", action="store_true", default=False)
    parser.add_argument("--emit-json", action="store_true", default=False)
    args = parser.parse_args()

    now = now_ms()
    max_age_ms = int(args.max_age_hours * 3600 * 1000)

    output: dict[str, Any] = {
        "ok": True,
        "timestamp": iso_from_ms(now),
        "config": {
            "maxAgeHours": args.max_age_hours,
            "dryRun": args.dry_run,
        },
        "summary": {
            "runsScanned": 0,
            "staleCandidates": 0,
            "reapedRuns": 0,
            "eventsLogged": 0,
            "tasksReset": 0,
            "errors": 0,
        },
        "reaped": [],
        "errors": [],
    }

    payload = load_json(RUN_STORE_PATH, {})
    if not isinstance(payload, dict):
        output["ok"] = False
        output["error"] = "runs.json payload is not an object"
        if args.emit_json:
            print(json.dumps(output, indent=2))
        else:
            print("reaper: runs.json payload invalid")
        return 1

    runs = payload.get("runs")
    if not isinstance(runs, dict):
        output["ok"] = False
        output["error"] = "runs.json missing runs map"
        if args.emit_json:
            print(json.dumps(output, indent=2))
        else:
            print("reaper: runs.json missing runs map")
        return 1

    output["summary"]["runsScanned"] = len(runs)

    try:
        session_data = run_sessions(ACTIVE_MINUTES)
        sessions: list[dict[str, Any]] = list(session_data.get("sessions") or [])
    except Exception as e:
        output["ok"] = False
        output["error"] = str(e)
        if args.emit_json:
            print(json.dumps(output, indent=2))
        else:
            print(f"reaper: {e}")
        return 1

    active_ids: set[str] = set()
    for session in sessions:
        if isinstance(session, dict):
            active_ids.update(collect_session_ids(session))

    psql_bin = resolve_psql()
    changed = False

    for run_key, run in runs.items():
        if not isinstance(run, dict):
            continue

        status = str(run.get("status") or "").strip().lower()
        if status not in STALE_STATUSES:
            continue

        started_at = run.get("startedAt")
        if not isinstance(started_at, (int, float)):
            continue

        age_ms = int(now - int(started_at))
        if age_ms <= max_age_ms:
            continue

        output["summary"]["staleCandidates"] += 1
        run_ids = collect_run_ids(run)
        is_active = any(run_id in active_ids for run_id in run_ids)

        if is_active:
            continue

        label = run.get("label")
        run_id = str(run.get("runId") or "")
        child_key = str(run.get("childSessionKey") or "")
        age_hours = round(age_ms / 3600000, 2)

        outcome_text = (
            "Reaped stale sub-agent session "
            f"{label or child_key or run_id or run_key} "
            f"after {age_hours}h without activity."
        )

        entry = {
            "runKey": run_key,
            "runId": run_id or None,
            "childSessionKey": child_key or None,
            "label": label,
            "startedAt": iso_from_ms(int(started_at)),
            "ageHours": age_hours,
            "endedAt": iso_from_ms(now),
        }

        if not args.dry_run:
            run["endedAt"] = now
            run["endedReason"] = "reaped_stale"
            run["status"] = "failed"
            outcome = run.get("outcome") if isinstance(run.get("outcome"), dict) else {}
            outcome["status"] = "failed"
            run["outcome"] = outcome
            runs[run_key] = run
            changed = True

            metadata = {
                "run_key": run_key,
                "run_id": run_id or None,
                "child_session_key": child_key or None,
                "label": label,
                "started_at": entry["startedAt"],
                "ended_at": entry["endedAt"],
                "age_hours": age_hours,
                "reason": "reaped_stale",
            }

            event_ok, event_err = log_reaped_event(
                psql_bin=psql_bin,
                metadata=metadata,
                message=f"Sub-agent run reaped: {label or child_key or run_id or run_key}",
            )
            entry["eventLogged"] = bool(event_ok)
            if event_ok:
                output["summary"]["eventsLogged"] += 1
            elif event_err:
                output["summary"]["errors"] += 1
                output["errors"].append({"runKey": run_key, "error": f"event_log_failed: {event_err}"})

            task_ok, task_err, task_count = reset_tasks(
                psql_bin=psql_bin,
                run_id=run_id,
                label=label,
                child_key=child_key,
                outcome=outcome_text,
            )
            entry["tasksReset"] = task_count
            if task_ok:
                output["summary"]["tasksReset"] += task_count
            else:
                output["summary"]["errors"] += 1
                output["errors"].append({"runKey": run_key, "error": f"task_reset_failed: {task_err}"})
        else:
            entry["eventLogged"] = False
            entry["tasksReset"] = 0

        output["summary"]["reapedRuns"] += 1
        output["reaped"].append(entry)

    if changed and not args.dry_run:
        save_json(RUN_STORE_PATH, payload)

    if args.emit_json:
        print(json.dumps(output, indent=2))
    else:
        summary = output["summary"]
        print(
            "reaper: scanned={runsScanned} stale={staleCandidates} reaped={reapedRuns} "
            "tasks_reset={tasksReset} events={eventsLogged} errors={errors}".format(**summary)
        )

    return 0 if output.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
