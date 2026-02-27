#!/usr/bin/env python3
"""
Local Inference Failsafe: API-Outage Survival Brain

What it does:
- Health-checks OpenAI and Anthropic API reachability.
- Detects outage states (timeouts, connection errors, 5xx).
- Falls back to local Ollama model for critical operations:
  - task_queue: summarize ready tasks and recommend next actions
  - alert: generate concise operator alert copy
  - qa: answer basic Q&A prompts
- Logs failover events to PostgreSQL table `cortana_events`.

Usage examples:
  python3 local-inference.py qa --prompt "How do I restart gateway?"
  python3 local-inference.py task_queue --limit 10
  python3 local-inference.py alert --prompt "Postgres down on watchdog"
  python3 local-inference.py qa --prompt "status" --force-local
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import textwrap
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple


DEFAULT_MODEL = os.getenv("FAILSAFE_MODEL", "phi3:mini")
DEFAULT_TIMEOUT = float(os.getenv("FAILSAFE_TIMEOUT_SEC", "6"))
PSQL_PATH = os.getenv("PSQL_PATH", "/opt/homebrew/opt/postgresql@17/bin/psql")
DB_NAME = os.getenv("CORTANA_DB", "cortana")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def run(cmd: List[str], timeout: Optional[float] = None) -> Tuple[int, str, str]:
    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
    )
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def sql_escape(s: str) -> str:
    return s.replace("'", "''")


def log_event(
    severity: str,
    message: str,
    metadata: Optional[Dict[str, Any]] = None,
    event_type: str = "failsafe",
    source: str = "local-inference",
) -> None:
    metadata = metadata or {}
    meta_json = json.dumps(metadata, separators=(",", ":"))
    query = (
        "INSERT INTO cortana_events (event_type, source, severity, message, metadata) "
        f"VALUES ('{sql_escape(event_type)}','{sql_escape(source)}','{sql_escape(severity)}',"
        f"'{sql_escape(message)}','{sql_escape(meta_json)}'::jsonb);"
    )

    cmd = [PSQL_PATH, DB_NAME, "-c", query]
    try:
        code, out, err = run(cmd, timeout=8)
        if code != 0:
            print(f"[warn] failed to write cortana_events: {err or out}", file=sys.stderr)
    except Exception as exc:
        print(f"[warn] exception while writing cortana_events: {exc}", file=sys.stderr)


def check_openai(timeout_sec: float) -> Tuple[bool, str]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        return False, "OPENAI_API_KEY missing"

    req = urllib.request.Request(
        "https://api.openai.com/v1/models",
        headers={"Authorization": f"Bearer {api_key}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            code = resp.getcode()
            if 200 <= code < 500:
                return True, f"reachable ({code})"
            return False, f"http {code}"
    except urllib.error.HTTPError as e:
        if 400 <= e.code < 500:
            return True, f"reachable ({e.code})"
        return False, f"http {e.code}"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def check_anthropic(timeout_sec: float) -> Tuple[bool, str]:
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        return False, "ANTHROPIC_API_KEY missing"

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        data=b'{"model":"claude-3-5-haiku-latest","max_tokens":1,"messages":[{"role":"user","content":"ping"}]}',
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            code = resp.getcode()
            if 200 <= code < 500:
                return True, f"reachable ({code})"
            return False, f"http {code}"
    except urllib.error.HTTPError as e:
        if 400 <= e.code < 500:
            return True, f"reachable ({e.code})"
        return False, f"http {e.code}"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def detect_outage(timeout_sec: float) -> Tuple[bool, Dict[str, str]]:
    openai_ok, openai_msg = check_openai(timeout_sec)
    anthropic_ok, anthropic_msg = check_anthropic(timeout_sec)
    details = {
        "openai": openai_msg,
        "anthropic": anthropic_msg,
        "checked_at": utc_now_iso(),
    }
    # Outage condition = neither provider reachable.
    return (not openai_ok and not anthropic_ok), details


def ensure_ollama_model(model: str) -> None:
    code, out, err = run(["ollama", "list"], timeout=15)
    if code != 0:
        raise RuntimeError(f"ollama not ready: {err or out}")

    if model in out:
        return

    pull_code, pull_out, pull_err = run(["ollama", "pull", model], timeout=600)
    if pull_code != 0:
        raise RuntimeError(f"failed to pull model {model}: {pull_err or pull_out}")


def local_infer(model: str, prompt: str) -> str:
    ensure_ollama_model(model)
    code, out, err = run(["ollama", "run", model, prompt], timeout=180)
    if code != 0:
        raise RuntimeError(f"ollama run failed: {err or out}")
    return out.strip()


def get_ready_tasks(limit: int) -> List[Dict[str, Any]]:
    query = textwrap.dedent(
        f"""
        SELECT id, title, priority, due_at, auto_executable, status
        FROM cortana_tasks
        WHERE status = 'ready'
          AND auto_executable = TRUE
          AND (depends_on IS NULL OR NOT EXISTS (
              SELECT 1 FROM cortana_tasks t2
              WHERE t2.id = ANY(cortana_tasks.depends_on)
                AND t2.status != 'completed'
          ))
        ORDER BY priority ASC, created_at ASC
        LIMIT {int(limit)};
        """
    ).strip()

    cmd = [
        PSQL_PATH,
        DB_NAME,
        "-At",
        "-F",
        "|",
        "-c",
        query,
    ]
    code, out, err = run(cmd, timeout=10)
    if code != 0:
        raise RuntimeError(f"task query failed: {err or out}")

    tasks: List[Dict[str, Any]] = []
    if not out:
        return tasks

    for line in out.splitlines():
        parts = line.split("|")
        if len(parts) < 6:
            continue
        tasks.append(
            {
                "id": int(parts[0]),
                "title": parts[1],
                "priority": int(parts[2]) if parts[2].isdigit() else None,
                "due_at": parts[3] or None,
                "auto_executable": parts[4] == "t",
                "status": parts[5],
            }
        )
    return tasks


def build_task_queue_prompt(tasks: List[Dict[str, Any]]) -> str:
    if not tasks:
        return "No ready auto-executable tasks exist. Provide a short operational status line and one recommendation."
    task_lines = "\n".join(
        [f"- #{t['id']} P{t['priority']}: {t['title']} (due: {t['due_at'] or 'n/a'})" for t in tasks]
    )
    return (
        "You are a failsafe operations assistant. "
        "Given ready tasks, return:\n"
        "1) Top 3 tasks to execute now (with one-line rationale each)\n"
        "2) One sequencing recommendation\n"
        "3) One risk to watch\n\n"
        f"Tasks:\n{task_lines}"
    )


def run_failsafe(mode: str, prompt: Optional[str], model: str, limit: int) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "mode": mode,
        "model": model,
        "timestamp": utc_now_iso(),
    }

    if mode == "task_queue":
        tasks = get_ready_tasks(limit=limit)
        payload["task_count"] = len(tasks)
        user_prompt = build_task_queue_prompt(tasks)
    elif mode in {"qa", "alert"}:
        if not prompt:
            raise ValueError(f"--prompt is required for mode={mode}")
        if mode == "alert":
            user_prompt = (
                "Write a concise operator alert (<= 5 lines), include impact + immediate next action.\n\n"
                f"Context: {prompt}"
            )
        else:
            user_prompt = prompt
    else:
        raise ValueError(f"Unsupported mode: {mode}")

    output = local_infer(model=model, prompt=user_prompt)
    payload["output"] = output
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="API outage failsafe with local Ollama fallback")
    parser.add_argument("mode", choices=["task_queue", "alert", "qa"])
    parser.add_argument("--prompt", help="Input text for qa/alert")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--limit", type=int, default=10, help="Task limit for task_queue mode")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--force-local", action="store_true", help="Bypass API checks and force local inference")
    args = parser.parse_args()

    outage = False
    outage_details: Dict[str, str] = {}

    if not args.force_local:
        outage, outage_details = detect_outage(args.timeout)
    else:
        outage = True
        outage_details = {"forced": "true", "checked_at": utc_now_iso()}

    if outage:
        is_test = args.force_local
        log_event(
            severity="info" if is_test else "warning",
            message="Failover test: local inference validated" if is_test else "API outage detected; switching to local inference",
            metadata={
                "mode": args.mode,
                "model": args.model,
                "details": outage_details,
            },
            event_type="failover_test" if is_test else "failover",
            source="local-inference",
        )
        try:
            result = run_failsafe(args.mode, args.prompt, args.model, args.limit)
            print(json.dumps({"path": "local", "outage": True, **result}, indent=2))
            return 0
        except Exception as exc:
            log_event(
                severity="error",
                message="Local inference fallback failed",
                metadata={
                    "mode": args.mode,
                    "model": args.model,
                    "error": str(exc),
                },
                event_type="failover_error",
                source="local-inference",
            )
            print(f"[error] local fallback failed: {exc}", file=sys.stderr)
            return 2

    # If no outage, return status and skip local inference.
    print(
        json.dumps(
            {
                "path": "remote",
                "outage": False,
                "message": "Remote APIs are reachable; no fallback needed",
                "checks": outage_details,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
