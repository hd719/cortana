#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Tuple

PSQL_BIN = "/opt/homebrew/opt/postgresql@17/bin/psql"
JOBS_FILE = Path.home() / ".openclaw/cron/jobs.json"
HEARTBEAT_STATE_FILE = Path.home() / "clawd/memory/heartbeat-state.json"
REMEDIATION_STATE_FILE = Path.home() / "clawd/proprioception/state/heartbeat-remediation.json"

REMEDIATION_COOLDOWN_SEC = 30 * 60
MAX_REMEDIATIONS_PER_DAY = 3
STALE_RUNNING_FALLBACK_MS = 45 * 60 * 1000
HEARTBEAT_STATE_STALE_SEC = 8 * 60 * 60


def run_cmd(cmd: str, timeout: int) -> Dict[str, Any]:
    """Run shell command with timeout, return status, duration ms, stderr/stdout snippet."""
    start = time.perf_counter()
    try:
        proc = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        duration_ms = int((time.perf_counter() - start) * 1000)
        ok = proc.returncode == 0
        output = (proc.stderr or "").strip()
        if not output and not ok:
            output = (proc.stdout or "").strip()
        return {"ok": ok, "duration_ms": duration_ms, "error": output[:500] if output else None}
    except subprocess.TimeoutExpired as e:
        duration_ms = int((time.perf_counter() - start) * 1000)
        output = (e.stderr or e.stdout or "timeout").strip()
        return {"ok": False, "duration_ms": duration_ms, "error": (output[:500] or "timeout")}


def sql_escape(val: str) -> str:
    return val.replace("'", "''") if val else ""


def collect_tool_health() -> List[Dict[str, Any]]:
    results = []

    # postgres
    pg = run_cmd(f"{PSQL_BIN} cortana -c 'SELECT 1'", timeout=10)
    results.append({
        "tool_name": "postgres",
        "status": "up" if pg["ok"] else "down",
        "response_ms": pg["duration_ms"],
        "error": pg["error"],
        "self_healed": False,
    })

    # whoop
    whoop = run_cmd("curl -s --max-time 10 http://localhost:3033/whoop/data > /dev/null", timeout=12)
    results.append({
        "tool_name": "whoop",
        "status": "up" if whoop["ok"] else "down",
        "response_ms": whoop["duration_ms"],
        "error": whoop["error"],
        "self_healed": False,
    })

    # tonal
    tonal = run_cmd("curl -s --max-time 10 http://localhost:3033/tonal/health | head -c 200", timeout=12)
    results.append({
        "tool_name": "tonal",
        "status": "up" if tonal["ok"] else "down",
        "response_ms": tonal["duration_ms"],
        "error": tonal["error"],
        "self_healed": False,
    })

    # gog (quick auth check)
    gog = run_cmd("gog --account hameldesai3@gmail.com gmail search 'newer_than:1d' --max 1 > /dev/null", timeout=15)
    results.append({
        "tool_name": "gog",
        "status": "up" if gog["ok"] else "down",
        "response_ms": gog["duration_ms"],
        "error": gog["error"],
        "self_healed": False,
    })

    # weather with fallback
    wttr = run_cmd("curl -s --max-time 5 'https://wttr.in/?format=3' > /dev/null", timeout=7)
    if wttr["ok"]:
        results.append({
            "tool_name": "weather",
            "status": "up",
            "response_ms": wttr["duration_ms"],
            "error": None,
            "self_healed": False,
        })
    else:
        fallback = run_cmd("curl -s --max-time 5 'https://api.open-meteo.com/v1/forecast?latitude=40.63&longitude=-74.49&current_weather=true&temperature_unit=fahrenheit' > /dev/null", timeout=7)
        results.append({
            "tool_name": "weather",
            "status": "up" if fallback["ok"] else "down",
            "response_ms": fallback["duration_ms"],
            "error": wttr["error"] if fallback["ok"] else fallback["error"],
            "self_healed": fallback["ok"],
        })

    return results


def load_jobs() -> List[Dict[str, Any]]:
    if not JOBS_FILE.exists():
        return []
    return json.loads(JOBS_FILE.read_text()).get("jobs", [])


def estimate_interval_ms(job: Dict[str, Any], state: Dict[str, Any], sched: Dict[str, Any]) -> int:
    if sched.get("kind") == "every":
        return int(sched.get("everyMs") or 0)
    if sched.get("kind") == "cron":
        next_run = state.get("nextRunAtMs")
        last_run = state.get("lastRunAtMs") or state.get("lastRunAt")
        if next_run and last_run:
            return int(max(next_run - last_run, 0))
        return 3600000
    return 0


def collect_cron_health(jobs: List[Dict[str, Any]], now_ms: int) -> List[Dict[str, Any]]:
    results = []
    for job in jobs:
        if not job.get("enabled", False):
            continue
        state = job.get("state", {}) or {}
        sched = job.get("schedule", {}) or {}
        last_run = state.get("lastRunAtMs") or state.get("lastRunAt")
        last_status = state.get("lastStatus") or state.get("lastRunStatus")
        duration_ms = state.get("lastDurationMs")
        consecutive_errors = state.get("consecutiveErrors") or 0

        status = "ok"
        interval_ms = estimate_interval_ms(job, state, sched)

        if not last_run:
            # One-time jobs that are scheduled for the future should not be marked missed.
            if sched.get("kind") == "at":
                at_iso = sched.get("at")
                next_run = state.get("nextRunAtMs")
                if next_run and int(next_run) > now_ms:
                    status = "ok"
                elif at_iso:
                    try:
                        at_epoch_ms = int(datetime.fromisoformat(at_iso.replace("Z", "+00:00")).timestamp() * 1000)
                        status = "ok" if at_epoch_ms > now_ms else "missed"
                    except Exception:
                        status = "missed"
                else:
                    status = "missed"
            else:
                status = "missed"
        elif last_status and last_status not in {"ok", "skipped"}:
            status = "failed"
        elif interval_ms > 0 and (now_ms - int(last_run)) > interval_ms * 2:
            status = "missed"

        results.append({
            "cron_name": job.get("name", "unknown"),
            "status": status,
            "consecutive_failures": consecutive_errors,
            "run_duration_sec": (duration_ms or 0) / 1000.0,
            "metadata": {
                "id": job.get("id"),
                "last_run_ms": last_run,
                "last_status": last_status,
                "interval_ms": interval_ms,
            },
        })
    return results


def is_heartbeat_job(job: Dict[str, Any]) -> bool:
    name = (job.get("name") or "").lower()
    message = ((job.get("payload") or {}).get("message") or "").lower()
    return "heartbeat" in name or "heartbeat_ok" in message or "read heartbeat.md" in message


def load_remediation_state() -> Dict[str, Any]:
    if not REMEDIATION_STATE_FILE.exists():
        return {"jobs": {}}
    try:
        data = json.loads(REMEDIATION_STATE_FILE.read_text())
        if isinstance(data, dict) and isinstance(data.get("jobs"), dict):
            return data
    except Exception:
        pass
    return {"jobs": {}}


def save_remediation_state(state: Dict[str, Any]) -> None:
    REMEDIATION_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    REMEDIATION_STATE_FILE.write_text(json.dumps(state, indent=2) + "\n")


def ensure_heartbeat_state_file(now: int) -> Tuple[bool, str]:
    HEARTBEAT_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)

    if not HEARTBEAT_STATE_FILE.exists():
        HEARTBEAT_STATE_FILE.write_text(json.dumps({"lastChecks": {}, "lastRemediationAt": now}, indent=2) + "\n")
        return True, "created_missing_state_file"

    try:
        data = json.loads(HEARTBEAT_STATE_FILE.read_text())
        if not isinstance(data, dict):
            raise ValueError("state file not a JSON object")
        changed = False
        if "lastChecks" not in data or not isinstance(data.get("lastChecks"), dict):
            data["lastChecks"] = {}
            changed = True
        data["lastRemediationAt"] = now
        changed = True
        if changed:
            HEARTBEAT_STATE_FILE.write_text(json.dumps(data, indent=2) + "\n")
        stale = (time.time() - HEARTBEAT_STATE_FILE.stat().st_mtime) > HEARTBEAT_STATE_STALE_SEC
        return True, "refreshed_state_file_stale" if stale else "state_file_verified"
    except Exception:
        HEARTBEAT_STATE_FILE.write_text(json.dumps({"lastChecks": {}, "lastRemediationAt": now}, indent=2) + "\n")
        return True, "repaired_corrupt_state_file"


def remediate_heartbeat_misses(jobs: List[Dict[str, Any]], cron_rows: List[Dict[str, Any]], now_ms: int, dry_run: bool = False) -> Tuple[List[Dict[str, Any]], bool]:
    row_by_id = {row.get("metadata", {}).get("id"): row for row in cron_rows}
    hb_jobs = [j for j in jobs if j.get("enabled") and is_heartbeat_job(j)]
    if not hb_jobs:
        return [], False

    rem_state = load_remediation_state()
    rem_jobs = rem_state.setdefault("jobs", {})
    now_sec = int(now_ms / 1000)
    changed_jobs_file = False
    events: List[Dict[str, Any]] = []

    for job in hb_jobs:
        job_id = job.get("id")
        if not job_id:
            continue

        cron_row = row_by_id.get(job_id)
        status = (cron_row or {}).get("status", "ok")
        consecutive = (cron_row or {}).get("consecutive_failures", 0)

        state = job.setdefault("state", {})
        interval_ms = estimate_interval_ms(job, state, job.get("schedule", {}) or {})
        running_at = state.get("runningAtMs")
        stale_running = bool(running_at and (now_ms - int(running_at)) > (max(interval_ms * 2, STALE_RUNNING_FALLBACK_MS)))

        miss_detected = status in {"missed", "failed"} or consecutive >= 2 or stale_running
        if not miss_detected:
            continue

        hist = rem_jobs.setdefault(job_id, {"attempts": [], "last_attempt": 0})
        last_attempt = int(hist.get("last_attempt", 0))
        recent_attempts = [a for a in hist.get("attempts", []) if now_sec - int(a) <= 86400]
        hist["attempts"] = recent_attempts

        events.append({
            "event_type": "heartbeat_miss_detected",
            "source": "proprioception",
            "severity": "warning",
            "message": f"Heartbeat miss detected for job '{job.get('name', 'unknown')}'",
            "metadata": {
                "job_id": job_id,
                "job_name": job.get("name"),
                "status": status,
                "consecutive_failures": consecutive,
                "stale_running": stale_running,
                "interval_ms": interval_ms,
            },
        })

        cooldown_active = (now_sec - last_attempt) < REMEDIATION_COOLDOWN_SEC
        too_many_attempts = len(recent_attempts) >= MAX_REMEDIATIONS_PER_DAY

        if cooldown_active or too_many_attempts:
            events.append({
                "event_type": "heartbeat_auto_remediation",
                "source": "proprioception",
                "severity": "info",
                "message": "Skipped remediation due to guardrail",
                "metadata": {
                    "job_id": job_id,
                    "job_name": job.get("name"),
                    "reason": "cooldown" if cooldown_active else "max_attempts_24h",
                    "last_attempt": last_attempt,
                    "attempts_24h": len(recent_attempts),
                },
            })
            continue

        actions = []
        if stale_running:
            state.pop("runningAtMs", None)
            actions.append("cleared_stale_runningAtMs")
            changed_jobs_file = True

        state["nextRunAtMs"] = now_ms + 60_000
        actions.append("scheduled_next_run_in_60s")
        changed_jobs_file = True

        ensured, state_action = ensure_heartbeat_state_file(now_sec)
        if ensured:
            actions.append(state_action)

        hist["last_attempt"] = now_sec
        hist["attempts"].append(now_sec)

        events.append({
            "event_type": "heartbeat_auto_remediation",
            "source": "proprioception",
            "severity": "info",
            "message": f"Applied heartbeat auto-remediation for job '{job.get('name', 'unknown')}'",
            "metadata": {
                "job_id": job_id,
                "job_name": job.get("name"),
                "actions": actions,
                "attempts_24h": len(hist["attempts"]),
            },
        })

    # Secondary signal: heartbeat state file stale/missing/corrupt.
    state_file_hist = rem_jobs.setdefault("__state_file__", {"attempts": [], "last_attempt": 0})
    state_file_recent = [a for a in state_file_hist.get("attempts", []) if now_sec - int(a) <= 86400]
    state_file_hist["attempts"] = state_file_recent
    state_file_last = int(state_file_hist.get("last_attempt", 0))

    state_issue = False
    state_reason = None
    if not HEARTBEAT_STATE_FILE.exists():
        state_issue, state_reason = True, "missing"
    else:
        try:
            json.loads(HEARTBEAT_STATE_FILE.read_text())
            if (time.time() - HEARTBEAT_STATE_FILE.stat().st_mtime) > HEARTBEAT_STATE_STALE_SEC:
                state_issue, state_reason = True, "stale"
        except Exception:
            state_issue, state_reason = True, "corrupt"

    if state_issue:
        events.append({
            "event_type": "heartbeat_miss_detected",
            "source": "proprioception",
            "severity": "warning",
            "message": "Heartbeat state signal indicates a miss",
            "metadata": {"reason": state_reason, "path": str(HEARTBEAT_STATE_FILE)},
        })

        state_cooldown = (now_sec - state_file_last) < REMEDIATION_COOLDOWN_SEC
        state_too_many = len(state_file_recent) >= MAX_REMEDIATIONS_PER_DAY
        if state_cooldown or state_too_many:
            events.append({
                "event_type": "heartbeat_auto_remediation",
                "source": "proprioception",
                "severity": "info",
                "message": "Skipped heartbeat state remediation due to guardrail",
                "metadata": {
                    "reason": "cooldown" if state_cooldown else "max_attempts_24h",
                    "attempts_24h": len(state_file_recent),
                },
            })
        else:
            ensured, state_action = ensure_heartbeat_state_file(now_sec)
            state_file_hist["last_attempt"] = now_sec
            state_file_hist["attempts"].append(now_sec)
            events.append({
                "event_type": "heartbeat_auto_remediation",
                "source": "proprioception",
                "severity": "info",
                "message": "Applied heartbeat state auto-remediation",
                "metadata": {"action": state_action, "ensured": ensured},
            })

    if not dry_run and changed_jobs_file:
        content = json.loads(JOBS_FILE.read_text()) if JOBS_FILE.exists() else {"version": 1, "jobs": []}
        content["jobs"] = jobs
        JOBS_FILE.write_text(json.dumps(content, indent=2) + "\n")

    if not dry_run:
        save_remediation_state(rem_state)

    return events, changed_jobs_file


def build_sql(tool_rows: List[Dict[str, Any]], cron_rows: List[Dict[str, Any]], events: List[Dict[str, Any]]) -> str:
    stmts = []
    for row in tool_rows:
        err_val = f"'{sql_escape(row['error'])}'" if row.get("error") else "NULL"
        stmts.append(
            "INSERT INTO cortana_tool_health (tool_name, status, response_ms, error, self_healed) "
            f"VALUES ('{sql_escape(row['tool_name'])}', '{row['status']}', {row['response_ms']}, {err_val}, {str(row['self_healed']).lower()});"
        )

    for row in cron_rows:
        md_json = json.dumps(row.get("metadata", {}))
        stmts.append(
            "INSERT INTO cortana_cron_health (cron_name, status, consecutive_failures, run_duration_sec, metadata) "
            f"VALUES ('{sql_escape(row['cron_name'])}', '{row['status']}', {row['consecutive_failures']}, {row['run_duration_sec']}, '{sql_escape(md_json)}');"
        )

    for event in events:
        md_json = json.dumps(event.get("metadata", {}))
        stmts.append(
            "INSERT INTO cortana_events (event_type, source, severity, message, metadata) "
            f"VALUES ('{sql_escape(event['event_type'])}', '{sql_escape(event['source'])}', '{sql_escape(event['severity'])}', "
            f"'{sql_escape(event['message'])}', '{sql_escape(md_json)}'::jsonb);"
        )

    return "\n".join(stmts)


def main():
    parser = argparse.ArgumentParser(description="Run cron/tool health checks and heartbeat auto-remediation")
    parser.add_argument("--dry-run", action="store_true", help="Do not write jobs/state files or DB rows")
    args = parser.parse_args()

    now_ms = int(time.time() * 1000)
    jobs = load_jobs()
    tool_rows = collect_tool_health()
    cron_rows = collect_cron_health(jobs, now_ms)
    events, _ = remediate_heartbeat_misses(jobs, cron_rows, now_ms, dry_run=args.dry_run)

    if args.dry_run:
        print(json.dumps({
            "tool_rows": len(tool_rows),
            "cron_rows": len(cron_rows),
            "events": events,
        }, indent=2))
        return

    sql = build_sql(tool_rows, cron_rows, events)
    if not sql.strip():
        return
    env = os.environ.copy()
    env.setdefault("PGHOST", "localhost")
    env.setdefault("PGUSER", os.environ.get("USER", "hd"))
    run = [PSQL_BIN, "cortana", "-v", "ON_ERROR_STOP=1", "-c", sql]
    result = subprocess.run(run, capture_output=True, text=True, env=env)
    if result.returncode != 0:
        raise SystemExit(f"psql insert failed: {result.stderr}\nSQL:\n{sql}")


if __name__ == "__main__":
    main()
