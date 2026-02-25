#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, time as dtime, timedelta
from pathlib import Path
from typing import Any, Callable

PSQL_BIN = "/opt/homebrew/opt/postgresql@17/bin/psql"
DEFAULT_TOKEN_FILE = Path(os.path.expanduser("~/.config/cortana/tokens/fitness.token"))
DEFAULT_CRON_OUTPUT = Path(os.path.expanduser("~/clawd/logs/heartbeat.log"))
DEFAULT_SESSION_DIR = Path(os.path.expanduser("~/.local/share/openclaw/sessions"))


@dataclass
class FailureResult:
    failure_type: str
    injected: bool
    healed: bool
    mttr_seconds: float | None
    evidence_source: str | None
    message: str
    details: dict[str, Any]


class Harness:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.run_id = str(uuid.uuid4())
        self.run_started = datetime.now()

    def run(self) -> int:
        if self.args.safe_window and not in_safe_window(self.args.safe_window, datetime.now()):
            print(f"Refusing to run: outside safe window {self.args.safe_window}", file=sys.stderr)
            return 2

        scenarios = [
            self._run_expired_token,
            self._run_missing_cron_output,
            self._run_stale_session_files,
        ]

        results: list[FailureResult] = []
        for scenario in scenarios:
            results.append(scenario())

        summary = self._summarize(results)
        self._persist(results, summary)
        self._print_report(results, summary)

        return 0 if summary["pass"] else 1

    def _run_expired_token(self) -> FailureResult:
        return self._execute_scenario(
            failure_type="expired_token_file",
            inject=lambda: inject_expired_token(DEFAULT_TOKEN_FILE),
            healed=lambda injected_at: token_is_repaired(DEFAULT_TOKEN_FILE, injected_at),
            event_keywords=["token", "refresh", "auto-fix", "watchdog", "immune"],
        )

    def _run_missing_cron_output(self) -> FailureResult:
        return self._execute_scenario(
            failure_type="missing_cron_output",
            inject=lambda: inject_missing_file(DEFAULT_CRON_OUTPUT),
            healed=lambda _injected_at: DEFAULT_CRON_OUTPUT.exists(),
            event_keywords=["cron", "output", "auto-fix", "watchdog", "immune"],
        )

    def _run_stale_session_files(self) -> FailureResult:
        return self._execute_scenario(
            failure_type="stale_session_files",
            inject=lambda: inject_stale_session(DEFAULT_SESSION_DIR, self.args.stale_hours),
            healed=lambda _injected_at: not has_stale_sessions(DEFAULT_SESSION_DIR, self.args.stale_hours),
            event_keywords=["session", "stale", "auto-fix", "watchdog", "immune"],
        )

    def _execute_scenario(
        self,
        failure_type: str,
        inject: Callable[[], dict[str, Any]],
        healed: Callable[[datetime], bool],
        event_keywords: list[str],
    ) -> FailureResult:
        start = datetime.now()
        if self.args.dry_run:
            simulated = min(5.0, self.args.wait_seconds / 3)
            return FailureResult(
                failure_type=failure_type,
                injected=False,
                healed=True,
                mttr_seconds=simulated,
                evidence_source="dry-run-simulation",
                message="Simulated only (--dry-run)",
                details={"simulated": True},
            )

        restore_info = inject()
        injected_at = datetime.now()

        try:
            if self.args.trigger_immune_scan:
                self._trigger_immune_scan()

            healed_at, source = self._wait_for_heal(injected_at, healed, failure_type, event_keywords)
            if healed_at:
                mttr = (healed_at - injected_at).total_seconds()
                return FailureResult(
                    failure_type=failure_type,
                    injected=True,
                    healed=True,
                    mttr_seconds=mttr,
                    evidence_source=source,
                    message=f"Healed in {mttr:.1f}s via {source}",
                    details={"injected_at": injected_at.isoformat()},
                )

            return FailureResult(
                failure_type=failure_type,
                injected=True,
                healed=False,
                mttr_seconds=None,
                evidence_source=None,
                message=f"No healing signal within {self.args.wait_seconds}s",
                details={"injected_at": injected_at.isoformat()},
            )
        finally:
            safe_restore(restore_info)
            _ = start

    def _wait_for_heal(
        self,
        injected_at: datetime,
        healed_assertion: Callable[[datetime], bool],
        failure_type: str,
        event_keywords: list[str],
    ) -> tuple[datetime | None, str | None]:
        deadline = time.time() + self.args.wait_seconds
        while time.time() < deadline:
            if healed_assertion(injected_at):
                return datetime.now(), "file-state"

            evt_ts = find_healing_event(injected_at, failure_type, event_keywords)
            if evt_ts:
                return evt_ts, "cortana_events"

            time.sleep(self.args.poll_seconds)

        return None, None

    def _trigger_immune_scan(self) -> None:
        immune_script = Path("/Users/hd/clawd/tools/immune_scan.sh")
        if not immune_script.exists():
            return
        subprocess.run(["bash", str(immune_script)], capture_output=True, text=True)

    def _summarize(self, results: list[FailureResult]) -> dict[str, Any]:
        mttr_by_type = {
            r.failure_type: r.mttr_seconds for r in results if r.mttr_seconds is not None
        }
        baseline = historical_mttr_baseline(days=self.args.baseline_days)
        regressions: dict[str, dict[str, Any]] = {}

        for failure_type, mttr in mttr_by_type.items():
            prev = baseline.get(failure_type)
            if prev is None or prev <= 0:
                continue
            regressed = mttr > (prev * self.args.regression_threshold)
            regressions[failure_type] = {
                "baseline_mttr": round(prev, 2),
                "current_mttr": round(mttr, 2),
                "threshold": self.args.regression_threshold,
                "regressed": regressed,
            }

        pass_state = all(r.healed for r in results) and not any(v["regressed"] for v in regressions.values())

        return {
            "run_id": self.run_id,
            "started_at": self.run_started.isoformat(),
            "dry_run": self.args.dry_run,
            "safe_window": self.args.safe_window,
            "mttr_seconds": mttr_by_type,
            "regressions": regressions,
            "pass": pass_state,
        }

    def _persist(self, results: list[FailureResult], summary: dict[str, Any]) -> None:
        for result in results:
            payload = {
                "run_id": self.run_id,
                "failure_type": result.failure_type,
                "injected": result.injected,
                "healed": result.healed,
                "mttr_seconds": result.mttr_seconds,
                "evidence_source": result.evidence_source,
                "details": result.details,
            }
            msg = f"resilience_harness_result:{result.failure_type}"
            insert_event("resilience_harness", "resilience_harness", "info", msg, payload)

        insert_event(
            "resilience_harness_summary",
            "resilience_harness",
            "info" if summary["pass"] else "warning",
            "resilience_harness_summary",
            summary,
        )

    def _print_report(self, results: list[FailureResult], summary: dict[str, Any]) -> None:
        report = {
            "run_id": self.run_id,
            "pass": summary["pass"],
            "dry_run": self.args.dry_run,
            "results": [
                {
                    "failure_type": r.failure_type,
                    "healed": r.healed,
                    "mttr_seconds": r.mttr_seconds,
                    "message": r.message,
                }
                for r in results
            ],
            "regressions": summary["regressions"],
        }

        if self.args.json:
            print(json.dumps(report, indent=2))
            return

        print(f"Resilience Harness Run: {self.run_id}")
        print(f"Status: {'PASS' if summary['pass'] else 'FAIL'}")
        for r in results:
            mttr = f"{r.mttr_seconds:.1f}s" if r.mttr_seconds is not None else "n/a"
            print(f" - {r.failure_type}: healed={r.healed} mttr={mttr} ({r.message})")

        if summary["regressions"]:
            print("Regression checks:")
            for ftype, data in summary["regressions"].items():
                flag = "REGRESSION" if data["regressed"] else "ok"
                print(f" - {ftype}: current={data['current_mttr']}s baseline={data['baseline_mttr']}s -> {flag}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Self-healing verification harness for tier-1 failure simulations"
    )
    parser.add_argument("--dry-run", action="store_true", help="Simulate only; do not inject failures")
    parser.add_argument("--safe-window", default="01:00-05:00", help="Allowed local time window HH:MM-HH:MM")
    parser.add_argument("--wait-seconds", type=int, default=180, help="Max seconds to wait for self-healing")
    parser.add_argument("--poll-seconds", type=int, default=5, help="Polling interval while waiting")
    parser.add_argument("--stale-hours", type=int, default=12, help="Hours threshold for stale session files")
    parser.add_argument("--baseline-days", type=int, default=14, help="Regression baseline lookback")
    parser.add_argument(
        "--regression-threshold",
        type=float,
        default=1.2,
        help="Flag regression if current MTTR > baseline * threshold",
    )
    parser.add_argument("--json", action="store_true", help="Print JSON report")
    parser.add_argument(
        "--trigger-immune-scan",
        action="store_true",
        help="Kick tools/immune_scan.sh after each injection",
    )
    return parser.parse_args()


def in_safe_window(window: str, now: datetime) -> bool:
    try:
        start_str, end_str = window.split("-", 1)
        s_h, s_m = [int(x) for x in start_str.split(":", 1)]
        e_h, e_m = [int(x) for x in end_str.split(":", 1)]
        start_t = dtime(s_h, s_m)
        end_t = dtime(e_h, e_m)
    except Exception:
        return False

    n = now.time()
    if start_t <= end_t:
        return start_t <= n <= end_t
    # overnight window
    return n >= start_t or n <= end_t


def inject_expired_token(token_path: Path) -> dict[str, Any]:
    token_path.parent.mkdir(parents=True, exist_ok=True)
    backup = None
    if token_path.exists():
        backup = token_path.read_bytes()

    token_path.write_text("EXPIRED_TOKEN_MARKER\n", encoding="utf-8")
    old_ts = time.time() - (72 * 3600)
    os.utime(token_path, (old_ts, old_ts))

    return {"kind": "token", "path": str(token_path), "backup": backup}


def inject_missing_file(path: Path) -> dict[str, Any]:
    path.parent.mkdir(parents=True, exist_ok=True)
    backup_path = None
    if path.exists():
        backup_path = path.with_suffix(path.suffix + f".bak.{int(time.time())}")
        shutil.move(str(path), str(backup_path))
    else:
        path.write_text("placeholder\n", encoding="utf-8")
        path.unlink(missing_ok=True)

    return {"kind": "missing", "path": str(path), "backup_path": str(backup_path) if backup_path else None}


def inject_stale_session(session_dir: Path, stale_hours: int) -> dict[str, Any]:
    session_dir.mkdir(parents=True, exist_ok=True)
    stale_file = session_dir / f"harness_stale_{int(time.time())}.session"
    stale_file.write_text("stale session marker\n", encoding="utf-8")
    old_ts = time.time() - (max(2, stale_hours + 2) * 3600)
    os.utime(stale_file, (old_ts, old_ts))
    return {"kind": "stale", "path": str(stale_file)}


def token_is_repaired(token_path: Path, injected_at: datetime) -> bool:
    if not token_path.exists():
        return False
    try:
        txt = token_path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        txt = ""
    if "EXPIRED_TOKEN_MARKER" in txt:
        return False
    mtime = datetime.fromtimestamp(token_path.stat().st_mtime)
    return mtime >= injected_at


def has_stale_sessions(session_dir: Path, stale_hours: int) -> bool:
    if not session_dir.exists():
        return False
    cutoff = time.time() - (stale_hours * 3600)
    for p in session_dir.glob("*.session"):
        try:
            if p.stat().st_mtime < cutoff:
                return True
        except FileNotFoundError:
            continue
    return False


def safe_restore(restore_info: dict[str, Any]) -> None:
    kind = restore_info.get("kind")
    if kind == "token":
        path = Path(restore_info["path"])
        backup = restore_info.get("backup")
        if backup is None:
            path.unlink(missing_ok=True)
        else:
            path.write_bytes(backup)
    elif kind == "missing":
        path = Path(restore_info["path"])
        backup = restore_info.get("backup_path")
        if backup and Path(backup).exists():
            shutil.move(backup, path)
        else:
            path.touch(exist_ok=True)
    elif kind == "stale":
        Path(restore_info["path"]).unlink(missing_ok=True)


def find_healing_event(started_at: datetime, failure_type: str, keywords: list[str]) -> datetime | None:
    search = " OR ".join([f"message ILIKE '%{sql_escape(k)}%'" for k in keywords])
    sql = f"""
SELECT to_char(timestamp, 'YYYY-MM-DD"T"HH24:MI:SS')
FROM cortana_events
WHERE timestamp >= '{started_at.strftime('%Y-%m-%d %H:%M:%S')}'
  AND (
    metadata::text ILIKE '%{sql_escape(failure_type)}%'
    OR {search}
  )
ORDER BY timestamp ASC
LIMIT 1;
"""
    out = run_psql_scalar(sql)
    if not out:
        return None
    try:
        return datetime.fromisoformat(out)
    except ValueError:
        return None


def historical_mttr_baseline(days: int) -> dict[str, float]:
    sql = f"""
SELECT COALESCE(json_object_agg(failure_type, avg_mttr), '{{}}'::json)
FROM (
  SELECT
    metadata->>'failure_type' AS failure_type,
    AVG((metadata->>'mttr_seconds')::numeric)::float AS avg_mttr
  FROM cortana_events
  WHERE event_type = 'resilience_harness'
    AND timestamp >= NOW() - INTERVAL '{int(days)} days'
    AND (metadata->>'mttr_seconds') IS NOT NULL
  GROUP BY 1
) t;
"""
    out = run_psql_scalar(sql)
    if not out:
        return {}
    try:
        return {k: float(v) for k, v in json.loads(out).items() if v is not None}
    except Exception:
        return {}


def insert_event(event_type: str, source: str, severity: str, message: str, metadata: dict[str, Any]) -> None:
    sql = (
        "INSERT INTO cortana_events (event_type, source, severity, message, metadata) "
        f"VALUES ('{sql_escape(event_type)}', '{sql_escape(source)}', '{sql_escape(severity)}', "
        f"'{sql_escape(message)}', '{sql_escape(json.dumps(metadata))}'::jsonb);"
    )
    run_psql_exec(sql)


def run_psql_exec(sql: str) -> None:
    env = os.environ.copy()
    env["PATH"] = f"/opt/homebrew/opt/postgresql@17/bin:{env.get('PATH', '')}"
    proc = subprocess.run([PSQL_BIN, "cortana", "-X", "-v", "ON_ERROR_STOP=1", "-c", sql], capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        print(f"[warn] psql write failed: {proc.stderr.strip()}", file=sys.stderr)


def run_psql_scalar(sql: str) -> str:
    env = os.environ.copy()
    env["PATH"] = f"/opt/homebrew/opt/postgresql@17/bin:{env.get('PATH', '')}"
    proc = subprocess.run(
        [PSQL_BIN, "cortana", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql],
        capture_output=True,
        text=True,
        env=env,
    )
    if proc.returncode != 0:
        return ""
    return proc.stdout.strip()


def sql_escape(value: str) -> str:
    return (value or "").replace("'", "''")


def main() -> int:
    args = parse_args()
    harness = Harness(args)
    return harness.run()


if __name__ == "__main__":
    raise SystemExit(main())
