#!/usr/bin/env python3
"""Vector memory health gate + alerting + deferred reindex queue."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

WORKSPACE = Path("/Users/hd/clawd")
STATE_PATH = WORKSPACE / "memory" / "vector-memory-health-state.json"
PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql"
DB = "cortana"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_state() -> dict[str, Any]:
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {
            "consecutive_embedding_429": 0,
            "fallback_mode": False,
            "reindex_queued": False,
        }


def save_state(state: dict[str, Any]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")


def run(cmd: list[str], timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def parse_json(raw: str) -> Any | None:
    raw = raw.strip()
    if not raw:
        return None
    m = re.search(r"[\[{]", raw)
    if m:
        raw = raw[m.start() :]
    try:
        return json.loads(raw)
    except Exception:
        return None


def get_memory_status() -> tuple[int, int, dict[str, Any]]:
    proc = run(["openclaw", "memory", "status", "--json"])
    payload = parse_json(proc.stdout)
    if not isinstance(payload, list) or not payload:
        return 0, 0, {"raw": (proc.stdout + proc.stderr)[:1000]}
    status = payload[0].get("status", {}) if isinstance(payload[0], dict) else {}
    files = int(status.get("files") or 0)
    chunks = int(status.get("chunks") or 0)
    return files, chunks, status if isinstance(status, dict) else {}


def is_embedding_429(text: str) -> bool:
    t = text.lower()
    pat = re.search(r"(resource_exhausted|embedd\w*[^\n]{0,80}429|429[^\n]{0,80}embedd\w*)", t)
    return bool(pat) and ("failed" in t or "error" in t or "quota" in t)


def sql_escape(s: str) -> str:
    return s.replace("'", "''")


def insert_incident(threat_type: str, severity: str, description: str, tier: int, metadata: dict[str, Any]) -> None:
    # dedupe open incidents by signature
    sig = threat_type
    dedupe_sql = (
        "SELECT COUNT(*) FROM cortana_immune_incidents "
        f"WHERE status='open' AND threat_signature='{sql_escape(sig)}';"
    )
    check = run([PSQL, DB, "-q", "-X", "-t", "-A", "-c", dedupe_sql])
    if check.returncode == 0 and check.stdout.strip().isdigit() and int(check.stdout.strip()) > 0:
        return

    meta_json = json.dumps(metadata).replace("'", "''")
    sql = (
        "INSERT INTO cortana_immune_incidents "
        "(detected_at, threat_type, source, severity, description, threat_signature, tier, status, playbook_used, auto_resolved, metadata) VALUES "
        f"(NOW(), '{sql_escape(threat_type)}', 'vector_memory_health', '{sql_escape(severity)}', "
        f"'{sql_escape(description)}', '{sql_escape(sig)}', {tier}, 'open', 'vector_memory_guard', FALSE, '{meta_json}'::jsonb);"
    )
    run([PSQL, DB, "-q", "-X", "-c", sql])


def attempt_probe() -> tuple[bool, str]:
    proc = run(["openclaw", "memory", "search", "vector health probe", "--json", "--max-results", "1"], timeout=90)
    combined = f"{proc.stdout}\n{proc.stderr}"
    return is_embedding_429(combined), combined


def attempt_reindex() -> tuple[bool, str]:
    proc = run(["openclaw", "memory", "index", "--force"], timeout=1800)
    out = (proc.stdout + "\n" + proc.stderr).strip()
    return proc.returncode == 0 and not is_embedding_429(out), out[:2000]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    state = load_state()
    files, chunks, status = get_memory_status()

    saw_429, probe_output = attempt_probe()
    if saw_429:
        state["consecutive_embedding_429"] = int(state.get("consecutive_embedding_429", 0)) + 1
    else:
        state["consecutive_embedding_429"] = 0

    if chunks == 0:
        state["fallback_mode"] = True
        state["reindex_queued"] = True
        state["queued_at"] = state.get("queued_at") or now_iso()
        insert_incident(
            "vector_index_empty",
            "critical",
            "Vector memory index has zero chunks; semantic retrieval unavailable.",
            1,
            {
                "files": files,
                "chunks": chunks,
                "provider": status.get("provider"),
                "model": status.get("model"),
            },
        )

    if int(state.get("consecutive_embedding_429", 0)) >= 3:
        state["fallback_mode"] = True
        state["reindex_queued"] = True
        state["queued_at"] = state.get("queued_at") or now_iso()
        insert_incident(
            "embedding_quota_429",
            "critical",
            "Embedding provider returned 429 three+ consecutive probes; switched to keyword fallback.",
            1,
            {
                "consecutive_429": state.get("consecutive_embedding_429", 0),
                "probe_excerpt": probe_output[:500],
                "provider": status.get("provider"),
                "model": status.get("model"),
            },
        )

    reindex_attempted = False
    reindex_ok = False
    reindex_note = ""
    if state.get("reindex_queued") and not saw_429:
        reindex_attempted = True
        reindex_ok, reindex_note = attempt_reindex()
        if reindex_ok:
            state["reindex_queued"] = False
            state["fallback_mode"] = False
            state["consecutive_embedding_429"] = 0
            state["last_reindex_ok_at"] = now_iso()
            state.pop("queued_at", None)
        else:
            state["last_reindex_error"] = reindex_note[:600]

    if chunks > 0 and int(state.get("consecutive_embedding_429", 0)) == 0 and not state.get("reindex_queued"):
        state["fallback_mode"] = False

    state["last_checked_at"] = now_iso()
    state["last_status"] = {
        "files": files,
        "chunks": chunks,
        "provider": status.get("provider"),
        "model": status.get("model"),
    }
    save_state(state)

    out = {
        "ok": chunks > 0,
        "files": files,
        "chunks": chunks,
        "consecutive_embedding_429": state.get("consecutive_embedding_429", 0),
        "fallback_mode": state.get("fallback_mode", False),
        "reindex_queued": state.get("reindex_queued", False),
        "reindex_attempted": reindex_attempted,
        "reindex_ok": reindex_ok,
    }
    if args.json:
        print(json.dumps(out))
    else:
        print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
