#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import List

from mttr import fetch_mttr_scorecard, record_events, record_run
from scenarios import SCENARIO_REGISTRY, serialize_results

ROOT = Path(__file__).resolve().parents[2]
HEALTH_CHECK_SCRIPT = ROOT / "proprioception" / "run_health_checks.py"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Reliability chaos runner for self-healing validation")
    parser.add_argument("--scenarios", nargs="*", default=list(SCENARIO_REGISTRY.keys()))
    parser.add_argument("--mode", default="simulation", choices=["simulation", "scheduled"])
    parser.add_argument("--window-days", type=int, default=30)
    parser.add_argument("--no-regression", action="store_true", help="Skip baseline/post regression checks")
    parser.add_argument("--no-db", action="store_true", help="Do not persist chaos run/events")
    parser.add_argument("--json", action="store_true", help="Print json output")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Simulation-only run: execute scenarios/regression but skip DB persistence",
    )
    return parser.parse_args()


def run_regression_probe(label: str) -> dict:
    start = time.perf_counter()
    proc = subprocess.run(
        [sys.executable, str(HEALTH_CHECK_SCRIPT), "--dry-run"],
        capture_output=True,
        text=True,
        env=os.environ.copy(),
    )
    elapsed_ms = int((time.perf_counter() - start) * 1000)
    return {
        "label": label,
        "ok": proc.returncode == 0,
        "elapsed_ms": elapsed_ms,
        "stderr": (proc.stderr or "")[:500],
    }


def main() -> int:
    args = parse_args()
    if args.dry_run:
        args.no_db = True
    run_id = str(uuid.uuid4())

    unknown = [s for s in args.scenarios if s not in SCENARIO_REGISTRY]
    if unknown:
        print(f"Unknown scenarios: {', '.join(unknown)}", file=sys.stderr)
        return 2

    regression = []
    if not args.no_regression:
        regression.append(run_regression_probe("pre"))

    results = []
    for name in args.scenarios:
        scenario = SCENARIO_REGISTRY[name]()
        results.append(scenario.run())

    if not args.no_regression:
        regression.append(run_regression_probe("post"))

    serialized = serialize_results(results)
    recovered_count = sum(1 for r in serialized if r["recovered"])
    status = "passed" if recovered_count == len(serialized) and all(r["ok"] for r in regression or [{"ok": True}]) else "failed"

    run_meta = {
        "regression": regression,
        "safe_mode": True,
        "isolation": "temp_files_and_simulated_failures_only",
    }

    if not args.no_db:
        record_run(run_id=run_id, mode=args.mode, scenario_count=len(serialized), status=status, metadata=run_meta)
        record_events(run_id=run_id, events=serialized)

    output = {
        "run_id": run_id,
        "mode": args.mode,
        "status": status,
        "scenarios": serialized,
        "regression": regression,
        "mttr_scorecard": fetch_mttr_scorecard(window_days=args.window_days) if not args.no_db else None,
    }

    if args.json:
        print(json.dumps(output, indent=2))
    else:
        print(f"Chaos run {run_id}: {status} ({len(serialized)} scenarios)")
        for s in serialized:
            print(f" - {s['name']}: detected={s['detected']} recovered={s['recovered']} recovery_ms={s['recovery_ms']}")

    return 0 if status == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
