#!/usr/bin/env python3
"""System validation suite for critical OpenClaw paths."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]
PSQL = Path("/opt/homebrew/opt/postgresql@17/bin/psql")
DB_NAME = "cortana"

RUNTIME_JOBS = Path.home() / ".openclaw/cron/jobs.json"
REPO_JOBS = REPO_ROOT / "config/cron/jobs.json"

MEMORY_FILES = ["MEMORY.md", "SOUL.md", "USER.md", "IDENTITY.md"]

REQUIRED_DB_TABLES = [
    "cortana_events",
    "cortana_tasks",
    "cortana_epics",
    "cortana_feedback",
    "cortana_patterns",
    "cortana_self_model",
]

REQUIRED_TOOLS = [
    "tools/subagent-watchdog/check-subagents.sh",
    "tools/heartbeat/validate-heartbeat-state.sh",
    "tools/session-reconciler/reconcile-sessions.sh",
]

OPTIONAL_TOOLS = [
    "tools/task-board/completion-sync.sh",
    "tools/reaper/reaper.sh",
    "tools/notifications/telegram-delivery-guard.sh",
]


def run(cmd: List[str], cwd: Path | None = None) -> Tuple[int, str, str]:
    proc = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def make_check(name: str) -> Dict[str, Any]:
    return {"name": name, "status": "pass", "passed": True, "details": {}}


def fail(check: Dict[str, Any], message: str) -> None:
    check["status"] = "fail"
    check["passed"] = False
    check["message"] = message


def warn(check: Dict[str, Any], message: str) -> None:
    if check["status"] != "fail":
        check["status"] = "warn"
    check["message"] = message


def check_symlink(fix: bool) -> Dict[str, Any]:
    check = make_check("symlink_integrity")
    expected_target = str(REPO_JOBS)
    details = {
        "path": str(RUNTIME_JOBS),
        "expected_target": expected_target,
        "exists": RUNTIME_JOBS.exists() or RUNTIME_JOBS.is_symlink(),
    }

    if RUNTIME_JOBS.is_symlink():
        actual_target = os.readlink(RUNTIME_JOBS)
        resolved = str(RUNTIME_JOBS.resolve()) if RUNTIME_JOBS.exists() else None
        details.update({"actual_target": actual_target, "resolved_target": resolved})
        if resolved != expected_target:
            if fix:
                RUNTIME_JOBS.parent.mkdir(parents=True, exist_ok=True)
                RUNTIME_JOBS.unlink(missing_ok=True)
                RUNTIME_JOBS.symlink_to(REPO_JOBS)
                details["fixed"] = True
                details["actual_target"] = str(REPO_JOBS)
                details["resolved_target"] = str(REPO_JOBS)
            else:
                fail(check, "Symlink points to the wrong target")
        elif not RUNTIME_JOBS.exists():
            fail(check, "Symlink exists but target is broken/missing")
    else:
        details["is_symlink"] = False
        if fix:
            RUNTIME_JOBS.parent.mkdir(parents=True, exist_ok=True)
            if RUNTIME_JOBS.exists():
                RUNTIME_JOBS.unlink()
            RUNTIME_JOBS.symlink_to(REPO_JOBS)
            details["fixed"] = True
            details["actual_target"] = str(REPO_JOBS)
            details["resolved_target"] = str(REPO_JOBS)
        else:
            fail(check, "jobs.json is missing or not a symlink")

    check["details"] = details
    return check


def check_cron_definitions() -> Dict[str, Any]:
    check = make_check("cron_definitions")
    details: Dict[str, Any] = {"path": str(REPO_JOBS), "required_fields": ["name", "schedule", "enabled", "command"]}

    if not REPO_JOBS.exists():
        fail(check, "config/cron/jobs.json is missing")
        check["details"] = details
        return check

    try:
        data = json.loads(REPO_JOBS.read_text())
    except Exception as exc:
        fail(check, f"Invalid JSON: {exc}")
        check["details"] = details
        return check

    jobs = data.get("jobs") if isinstance(data, dict) else None
    if not isinstance(jobs, list):
        fail(check, "jobs.json must contain a top-level 'jobs' array")
        check["details"] = details
        return check

    missing_required = []
    missing_model = []
    for idx, job in enumerate(jobs):
        if not isinstance(job, dict):
            missing_required.append({"index": idx, "name": None, "missing": ["<job is not an object>"]})
            continue
        job_name = job.get("name", f"index:{idx}")
        missing = [k for k in ["name", "schedule", "enabled", "command"] if k not in job]
        if missing:
            missing_required.append({"index": idx, "name": job_name, "missing": missing})

        has_model = "model" in job
        payload_model = isinstance(job.get("payload"), dict) and "model" in job["payload"]
        if not (has_model or payload_model):
            missing_model.append({"index": idx, "name": job_name})

    details.update(
        {
            "job_count": len(jobs),
            "missing_required": missing_required,
            "missing_model": missing_model,
        }
    )

    if missing_required:
        fail(check, "One or more cron jobs are missing required fields")
    elif missing_model:
        warn(check, "One or more cron jobs are missing a model field")

    check["details"] = details
    return check


def check_db_connectivity() -> Dict[str, Any]:
    check = make_check("db_connectivity")
    details: Dict[str, Any] = {
        "psql_path": str(PSQL),
        "database": DB_NAME,
        "required_tables": REQUIRED_DB_TABLES,
    }

    if not PSQL.exists():
        fail(check, "psql binary not found")
        check["details"] = details
        return check

    rc, out, err = run([str(PSQL), DB_NAME, "-t", "-A", "-c", "SELECT 1;"])
    details["connect_stdout"] = out
    if rc != 0:
        fail(check, f"Cannot connect to PostgreSQL/{DB_NAME}: {err or out}")
        check["details"] = details
        return check

    sql = (
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema='public' AND table_name = ANY(ARRAY[" + ",".join(f"'{t}'" for t in REQUIRED_DB_TABLES) + "])"
    )
    rc, out, err = run([str(PSQL), DB_NAME, "-t", "-A", "-c", sql])
    if rc != 0:
        fail(check, f"Failed checking required tables: {err or out}")
        check["details"] = details
        return check

    found = sorted([line.strip() for line in out.splitlines() if line.strip()])
    missing = sorted(set(REQUIRED_DB_TABLES) - set(found))
    details.update({"found_tables": found, "missing_tables": missing})

    if missing:
        fail(check, "Database is reachable but missing required tables")

    check["details"] = details
    return check


def check_critical_tools() -> Dict[str, Any]:
    check = make_check("critical_tools")
    details: Dict[str, Any] = {"required": [], "optional": []}

    missing_or_not_exec = []

    for rel in REQUIRED_TOOLS:
        p = REPO_ROOT / rel
        exists = p.exists()
        executable = os.access(p, os.X_OK)
        item = {"path": rel, "exists": exists, "executable": executable, "required": True}
        details["required"].append(item)
        if not exists or not executable:
            missing_or_not_exec.append(rel)

    for rel in OPTIONAL_TOOLS:
        p = REPO_ROOT / rel
        exists = p.exists()
        executable = os.access(p, os.X_OK) if exists else None
        item = {"path": rel, "exists": exists, "executable": executable, "required": False}
        details["optional"].append(item)

    if missing_or_not_exec:
        fail(check, f"Missing or non-executable required tools: {', '.join(missing_or_not_exec)}")

    check["details"] = details
    return check


def check_heartbeat_state() -> Dict[str, Any]:
    check = make_check("heartbeat_state")
    path = REPO_ROOT / "memory/heartbeat-state.json"
    details: Dict[str, Any] = {"path": str(path)}

    if not path.exists():
        fail(check, "heartbeat-state.json is missing")
        check["details"] = details
        return check

    try:
        data = json.loads(path.read_text())
    except Exception as exc:
        fail(check, f"Invalid heartbeat-state JSON: {exc}")
        check["details"] = details
        return check

    version = data.get("version") if isinstance(data, dict) else None
    details["version"] = version

    if not isinstance(version, (int, float)) or version < 2:
        fail(check, "heartbeat-state version must be >= 2")

    check["details"] = details
    return check


def check_memory_files() -> Dict[str, Any]:
    check = make_check("memory_files")
    details: Dict[str, Any] = {"files": []}
    bad = []

    for fname in MEMORY_FILES:
        p = REPO_ROOT / fname
        exists = p.exists()
        size = p.stat().st_size if exists else 0
        non_empty = size > 0
        details["files"].append({"path": fname, "exists": exists, "size": size, "non_empty": non_empty})
        if not exists or not non_empty:
            bad.append(fname)

    if bad:
        fail(check, f"Missing or empty memory files: {', '.join(bad)}")

    check["details"] = details
    return check


def check_git_status() -> Dict[str, Any]:
    check = make_check("git_status")
    details: Dict[str, Any] = {}

    rc, out, err = run(["git", "status", "--porcelain"], cwd=REPO_ROOT)
    if rc != 0:
        fail(check, f"git status failed: {err or out}")
        check["details"] = details
        return check

    modified = 0
    untracked = 0
    for line in out.splitlines():
        if not line.strip():
            continue
        if line.startswith("??"):
            untracked += 1
        else:
            modified += 1

    details.update(
        {
            "modified_count": modified,
            "untracked_count": untracked,
            "total_changes": modified + untracked,
            "clean": (modified + untracked) == 0,
        }
    )

    check["details"] = details
    return check


def check_disk_space() -> Dict[str, Any]:
    check = make_check("disk_space")
    usage = shutil.disk_usage("/")
    free_gb = usage.free / (1024 ** 3)
    total_gb = usage.total / (1024 ** 3)
    details = {
        "mount": "/",
        "free_bytes": usage.free,
        "free_gb": round(free_gb, 2),
        "total_gb": round(total_gb, 2),
        "threshold_gb": 5,
    }

    if free_gb < 5:
        warn(check, "Free disk space is below 5GB")

    check["details"] = details
    return check


def _parse_simple_step(field: str) -> int | None:
    if field.startswith("*/"):
        try:
            return int(field[2:])
        except ValueError:
            return None
    return None


def _parse_int_list(field: str, min_v: int, max_v: int) -> List[int] | None:
    if not field or "*" in field or "/" in field:
        return None
    out = []
    for part in field.split(","):
        part = part.strip()
        if not part.isdigit():
            return None
        v = int(part)
        if v < min_v or v > max_v:
            return None
        out.append(v)
    return sorted(set(out)) if out else None


def _estimate_interval_ms(expr: str) -> int | None:
    parts = expr.split()
    if len(parts) < 5:
        return None

    minute, hour = parts[0], parts[1]

    minute_step = _parse_simple_step(minute)
    hour_step = _parse_simple_step(hour)

    if hour_step and hour_step > 0:
        return hour_step * 60 * 60 * 1000

    hour_values = _parse_int_list(hour, 0, 23)
    if hour_values:
        if len(hour_values) == 1:
            return 24 * 60 * 60 * 1000
        diffs = []
        for i in range(len(hour_values)):
            cur = hour_values[i]
            nxt = hour_values[(i + 1) % len(hour_values)]
            diff_hours = (nxt - cur) % 24
            if diff_hours == 0:
                continue
            diffs.append(diff_hours)
        if diffs:
            return min(diffs) * 60 * 60 * 1000

    if hour == "*":
        if minute_step and minute_step > 0:
            return minute_step * 60 * 1000
        minute_values = _parse_int_list(minute, 0, 59)
        if minute_values:
            if len(minute_values) == 1:
                return 60 * 60 * 1000
            diffs = []
            for i in range(len(minute_values)):
                cur = minute_values[i]
                nxt = minute_values[(i + 1) % len(minute_values)]
                diff_minutes = (nxt - cur) % 60
                if diff_minutes == 0:
                    continue
                diffs.append(diff_minutes)
            if diffs:
                return min(diffs) * 60 * 1000
        return 60 * 60 * 1000

    return None


def check_cron_staleness(fix: bool) -> Dict[str, Any]:
    check = make_check("cron_staleness")
    details: Dict[str, Any] = {"path": str(RUNTIME_JOBS), "late_jobs": [], "fix_attempts": []}

    if not RUNTIME_JOBS.exists():
        fail(check, "Runtime cron jobs file is missing")
        check["details"] = details
        return check

    try:
        data = json.loads(RUNTIME_JOBS.read_text())
    except Exception as exc:
        fail(check, f"Invalid runtime jobs JSON: {exc}")
        check["details"] = details
        return check

    jobs = data.get("jobs") if isinstance(data, dict) else None
    if not isinstance(jobs, list):
        fail(check, "Runtime jobs.json must contain a top-level 'jobs' array")
        check["details"] = details
        return check

    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    details["now_ms"] = now_ms
    details["job_count"] = len(jobs)

    enabled_count = 0
    analyzed_count = 0

    for idx, job in enumerate(jobs):
        if not isinstance(job, dict):
            continue
        if not job.get("enabled", False):
            continue

        enabled_count += 1
        job_id = str(job.get("id") or job.get("name") or f"index:{idx}")
        schedule = job.get("schedule") if isinstance(job.get("schedule"), dict) else {}
        expr = schedule.get("expr") if isinstance(schedule, dict) else None
        state = job.get("state") if isinstance(job.get("state"), dict) else {}

        if not isinstance(expr, str) or not expr.strip():
            continue

        expected_interval_ms = _estimate_interval_ms(expr.strip())
        if not expected_interval_ms:
            continue

        last_run_at = state.get("lastRunAt")
        if not isinstance(last_run_at, (int, float)):
            last_run_at = state.get("lastFiredAt")
        if not isinstance(last_run_at, (int, float)):
            continue

        analyzed_count += 1
        lag_ms = max(0, now_ms - int(last_run_at))
        stale_threshold_ms = expected_interval_ms * 2

        if lag_ms > stale_threshold_ms:
            late_by_ms = lag_ms - stale_threshold_ms
            late_job = {
                "id": job_id,
                "name": job.get("name"),
                "expr": expr,
                "last_run_at_ms": int(last_run_at),
                "lag_ms": lag_ms,
                "expected_interval_ms": expected_interval_ms,
                "stale_threshold_ms": stale_threshold_ms,
                "late_by_ms": late_by_ms,
            }
            details["late_jobs"].append(late_job)

    details["enabled_jobs"] = enabled_count
    details["analyzed_jobs"] = analyzed_count

    if details["late_jobs"]:
        if fix:
            for item in details["late_jobs"]:
                rc, out, err = run(["openclaw", "cron", "run", item["id"]])
                details["fix_attempts"].append(
                    {
                        "id": item["id"],
                        "rc": rc,
                        "stdout": out,
                        "stderr": err,
                        "ok": rc == 0,
                    }
                )
            failed_fixes = [x for x in details["fix_attempts"] if not x["ok"]]
            if failed_fixes:
                warn(check, f"Found {len(details['late_jobs'])} stale job(s); some fix attempts failed")
            else:
                warn(check, f"Found and force-ran {len(details['late_jobs'])} stale job(s)")
        else:
            warn(check, f"Found {len(details['late_jobs'])} stale cron job(s)")

    check["details"] = details
    return check


def summarize(checks: List[Dict[str, Any]]) -> Dict[str, Any]:
    failed = sum(1 for c in checks if c["status"] == "fail")
    warned = sum(1 for c in checks if c["status"] == "warn")
    passed = sum(1 for c in checks if c["status"] == "pass")
    overall_ok = failed == 0
    return {
        "overall_ok": overall_ok,
        "counts": {
            "pass": passed,
            "warn": warned,
            "fail": failed,
            "total": len(checks),
        },
    }


def print_human(report: Dict[str, Any], verbose: bool) -> None:
    print("OpenClaw System Validation")
    print("=" * 28)
    print(f"Timestamp: {report['timestamp']}")
    print(f"Repo: {report['repo_root']}")
    print()

    for c in report["checks"]:
        icon = {"pass": "✅", "warn": "⚠️", "fail": "❌"}.get(c["status"], "•")
        print(f"{icon} {c['name']}: {c['status'].upper()}")
        if c.get("message"):
            print(f"   {c['message']}")
        if verbose:
            print("   details:")
            print("   " + json.dumps(c.get("details", {}), indent=2).replace("\n", "\n   "))

    counts = report["summary"]["counts"]
    print()
    print(
        f"Result: {'PASS' if report['summary']['overall_ok'] else 'FAIL'} "
        f"(pass={counts['pass']}, warn={counts['warn']}, fail={counts['fail']})"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate OpenClaw system critical paths")
    parser.add_argument("--json", action="store_true", help="Emit structured JSON output")
    parser.add_argument("--fix", action="store_true", help="Auto-fix issues where possible")
    parser.add_argument("--verbose", action="store_true", help="Include detailed check output")
    args = parser.parse_args()

    checks = [
        check_symlink(fix=args.fix),
        check_cron_definitions(),
        check_db_connectivity(),
        check_critical_tools(),
        check_heartbeat_state(),
        check_memory_files(),
        check_git_status(),
        check_disk_space(),
    ]

    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "repo_root": str(REPO_ROOT),
        "options": {"json": args.json, "fix": args.fix, "verbose": args.verbose},
        "checks": checks,
    }
    report["summary"] = summarize(checks)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print_human(report, verbose=args.verbose)

    return 0 if report["summary"]["overall_ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
