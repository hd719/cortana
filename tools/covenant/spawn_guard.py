#!/usr/bin/env python3
"""Idempotency guard for sub-agent launches.

Prevents concurrent duplicate launches with the same normalized label/task key.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

WORKSPACE_ROOT = Path("/Users/hd/openclaw")
REGISTRY_PATH = WORKSPACE_ROOT / "tmp" / "spawn_guard_registry.json"
LIFECYCLE_CLI = WORKSPACE_ROOT / "tools" / "covenant" / "lifecycle_events.py"
DEFAULT_TTL_SECONDS = 3600


@dataclass
class GuardEntry:
    key: str
    normalized_label: str
    task_id: int | None
    label: str
    run_id: str
    state: str
    started_at: int
    updated_at: int
    ttl_seconds: int
    metadata: dict[str, Any]

    def is_active(self, now: int) -> bool:
        if self.state != "running":
            return False
        return now <= (self.updated_at + self.ttl_seconds)


def _ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def _norm_label(label: str) -> str:
    compact = re.sub(r"[^a-z0-9]+", "-", label.strip().lower())
    compact = re.sub(r"-+", "-", compact).strip("-")
    return compact or "unnamed"


def dedupe_key(label: str, task_id: int | None) -> str:
    nl = _norm_label(label)
    tid = f"task:{task_id}" if task_id is not None else "task:none"
    return f"{tid}|label:{nl}"


def _load_registry() -> dict[str, Any]:
    if not REGISTRY_PATH.exists():
        return {"entries": {}}
    try:
        raw = json.loads(REGISTRY_PATH.read_text())
        if not isinstance(raw, dict):
            return {"entries": {}}
        if not isinstance(raw.get("entries"), dict):
            raw["entries"] = {}
        return raw
    except Exception:
        return {"entries": {}}


def _save_registry(registry: dict[str, Any]) -> None:
    _ensure_parent(REGISTRY_PATH)
    REGISTRY_PATH.write_text(json.dumps(registry, indent=2) + "\n")


def _log_decision(event: str, payload: dict[str, Any], db: str = "cortana") -> None:
    payload = dict(payload)
    payload["decision_event"] = event

    if LIFECYCLE_CLI.exists():
        sql = (
            "SELECT cortana_event_bus_publish("
            "'agent_spawn_dedupe', "
            "'spawn_guard', "
            f"'{json.dumps(payload).replace("'", "''")}'::jsonb, NULL);"
        )
        env = os.environ.copy()
        env["PATH"] = "/opt/homebrew/opt/postgresql@17/bin:" + env.get("PATH", "")
        proc = subprocess.run(
            ["/opt/homebrew/opt/postgresql@17/bin/psql", db, "-X", "-q", "-At", "-c", sql],
            capture_output=True,
            text=True,
            env=env,
        )
        if proc.returncode == 0:
            return

    fallback_log = WORKSPACE_ROOT / "reports" / "spawn_guard.decisions.jsonl"
    _ensure_parent(fallback_log)
    with fallback_log.open("a") as f:
        f.write(json.dumps({"ts": int(time.time()), **payload}) + "\n")


def claim(label: str, run_id: str, task_id: int | None, ttl_seconds: int, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    key = dedupe_key(label, task_id)
    now = int(time.time())
    normalized_label = _norm_label(label)
    metadata = metadata or {}

    _ensure_parent(REGISTRY_PATH)
    with REGISTRY_PATH.open("a+") as lockf:
        fcntl.flock(lockf.fileno(), fcntl.LOCK_EX)

        registry = _load_registry()
        entries: dict[str, Any] = registry.setdefault("entries", {})

        # prune expired/non-running entries older than ttl window
        for k, v in list(entries.items()):
            try:
                state = v.get("state")
                updated_at = int(v.get("updated_at", 0))
                ttl = int(v.get("ttl_seconds", DEFAULT_TTL_SECONDS))
                if state != "running" and now > (updated_at + ttl):
                    entries.pop(k, None)
                elif state == "running" and now > (updated_at + ttl):
                    v["state"] = "expired"
                    v["updated_at"] = now
            except Exception:
                entries.pop(k, None)

        existing = entries.get(key)
        if isinstance(existing, dict) and GuardEntry(**existing).is_active(now):
            result = {
                "action": "deduped",
                "reason": "active_run_exists",
                "key": key,
                "existing": existing,
            }
            _log_decision("deduped", result)
            _save_registry(registry)
            fcntl.flock(lockf.fileno(), fcntl.LOCK_UN)
            return result

        entry = GuardEntry(
            key=key,
            normalized_label=normalized_label,
            task_id=task_id,
            label=label,
            run_id=run_id,
            state="running",
            started_at=now,
            updated_at=now,
            ttl_seconds=ttl_seconds,
            metadata=metadata,
        )
        entries[key] = asdict(entry)
        _save_registry(registry)
        result = {"action": "claimed", "key": key, "entry": asdict(entry)}
        _log_decision("claimed", result)
        fcntl.flock(lockf.fileno(), fcntl.LOCK_UN)
        return result


def release(label: str, task_id: int | None, run_id: str, final_state: str = "completed") -> dict[str, Any]:
    key = dedupe_key(label, task_id)
    now = int(time.time())

    _ensure_parent(REGISTRY_PATH)
    with REGISTRY_PATH.open("a+") as lockf:
        fcntl.flock(lockf.fileno(), fcntl.LOCK_EX)
        registry = _load_registry()
        entries = registry.setdefault("entries", {})
        existing = entries.get(key)
        if not isinstance(existing, dict):
            fcntl.flock(lockf.fileno(), fcntl.LOCK_UN)
            return {"action": "noop", "reason": "missing_key", "key": key}

        if existing.get("run_id") != run_id:
            fcntl.flock(lockf.fileno(), fcntl.LOCK_UN)
            return {"action": "noop", "reason": "run_id_mismatch", "key": key, "existing": existing}

        existing["state"] = final_state
        existing["updated_at"] = now
        _save_registry(registry)
        result = {"action": "released", "key": key, "entry": existing}
        _log_decision("released", result)
        fcntl.flock(lockf.fileno(), fcntl.LOCK_UN)
        return result


def demo() -> int:
    task_id = 4242
    label = "Huragok migration hygiene"
    first = claim(label=label, task_id=task_id, run_id="run-A", ttl_seconds=120)
    second = claim(label=label, task_id=task_id, run_id="run-B", ttl_seconds=120)
    released = release(label=label, task_id=task_id, run_id="run-A")

    print(json.dumps({"first": first, "second": second, "released": released}, indent=2))
    return 0 if second.get("action") == "deduped" else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Sub-agent spawn dedupe guard")
    sub = parser.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("claim", help="Claim dedupe key before spawn")
    c.add_argument("--label", required=True)
    c.add_argument("--run-id", required=True)
    c.add_argument("--task-id", type=int)
    c.add_argument("--ttl-seconds", type=int, default=DEFAULT_TTL_SECONDS)
    c.add_argument("--metadata", help="JSON metadata", default="{}")

    r = sub.add_parser("release", help="Release key when run finishes")
    r.add_argument("--label", required=True)
    r.add_argument("--run-id", required=True)
    r.add_argument("--task-id", type=int)
    r.add_argument("--state", default="completed")

    sub.add_parser("demo", help="Run a local dedupe simulation")

    args = parser.parse_args()

    if args.cmd == "claim":
        try:
            md = json.loads(args.metadata)
            if not isinstance(md, dict):
                raise ValueError("metadata must be object")
        except Exception as exc:
            print(f"invalid metadata json: {exc}", file=sys.stderr)
            return 2
        result = claim(args.label, args.run_id, args.task_id, args.ttl_seconds, md)
        print(json.dumps(result, indent=2))
        return 0 if result.get("action") in {"claimed", "deduped"} else 1

    if args.cmd == "release":
        result = release(args.label, args.task_id, args.run_id, args.state)
        print(json.dumps(result, indent=2))
        return 0

    if args.cmd == "demo":
        return demo()

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
