#!/usr/bin/env python3
import json
import os
import re
import subprocess
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

SESSION_DIR = Path.home() / ".openclaw" / "agents" / "main" / "sessions"
OUTPUT_PATH = Path("/tmp/efficiency_analysis.json")
PSQL_BIN = "/opt/homebrew/opt/postgresql@17/bin/psql"
COST_PER_KB = 0.015
TOP_N = 5


def round_money(v: float) -> float:
    return round(v + 1e-12, 4)


def safe_read_first_line(path: Path) -> str:
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as f:
            return (f.readline() or "").strip()
    except Exception:
        return ""


def extract_label_from_first_line(line: str) -> str | None:
    if not line:
        return None
    try:
        obj = json.loads(line)
    except Exception:
        return None

    # Best-effort label extraction from common shapes.
    candidates = []
    if isinstance(obj, dict):
        candidates.extend([
            obj.get("label"),
            obj.get("sessionLabel"),
            obj.get("name"),
            obj.get("title"),
        ])
        meta = obj.get("metadata")
        if isinstance(meta, dict):
            candidates.extend([
                meta.get("label"),
                meta.get("sessionLabel"),
                meta.get("cronLabel"),
                meta.get("jobName"),
            ])

    for c in candidates:
        if isinstance(c, str) and c.strip():
            return c.strip()
    return None


def extract_label_from_filename(name: str) -> str:
    stem = name[:-6] if name.endswith(".jsonl") else name

    # Common cron naming patterns.
    patterns = [
        r"cron[-_](.+)$",
        r"job[-_](.+)$",
        r"scheduled[-_](.+)$",
    ]
    for p in patterns:
        m = re.search(p, stem, flags=re.IGNORECASE)
        if m:
            label = m.group(1)
            label = re.sub(r"[_-]+", " ", label).strip()
            return label[:120] if label else "unknown"

    # Strip obvious IDs/timestamps; keep meaningful tokens.
    cleaned = re.sub(r"\b[0-9a-f]{8,}\b", "", stem, flags=re.IGNORECASE)
    cleaned = re.sub(r"\b\d{4,}\b", "", cleaned)
    cleaned = re.sub(r"[_-]+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return (cleaned[:120] if cleaned else "unknown")


def is_subagent_file(path: Path, first_line: str) -> bool:
    name = path.name.lower()
    if "subagent" in name:
        return True
    if re.search(r"agent:main:subagent", first_line, flags=re.IGNORECASE):
        return True
    if re.search(r'"session"\s*:\s*"[^"]*subagent', first_line, flags=re.IGNORECASE):
        return True
    if re.search(r'"label"\s*:\s*"[^"]*subagent', first_line, flags=re.IGNORECASE):
        return True
    return False


def analyze_sessions() -> tuple[list[dict], float, int, list[str]]:
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=7)

    cost_by_label = defaultdict(float)
    kb_by_label = defaultdict(float)

    subagent_cost = 0.0
    subagent_count = 0
    total_cron_cost = 0.0

    if not SESSION_DIR.exists() or not SESSION_DIR.is_dir():
        return [], 0.0, 0, [f"session directory missing: {SESSION_DIR}"]

    try:
        files = [p for p in SESSION_DIR.rglob("*.jsonl") if p.is_file()]
    except Exception as e:
        return [], 0.0, 0, [f"failed scanning session directory: {e}"]

    for p in files:
        try:
            mtime = datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc)
            if mtime < cutoff:
                continue
            size_kb = p.stat().st_size / 1024.0
            cost = size_kb * COST_PER_KB
            first_line = safe_read_first_line(p)

            if is_subagent_file(p, first_line):
                subagent_count += 1
                subagent_cost += cost
                continue

            label = extract_label_from_first_line(first_line) or extract_label_from_filename(p.name)
            kb_by_label[label] += size_kb
            cost_by_label[label] += cost
            total_cron_cost += cost
        except Exception:
            continue

    top = sorted(cost_by_label.items(), key=lambda kv: kv[1], reverse=True)[:TOP_N]
    top_cost_crons = [
        {
            "name": name,
            "size_kb": round(kb_by_label[name], 2),
            "est_cost": round_money(cost),
        }
        for name, cost in top
    ]

    anomalies = []
    if total_cron_cost > 0:
        for name, cost in sorted(cost_by_label.items(), key=lambda kv: kv[1], reverse=True):
            share = cost / total_cron_cost
            if share > 0.30:
                anomalies.append(f"cron '{name}' is {share * 100:.1f}% of weekly cron spend")

    return top_cost_crons, round_money(subagent_cost), subagent_count, anomalies


def run_psql(sql: str) -> tuple[bool, str]:
    try:
        proc = subprocess.run(
            [PSQL_BIN, "cortana", "-t", "-A", "-c", sql],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
    except Exception as e:
        return False, str(e)

    if proc.returncode != 0:
        return False, (proc.stderr or proc.stdout or "").strip()
    return True, (proc.stdout or "").strip()


def compute_brief_engagement_rate() -> tuple[float | None, str | None]:
    # Try a few schema variants; if none work, return null.
    queries = [
        """
        SELECT CASE
            WHEN COUNT(*) = 0 THEN NULL
            ELSE ROUND(SUM(CASE WHEN (responded_at IS NOT NULL AND responded_at <= brief_at + INTERVAL '2 hours') THEN 1 ELSE 0 END)::numeric / COUNT(*), 4)
        END
        FROM cortana_feedback_signals
        WHERE brief_at >= NOW() - INTERVAL '7 days'
          AND (signal_type ILIKE '%brief%' OR metadata::text ILIKE '%brief%');
        """,
        """
        SELECT CASE
            WHEN COUNT(*) = 0 THEN NULL
            ELSE ROUND(SUM(CASE WHEN (responded_at IS NOT NULL AND responded_at <= timestamp + INTERVAL '2 hours') THEN 1 ELSE 0 END)::numeric / COUNT(*), 4)
        END
        FROM cortana_feedback_signals
        WHERE timestamp >= NOW() - INTERVAL '7 days'
          AND (signal_type ILIKE '%brief%' OR metadata::text ILIKE '%brief%');
        """,
        """
        SELECT CASE
            WHEN COUNT(*) = 0 THEN NULL
            ELSE ROUND(AVG(CASE WHEN (metadata->>'responded_within_2h')::boolean THEN 1.0 ELSE 0.0 END)::numeric, 4)
        END
        FROM cortana_feedback_signals
        WHERE COALESCE(timestamp, created_at, NOW()) >= NOW() - INTERVAL '7 days'
          AND (COALESCE(signal_type, '') ILIKE '%brief%' OR metadata::text ILIKE '%brief%');
        """,
    ]

    last_err = None
    for q in queries:
        ok, out = run_psql(q)
        if not ok:
            last_err = out
            continue

        out = out.strip()
        if out == "" or out.lower() == "null":
            return None, None
        try:
            return float(out.splitlines()[-1].strip()), None
        except Exception:
            last_err = f"unexpected psql output: {out[:120]}"

    if last_err:
        err_lower = last_err.lower()
        if "does not exist" in err_lower or "relation" in err_lower:
            return None, None
    return None, last_err


def main() -> int:
    top_cost_crons, subagent_cost, subagent_count, anomalies = analyze_sessions()
    brief_rate, brief_err = compute_brief_engagement_rate()

    if brief_err:
        anomalies.append(f"brief engagement query issue: {brief_err[:140]}")

    result = {
        "top_cost_crons": top_cost_crons,
        "subagent_cost_7d": subagent_cost,
        "subagent_spawn_count": subagent_count,
        "brief_engagement_rate": brief_rate,
        "analysis_date": datetime.now(timezone.utc).isoformat(),
        "anomalies": anomalies,
    }

    try:
        OUTPUT_PATH.write_text(json.dumps(result, indent=2), encoding="utf-8")
    except Exception as e:
        # Last-resort fallback to stdout for visibility while still signaling failure.
        print(json.dumps({"error": f"failed to write output: {e}"}))
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
