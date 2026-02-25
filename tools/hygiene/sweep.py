#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PATHS = [ROOT / "tmp", ROOT / "logs", ROOT / "cortical-loop" / "logs"]
DEFAULT_MIGRATIONS_DIR = ROOT / "migrations"

SEVERITY_WEIGHT = {"info": 1, "warn": 4, "critical": 10}


@dataclass
class Finding:
    check: str
    severity: str  # info|warn|critical
    title: str
    message: str
    metadata: dict[str, Any]
    recoverable: bool = False
    cleaned: bool = False


@dataclass
class SweepSummary:
    mode: str
    safe: bool
    dry_run: bool
    risk_score: int
    counts: dict[str, int]
    cleaned_items: int
    findings: list[Finding]


class HygieneSweep:
    def __init__(
        self,
        stale_session_minutes: int,
        stale_file_days: int,
        oversized_log_mb: int,
        paths: list[Path],
        migrations_dir: Path,
        db: str,
        verbose: bool = False,
    ):
        self.stale_session_minutes = stale_session_minutes
        self.stale_file_days = stale_file_days
        self.oversized_log_bytes = oversized_log_mb * 1024 * 1024
        self.paths = paths
        self.migrations_dir = migrations_dir
        self.db = db
        self.verbose = verbose

    def run(self, mode: str, safe: bool, dry_run: bool) -> SweepSummary:
        findings: list[Finding] = []
        findings.extend(self._check_subagent_sessions())
        findings.extend(self._check_stale_files(mode=mode, safe=safe, dry_run=dry_run))
        findings.extend(self._check_duplicate_migration_prefixes())
        findings.extend(self._check_oversized_session_logs(mode=mode, safe=safe, dry_run=dry_run))

        counts = {"info": 0, "warn": 0, "critical": 0}
        cleaned_items = 0
        weighted = 0
        for f in findings:
            counts[f.severity] = counts.get(f.severity, 0) + 1
            weighted += SEVERITY_WEIGHT.get(f.severity, 1)
            if f.cleaned:
                cleaned_items += 1

        max_possible = max(1, len(findings) * SEVERITY_WEIGHT["critical"])
        risk_score = min(100, round((weighted / max_possible) * 100))

        return SweepSummary(
            mode=mode,
            safe=safe,
            dry_run=dry_run,
            risk_score=risk_score,
            counts=counts,
            cleaned_items=cleaned_items,
            findings=findings,
        )

    def _check_subagent_sessions(self) -> list[Finding]:
        findings: list[Finding] = []
        stale_ms = self.stale_session_minutes * 60 * 1000

        data = self._read_subagent_runtime_data()
        if data is None:
            # Fallback: infer stale/orphaned work from task queue state.
            stale_minutes = int(self.stale_session_minutes)
            stale_in_progress = self._psql_json(
                f"""
                SELECT COALESCE(json_agg(t), '[]'::json)
                FROM (
                  SELECT id, title, status, assigned_to, created_at,
                         EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000 AS runtime_ms
                  FROM cortana_tasks
                  WHERE status='in_progress'
                    AND created_at < NOW() - INTERVAL '{stale_minutes} minutes'
                  ORDER BY created_at ASC
                  LIMIT 25
                ) t;
                """
            )
            stale_in_progress = stale_in_progress if isinstance(stale_in_progress, list) else []

            if stale_in_progress:
                findings.append(
                    Finding(
                        check="subagent_sessions",
                        severity="warn",
                        title="Potentially orphaned in-progress tasks",
                        message=f"Detected {len(stale_in_progress)} long-running in_progress task(s) beyond stale threshold.",
                        metadata={"threshold_minutes": stale_minutes, "tasks": stale_in_progress},
                    )
                )
            else:
                findings.append(
                    Finding(
                        check="subagent_sessions",
                        severity="info",
                        title="No stale in-progress tasks",
                        message="Fallback queue scan found no likely orphaned/stale tasks.",
                        metadata={"threshold_minutes": stale_minutes},
                    )
                )
            return findings

        active = data.get("active") or []
        recent = data.get("recent") or []

        stale_active = [s for s in active if int(s.get("runtimeMs") or 0) > stale_ms]
        if stale_active:
            findings.append(
                Finding(
                    check="subagent_sessions",
                    severity="critical",
                    title="Stale active subagent sessions",
                    message=f"{len(stale_active)} running subagent session(s) exceeded stale threshold.",
                    metadata={
                        "threshold_minutes": self.stale_session_minutes,
                        "sessions": [
                            {
                                "runId": s.get("runId"),
                                "label": s.get("label"),
                                "runtimeMs": s.get("runtimeMs"),
                                "status": s.get("status"),
                            }
                            for s in stale_active
                        ],
                    },
                )
            )
        else:
            findings.append(
                Finding(
                    check="subagent_sessions",
                    severity="info",
                    title="No stale active subagent sessions",
                    message="All active subagent sessions are within freshness threshold.",
                    metadata={"active_count": len(active), "threshold_minutes": self.stale_session_minutes},
                )
            )

        problematic_recent = [s for s in recent if str(s.get("status")) in {"failed", "timeout"}]
        if problematic_recent:
            findings.append(
                Finding(
                    check="subagent_sessions",
                    severity="warn",
                    title="Recent failed/timed-out subagent sessions",
                    message=f"Detected {len(problematic_recent)} recent subagent failures/timeouts.",
                    metadata={
                        "sessions": [
                            {
                                "runId": s.get("runId"),
                                "label": s.get("label"),
                                "status": s.get("status"),
                                "runtimeMs": s.get("runtimeMs"),
                            }
                            for s in problematic_recent
                        ]
                    },
                )
            )
        return findings

    def _read_subagent_runtime_data(self) -> dict[str, Any] | None:
        try:
            proc = subprocess.run(
                ["openclaw", "subagents", "list", "--json"],
                capture_output=True,
                text=True,
                cwd=str(ROOT),
            )
            if proc.returncode != 0:
                return None
            data = json.loads(proc.stdout)
            if isinstance(data, dict):
                return data
        except Exception:  # noqa: BLE001
            return None
        return None

    def _psql_json(self, sql: str) -> Any:
        env = os.environ.copy()
        env["PATH"] = f"/opt/homebrew/opt/postgresql@17/bin:{env.get('PATH', '')}"
        proc = subprocess.run(
            ["psql", self.db, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql],
            text=True,
            capture_output=True,
            env=env,
        )
        if proc.returncode != 0:
            return None
        raw = (proc.stdout or "").strip()
        if not raw:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    def _all_candidate_files(self) -> list[Path]:
        files: list[Path] = []
        for base in self.paths:
            if not base.exists() or not base.is_dir():
                continue
            for p in base.rglob("*"):
                if p.is_file():
                    files.append(p)
        return files

    def _check_stale_files(self, mode: str, safe: bool, dry_run: bool) -> list[Finding]:
        findings: list[Finding] = []
        now = datetime.now(timezone.utc).timestamp()
        stale_seconds = self.stale_file_days * 86400

        stale_files: list[Path] = []
        for p in self._all_candidate_files():
            try:
                age = now - p.stat().st_mtime
            except FileNotFoundError:
                continue
            if age >= stale_seconds:
                stale_files.append(p)

        if not stale_files:
            findings.append(
                Finding(
                    check="stale_files",
                    severity="info",
                    title="No stale temp/log files",
                    message="No stale files found under configured temp/log paths.",
                    metadata={"paths": [str(p) for p in self.paths], "stale_file_days": self.stale_file_days},
                    recoverable=True,
                )
            )
            return findings

        sample = [str(p.relative_to(ROOT)) for p in stale_files[:25]]
        total_bytes = sum(p.stat().st_size for p in stale_files if p.exists())
        finding = Finding(
            check="stale_files",
            severity="warn",
            title="Stale temp/log files detected",
            message=f"Found {len(stale_files)} stale files ({_human_size(total_bytes)}).",
            metadata={
                "count": len(stale_files),
                "total_bytes": total_bytes,
                "sample": sample,
                "stale_file_days": self.stale_file_days,
            },
            recoverable=True,
        )

        if mode == "clean" and safe:
            deleted = 0
            for p in stale_files:
                if dry_run:
                    deleted += 1
                    continue
                try:
                    p.unlink(missing_ok=True)
                    deleted += 1
                except Exception:  # noqa: BLE001
                    pass
            finding.cleaned = deleted > 0
            finding.message += f" {'Would remove' if dry_run else 'Removed'} {deleted} file(s)."
            finding.metadata["deleted"] = deleted
            finding.metadata["dry_run"] = dry_run

        findings.append(finding)
        return findings

    def _check_duplicate_migration_prefixes(self) -> list[Finding]:
        findings: list[Finding] = []
        if not self.migrations_dir.exists() or not self.migrations_dir.is_dir():
            return [
                Finding(
                    check="migration_prefixes",
                    severity="info",
                    title="Migration directory missing",
                    message="No migrations directory found; skipping duplicate prefix scan.",
                    metadata={"path": str(self.migrations_dir)},
                )
            ]

        buckets: dict[str, list[str]] = {}
        for p in self.migrations_dir.glob("*.sql"):
            parts = p.name.split("_", 1)
            if not parts or not parts[0].isdigit():
                continue
            buckets.setdefault(parts[0], []).append(p.name)

        duplicates = {k: v for k, v in buckets.items() if len(v) > 1}
        if duplicates:
            findings.append(
                Finding(
                    check="migration_prefixes",
                    severity="critical",
                    title="Duplicate migration prefixes detected",
                    message=f"Detected {len(duplicates)} duplicate migration prefix group(s).",
                    metadata={"duplicates": duplicates},
                )
            )
        else:
            findings.append(
                Finding(
                    check="migration_prefixes",
                    severity="info",
                    title="Migration prefixes are unique",
                    message="No duplicate numeric migration prefixes found.",
                    metadata={"scanned_files": sum(len(v) for v in buckets.values())},
                )
            )
        return findings

    def _check_oversized_session_logs(self, mode: str, safe: bool, dry_run: bool) -> list[Finding]:
        findings: list[Finding] = []

        def is_session_log(p: Path) -> bool:
            n = p.name.lower()
            if not n.endswith(".log"):
                return False
            return "session" in n or "subagent" in n or "agent" in n

        candidates = [p for p in self._all_candidate_files() if is_session_log(p)]
        oversized = [p for p in candidates if p.exists() and p.stat().st_size > self.oversized_log_bytes]

        if not oversized:
            findings.append(
                Finding(
                    check="oversized_session_logs",
                    severity="info",
                    title="No oversized session logs",
                    message="No session log exceeded configured size threshold.",
                    metadata={
                        "threshold_bytes": self.oversized_log_bytes,
                        "threshold_mb": round(self.oversized_log_bytes / (1024 * 1024), 2),
                        "candidates": len(candidates),
                    },
                    recoverable=True,
                )
            )
            return findings

        max_bytes = max(p.stat().st_size for p in oversized)
        severity = "critical" if max_bytes > (self.oversized_log_bytes * 2) else "warn"
        finding = Finding(
            check="oversized_session_logs",
            severity=severity,
            title="Oversized session logs detected",
            message=f"Found {len(oversized)} oversized session logs.",
            metadata={
                "threshold_bytes": self.oversized_log_bytes,
                "logs": [
                    {
                        "path": str(p.relative_to(ROOT)),
                        "bytes": p.stat().st_size,
                    }
                    for p in oversized[:50]
                ],
            },
            recoverable=True,
        )

        if mode == "clean" and safe:
            processed = 0
            for p in oversized:
                if dry_run:
                    processed += 1
                    continue
                try:
                    # Truncate in-place to preserve log handles.
                    with p.open("w", encoding="utf-8"):
                        pass
                    processed += 1
                except Exception:  # noqa: BLE001
                    pass
            finding.cleaned = processed > 0
            finding.message += f" {'Would truncate' if dry_run else 'Truncated'} {processed} log file(s)."
            finding.metadata["processed"] = processed
            finding.metadata["dry_run"] = dry_run

        findings.append(finding)
        return findings

    def log_event(self, summary: SweepSummary) -> None:
        payload = {
            "mode": summary.mode,
            "safe": summary.safe,
            "dry_run": summary.dry_run,
            "risk_score": summary.risk_score,
            "counts": summary.counts,
            "cleaned_items": summary.cleaned_items,
            "findings": [asdict(f) for f in summary.findings],
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        metadata = json.dumps(payload, separators=(",", ":")).replace("'", "''")
        message = f"System hygiene sweep {summary.mode}: risk={summary.risk_score}".replace("'", "''")

        sql = f"""
        INSERT INTO cortana_events (event_type, source, severity, message, metadata)
        VALUES (
            'system_hygiene',
            'tools/hygiene/sweep.py',
            '{self._overall_severity(summary)}',
            '{message}',
            '{metadata}'::jsonb
        );
        """

        env = os.environ.copy()
        env["PATH"] = f"/opt/homebrew/opt/postgresql@17/bin:{env.get('PATH', '')}"
        proc = subprocess.run(["psql", self.db, "-v", "ON_ERROR_STOP=1", "-c", sql], text=True, capture_output=True, env=env)
        if proc.returncode != 0 and self.verbose:
            print(f"[warn] failed to write cortana_events: {proc.stderr.strip() or proc.stdout.strip()}")

    @staticmethod
    def _overall_severity(summary: SweepSummary) -> str:
        if summary.counts.get("critical", 0) > 0:
            return "critical"
        if summary.counts.get("warn", 0) > 0:
            return "warning"
        return "info"


def _human_size(size: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    val = float(size)
    idx = 0
    while val >= 1024 and idx < len(units) - 1:
        val /= 1024
        idx += 1
    if idx == 0:
        return f"{int(val)} {units[idx]}"
    return f"{val:.1f} {units[idx]}"


def _print_human(summary: SweepSummary) -> None:
    print(f"mode={summary.mode} safe={summary.safe} dry_run={summary.dry_run}")
    print(
        "risk_score={} info={} warn={} critical={} cleaned={}".format(
            summary.risk_score,
            summary.counts.get("info", 0),
            summary.counts.get("warn", 0),
            summary.counts.get("critical", 0),
            summary.cleaned_items,
        )
    )
    for f in summary.findings:
        cleaned = " cleaned" if f.cleaned else ""
        print(f"- [{f.severity}] {f.check}: {f.title}{cleaned}")
        print(f"  {f.message}")


def _summary_to_json(summary: SweepSummary) -> str:
    payload = {
        "mode": summary.mode,
        "safe": summary.safe,
        "dry_run": summary.dry_run,
        "risk_score": summary.risk_score,
        "counts": summary.counts,
        "cleaned_items": summary.cleaned_items,
        "findings": [asdict(f) for f in summary.findings],
    }
    return json.dumps(payload, indent=2, sort_keys=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="System hygiene sweep")
    sub = parser.add_subparsers(dest="command")

    audit = sub.add_parser("audit", help="Detect hygiene issues only")
    clean = sub.add_parser("clean", help="Cleanup recoverable low-risk items")
    report = sub.add_parser("report", help="Generate hygiene report")

    for p in (parser, audit, clean, report):
        p.add_argument("--stale-session-minutes", type=int, default=180)
        p.add_argument("--stale-file-days", type=int, default=7)
        p.add_argument("--oversized-log-mb", type=int, default=25)
        p.add_argument("--migrations-dir", default=str(DEFAULT_MIGRATIONS_DIR))
        p.add_argument("--db", default="cortana")
        p.add_argument(
            "--paths",
            nargs="*",
            default=[str(p) for p in DEFAULT_PATHS],
            help="Temp/log paths to scan",
        )
        p.add_argument("--no-log-event", action="store_true", help="Skip cortana_events insert")
        p.add_argument("--verbose", action="store_true")

    clean.add_argument("--safe", action="store_true", help="Required safety gate for cleanup")
    clean.add_argument("--dry-run", action="store_true", help="Show cleanup actions without changing files")
    report.add_argument("--json", action="store_true", help="Emit machine-readable JSON")

    args = parser.parse_args()
    if args.command is None:
        args.command = "audit"
    return args


def main() -> int:
    args = parse_args()

    if args.command == "clean" and not args.safe:
        print("error: clean requires --safe")
        return 2

    paths = [Path(p).expanduser().resolve() for p in args.paths]
    sweep = HygieneSweep(
        stale_session_minutes=args.stale_session_minutes,
        stale_file_days=args.stale_file_days,
        oversized_log_mb=args.oversized_log_mb,
        paths=paths,
        migrations_dir=Path(args.migrations_dir).expanduser().resolve(),
        db=args.db,
        verbose=args.verbose,
    )

    summary = sweep.run(
        mode=args.command,
        safe=bool(getattr(args, "safe", False)),
        dry_run=bool(getattr(args, "dry_run", False)),
    )

    if args.command == "report" and args.json:
        print(_summary_to_json(summary))
    else:
        _print_human(summary)

    if not args.no_log_event:
        sweep.log_event(summary)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
