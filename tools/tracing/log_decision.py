#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import uuid


def parse_json(value: str | None, field: str):
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON for {field}: {exc}")
    if not isinstance(parsed, dict):
        raise SystemExit(f"{field} must be a JSON object")
    return parsed


def main() -> int:
    p = argparse.ArgumentParser(description="Log a cortana decision trace")
    p.add_argument("--trace-id", default=str(uuid.uuid4()))
    p.add_argument("--event-id", type=int)
    p.add_argument("--task-id", type=int)
    p.add_argument("--run-id")
    p.add_argument("--trigger", required=True)
    p.add_argument("--action-type", required=True)
    p.add_argument("--action-name", required=True)
    p.add_argument("--reasoning")
    p.add_argument("--confidence", type=float)
    p.add_argument("--outcome", default="unknown")
    p.add_argument("--data-inputs")
    p.add_argument("--metadata")
    args = p.parse_args()

    if args.confidence is not None and not (0 <= args.confidence <= 1):
        raise SystemExit("confidence must be between 0 and 1")

    data_inputs = json.dumps(parse_json(args.data_inputs, "--data-inputs"))
    metadata = json.dumps(parse_json(args.metadata, "--metadata"))

    env = os.environ.copy()
    env["PATH"] = "/opt/homebrew/opt/postgresql@17/bin:" + env.get("PATH", "")
    db = env.get("CORTANA_DATABASE_URL") or env.get("DATABASE_URL") or "cortana"

    sql = """
    INSERT INTO cortana_decision_traces (
      trace_id,event_id,task_id,run_id,trigger_type,action_type,action_name,
      reasoning,confidence,outcome,data_inputs,metadata
    ) VALUES (
      :'trace_id', NULLIF(:'event_id','')::bigint, NULLIF(:'task_id','')::bigint,
      NULLIF(:'run_id',''), :'trigger', :'action_type', :'action_name',
      NULLIF(:'reasoning',''), NULLIF(:'confidence','')::numeric, :'outcome',
      :'data_inputs'::jsonb, :'metadata'::jsonb
    )
    ON CONFLICT (trace_id) DO UPDATE SET
      event_id = EXCLUDED.event_id,
      task_id = EXCLUDED.task_id,
      run_id = EXCLUDED.run_id,
      trigger_type = EXCLUDED.trigger_type,
      action_type = EXCLUDED.action_type,
      action_name = EXCLUDED.action_name,
      reasoning = EXCLUDED.reasoning,
      confidence = EXCLUDED.confidence,
      outcome = EXCLUDED.outcome,
      data_inputs = EXCLUDED.data_inputs,
      metadata = EXCLUDED.metadata;
    """

    cmd = [
        "psql", db,
        "-v", f"trace_id={args.trace_id}",
        "-v", f"event_id={'' if args.event_id is None else args.event_id}",
        "-v", f"task_id={'' if args.task_id is None else args.task_id}",
        "-v", f"run_id={'' if args.run_id is None else args.run_id}",
        "-v", f"trigger={args.trigger}",
        "-v", f"action_type={args.action_type}",
        "-v", f"action_name={args.action_name}",
        "-v", f"reasoning={'' if args.reasoning is None else args.reasoning}",
        "-v", f"confidence={'' if args.confidence is None else args.confidence}",
        "-v", f"outcome={args.outcome}",
        "-v", f"data_inputs={data_inputs}",
        "-v", f"metadata={metadata}",
        "-c", sql,
    ]
    subprocess.run(cmd, env=env, check=True)

    print(json.dumps({"ok": True, "trace_id": args.trace_id}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(f"failed to log decision trace: {exc}", file=sys.stderr)
        raise SystemExit(1)
