#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DB_BIN = "/opt/homebrew/opt/postgresql@17/bin"
DB_NAME = "cortana"
WORKSPACE = Path(__file__).resolve().parents[2]
THRESHOLD_PATH = WORKSPACE / "config" / "alert-thresholds.json"
LATEST_AUDIT_PATH = WORKSPACE / "reports" / "proactive-signal-audit.json"
VALID_CATEGORIES = ["portfolio", "email", "calendar", "weather", "health", "tech_news"]
NOISE_TOKENS = ["noise", "noisy", "too many alerts", "spam", "alert fatigue", "irrelevant"]
ACTION_TASK_STATUSES = {"completed", "in_progress"}


@dataclass
class AlertRecord:
    alert_id: int
    timestamp: str
    category: str
    source: str
    event_type: str
    message: str
    metadata: dict[str, Any]
    noise_flagged: bool = False
    led_to_action: bool = False
    task_id: int | None = None
    task_status: str | None = None
    user_response_within_30m: bool = False


def run_psql(sql: str) -> str:
    env = os.environ.copy()
    env["PATH"] = f"{DB_BIN}:{env.get('PATH', '')}"
    p = subprocess.run(
        ["psql", DB_NAME, "-q", "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql],
        capture_output=True,
        text=True,
        env=env,
    )
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip() or "psql failed")
    return p.stdout.strip()


def fetch_json(sql: str) -> list[dict[str, Any]]:
    wrapped = f"SELECT COALESCE(json_agg(t),'[]'::json)::text FROM ({sql}) t;"
    raw = run_psql(wrapped)
    return json.loads(raw) if raw else []


def exists(table: str) -> bool:
    safe = table.replace("'", "''")
    return (run_psql(f"SELECT to_regclass('{safe}') IS NOT NULL;") or "").strip().lower() == "t"


def has_col(table: str, col: str) -> bool:
    t = table.replace("'", "''")
    c = col.replace("'", "''")
    q = (
        "SELECT EXISTS (SELECT 1 FROM information_schema.columns "
        f"WHERE table_schema='public' AND table_name='{t}' AND column_name='{c}');"
    )
    return (run_psql(q) or "").strip().lower() == "t"


def parse_ts(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def detect_category(signal_type: str, event_type: str, source: str, message: str, metadata: dict[str, Any]) -> str:
    md_text = json.dumps(metadata or {}, default=str).lower()
    haystack = " ".join([
        str(signal_type or "").lower(),
        str(event_type or "").lower(),
        str(source or "").lower(),
        str(message or "").lower(),
        md_text,
    ])

    checks = {
        "portfolio": ["portfolio", "watchlist", "position", "trade", "canslim", "market"],
        "email": ["email", "gmail", "inbox", "mail"],
        "calendar": ["calendar", "meeting", "event", "khal", "caldav"],
        "weather": ["weather", "forecast", "rain", "temperature"],
        "health": ["health", "whoop", "tonal", "fitness", "recovery", "sleep", "strain"],
        "tech_news": ["tech_news", "tech news", "newsletter", "hacker news", "github"],
    }

    for cat, tokens in checks.items():
        if any(tok in haystack for tok in tokens):
            return cat
    return "tech_news"


def load_alerts(days: int) -> list[AlertRecord]:
    rows: list[dict[str, Any]] = []

    if exists("cortana_proactive_signals"):
        q = f"""
        SELECT
          id::bigint AS alert_id,
          created_at,
          COALESCE(signal_type,'') AS signal_type,
          COALESCE(source,'') AS source,
          COALESCE(title,'') AS message,
          COALESCE(metadata,'{{}}'::jsonb) AS metadata,
          'proactive_signal'::text AS event_type
        FROM cortana_proactive_signals
        WHERE created_at >= NOW() - INTERVAL '{int(days)} days'
        """
        rows.extend(fetch_json(q))

    if exists("cortana_events"):
        # Fallback / supplemental proactive signals logged as events.
        q = f"""
        SELECT
          id::bigint AS alert_id,
          timestamp AS created_at,
          COALESCE(metadata->>'signal_type', metadata->>'category', event_type, '') AS signal_type,
          COALESCE(source,'') AS source,
          COALESCE(message,'') AS message,
          COALESCE(metadata,'{{}}'::jsonb) AS metadata,
          COALESCE(event_type,'') AS event_type
        FROM cortana_events
        WHERE timestamp >= NOW() - INTERVAL '{int(days)} days'
          AND (
            event_type ILIKE 'proactive%'
            OR source ILIKE 'proactive%'
            OR metadata::text ILIKE '%heartbeat%'
            OR metadata::text ILIKE '%watchlist%'
            OR metadata::text ILIKE '%portfolio%'
            OR message ILIKE '%alert%'
          )
        """
        rows.extend(fetch_json(q))

    dedup: dict[tuple[str, str, str], AlertRecord] = {}
    for r in rows:
        created = str(r.get("created_at") or "")
        source = str(r.get("source") or "")
        event_type = str(r.get("event_type") or "")
        message = str(r.get("message") or "")
        metadata = r.get("metadata") if isinstance(r.get("metadata"), dict) else {}
        signal_type = str(r.get("signal_type") or "")
        category = detect_category(signal_type, event_type, source, message, metadata)
        aid = int(r.get("alert_id") or 0)
        key = (created, category, message[:80])
        if key in dedup:
            continue
        dedup[key] = AlertRecord(
            alert_id=aid,
            timestamp=created,
            category=category,
            source=source,
            event_type=event_type,
            message=message,
            metadata=metadata,
        )

    return sorted(dedup.values(), key=lambda a: a.timestamp)


def find_noise_feedback(days: int) -> list[dict[str, Any]]:
    if not exists("cortana_feedback"):
        return []
    where_noise = " OR ".join(
        [f"context ILIKE '%{tok}%' OR lesson ILIKE '%{tok}%'" for tok in NOISE_TOKENS]
    )
    q = f"""
    SELECT id, timestamp, feedback_type, context, lesson
    FROM cortana_feedback
    WHERE timestamp >= NOW() - INTERVAL '{int(days)} days'
      AND ({where_noise})
    ORDER BY timestamp ASC
    """
    return fetch_json(q)


def mark_noise_flags(alerts: list[AlertRecord], feedback_rows: list[dict[str, Any]]) -> None:
    for fb in feedback_rows:
        context = f"{fb.get('context','')} {fb.get('lesson','')}".lower()
        for a in alerts:
            if a.category in context:
                a.noise_flagged = True


def load_tasks(days: int) -> list[dict[str, Any]]:
    if not exists("cortana_tasks"):
        return []

    where_parts = [f"created_at >= NOW() - INTERVAL '{int(days)} days'"]
    if has_col("cortana_tasks", "source"):
        where_parts.append("(source ILIKE '%proactive%' OR source ILIKE '%heartbeat%' OR source ILIKE '%watchlist%')")
    where_sql = " AND ".join(where_parts)
    q = f"""
    SELECT id, created_at, status, source, title, description, metadata
    FROM cortana_tasks
    WHERE {where_sql}
    ORDER BY created_at ASC
    """
    return fetch_json(q)


def load_user_response_events(days: int) -> list[dict[str, Any]]:
    if not exists("cortana_events"):
        return []
    q = f"""
    SELECT id, timestamp, source, event_type, message, metadata
    FROM cortana_events
    WHERE timestamp >= NOW() - INTERVAL '{int(days)} days'
      AND (
        event_type ILIKE '%message%'
        OR event_type ILIKE '%reply%'
        OR source ILIKE '%telegram%'
        OR source ILIKE '%chat%'
        OR message ILIKE '%task done%'
      )
    ORDER BY timestamp ASC
    """
    return fetch_json(q)


def correlate_actions(alerts: list[AlertRecord], tasks: list[dict[str, Any]], user_events: list[dict[str, Any]]) -> None:
    for alert in alerts:
        ats = parse_ts(alert.timestamp)
        if not ats:
            continue

        for t in tasks:
            tts = parse_ts(str(t.get("created_at") or ""))
            if not tts:
                continue
            # Task created up to 30 minutes after alert and appears related by category/text.
            if 0 <= (tts - ats).total_seconds() <= 1800:
                searchable = " ".join([
                    str(t.get("title") or "").lower(),
                    str(t.get("description") or "").lower(),
                    json.dumps(t.get("metadata") if isinstance(t.get("metadata"), dict) else {}, default=str).lower(),
                ])
                if alert.category in searchable or "proactive" in searchable or "alert" in searchable:
                    alert.task_id = int(t.get("id") or 0)
                    alert.task_status = str(t.get("status") or "")
                    if alert.task_status.lower() in ACTION_TASK_STATUSES:
                        alert.led_to_action = True
                    break

        for ue in user_events:
            uts = parse_ts(str(ue.get("timestamp") or ""))
            if not uts:
                continue
            if 0 <= (uts - ats).total_seconds() <= 1800:
                payload = " ".join([
                    str(ue.get("event_type") or "").lower(),
                    str(ue.get("source") or "").lower(),
                    str(ue.get("message") or "").lower(),
                    json.dumps(ue.get("metadata") if isinstance(ue.get("metadata"), dict) else {}, default=str).lower(),
                ])
                if any(k in payload for k in ["telegram", "reply", "message", "task done", "mark task"]):
                    alert.user_response_within_30m = True
                    alert.led_to_action = True
                    break


def summarize(alerts: list[AlertRecord], days: int) -> dict[str, Any]:
    counts = Counter(a.category for a in alerts)
    by_cat: dict[str, dict[str, Any]] = {}

    for cat in VALID_CATEGORIES:
        cat_alerts = [a for a in alerts if a.category == cat]
        total = len(cat_alerts)
        actions = sum(1 for a in cat_alerts if a.led_to_action)
        noise = sum(1 for a in cat_alerts if a.noise_flagged)
        precision = (actions / total) if total else None
        by_cat[cat] = {
            "total_alerts": total,
            "alerts_that_led_to_action": actions,
            "noise_flagged": noise,
            "precision": round(precision, 4) if precision is not None else None,
        }

    total_alerts = len(alerts)
    action_alerts = sum(1 for a in alerts if a.led_to_action)
    noise_total = sum(1 for a in alerts if a.noise_flagged)
    overall_precision = (action_alerts / total_alerts) if total_alerts else None

    top_noise = sorted(
        (
            {
                "category": cat,
                "total_alerts": v["total_alerts"],
                "action_alerts": v["alerts_that_led_to_action"],
                "precision": v["precision"],
            }
            for cat, v in by_cat.items()
            if v["total_alerts"] >= 1 and (v["precision"] is None or v["precision"] < 0.35)
        ),
        key=lambda x: (-(x["total_alerts"]), x["precision"] if x["precision"] is not None else -1),
    )

    recommendations: list[str] = []
    thresholds = load_thresholds()
    for cat in VALID_CATEGORIES:
        cat_stats = by_cat[cat]
        precision = cat_stats["precision"]
        current = thresholds.get(cat)
        if current is None:
            continue
        if cat_stats["total_alerts"] == 0:
            recommendations.append(f"{cat}: no recent signal volume — keep threshold at {current:.2f} until more data.")
        elif precision is not None and precision < 0.35:
            bump = min(0.95, round(current + 0.1, 2))
            recommendations.append(f"{cat}: low precision ({precision:.2f}); raise threshold {current:.2f} -> {bump:.2f}.")
        elif precision is not None and precision > 0.75 and cat_stats["total_alerts"] >= 5:
            drop = max(0.3, round(current - 0.05, 2))
            recommendations.append(f"{cat}: high precision ({precision:.2f}); consider lowering threshold {current:.2f} -> {drop:.2f} for more recall.")

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window_days": days,
        "overall": {
            "total_alerts": total_alerts,
            "alerts_that_led_to_action": action_alerts,
            "noise_flagged_total": noise_total,
            "precision": round(overall_precision, 4) if overall_precision is not None else None,
        },
        "counts_by_type": dict(counts),
        "per_category": by_cat,
        "top_noise_sources": top_noise,
        "recommendations": recommendations,
        "sample_alerts": [
            {
                "timestamp": a.timestamp,
                "category": a.category,
                "source": a.source,
                "event_type": a.event_type,
                "message": a.message[:140],
                "noise_flagged": a.noise_flagged,
                "led_to_action": a.led_to_action,
                "task_id": a.task_id,
                "task_status": a.task_status,
                "user_response_within_30m": a.user_response_within_30m,
            }
            for a in alerts[-20:]
        ],
    }


def load_thresholds() -> dict[str, float]:
    if not THRESHOLD_PATH.exists():
        return {}
    try:
        data = json.loads(THRESHOLD_PATH.read_text())
    except json.JSONDecodeError:
        return {}
    out: dict[str, float] = {}
    for k, v in data.items():
        try:
            out[k] = float(v)
        except (TypeError, ValueError):
            continue
    return out


def save_thresholds(data: dict[str, float]) -> None:
    THRESHOLD_PATH.parent.mkdir(parents=True, exist_ok=True)
    ordered = {k: data[k] for k in VALID_CATEGORIES if k in data}
    THRESHOLD_PATH.write_text(json.dumps(ordered, indent=2) + "\n")


def cmd_audit(days: int) -> int:
    alerts = load_alerts(days)
    feedback = find_noise_feedback(days)
    mark_noise_flags(alerts, feedback)
    tasks = load_tasks(days)
    user_events = load_user_response_events(days)
    correlate_actions(alerts, tasks, user_events)

    result = summarize(alerts, days)
    LATEST_AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
    LATEST_AUDIT_PATH.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    return 0


def cmd_report() -> int:
    if not LATEST_AUDIT_PATH.exists():
        print("No audit report found. Run: signal_calibrator.py audit --days 30")
        return 1
    data = json.loads(LATEST_AUDIT_PATH.read_text())

    overall = data.get("overall", {})
    print("Signal Quality Summary")
    print("======================")
    print(f"Window: last {data.get('window_days')} days")
    print(f"Total alerts: {overall.get('total_alerts', 0)}")
    print(f"Alerts with action: {overall.get('alerts_that_led_to_action', 0)}")
    print(f"Precision: {overall.get('precision')}")
    print()
    print("Per-category precision")
    for cat in VALID_CATEGORIES:
        row = data.get("per_category", {}).get(cat, {})
        print(
            f"- {cat}: precision={row.get('precision')} "
            f"(alerts={row.get('total_alerts', 0)}, actions={row.get('alerts_that_led_to_action', 0)}, noise={row.get('noise_flagged', 0)})"
        )

    print()
    print("Top noise sources")
    noise = data.get("top_noise_sources", [])
    if not noise:
        print("- none detected")
    else:
        for n in noise:
            print(
                f"- {n.get('category')}: alerts={n.get('total_alerts')}, "
                f"action_alerts={n.get('action_alerts')}, precision={n.get('precision')}"
            )

    print()
    print("Recommendations")
    recs = data.get("recommendations", [])
    if not recs:
        print("- no threshold changes recommended")
    else:
        for rec in recs:
            print(f"- {rec}")
    return 0


def cmd_tune(category: str, threshold: float) -> int:
    if category not in VALID_CATEGORIES:
        raise SystemExit(f"Invalid category '{category}'. Valid: {', '.join(VALID_CATEGORIES)}")
    if threshold < 0 or threshold > 1:
        raise SystemExit("Threshold must be between 0 and 1.")

    data = load_thresholds()
    for cat in VALID_CATEGORIES:
        data.setdefault(cat, 0.6)
    old = data.get(category)
    data[category] = round(threshold, 4)
    save_thresholds(data)

    print(
        json.dumps(
            {
                "category": category,
                "old_threshold": old,
                "new_threshold": data[category],
                "config_path": str(THRESHOLD_PATH),
            },
            indent=2,
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="Audit and tune proactive alert signal precision.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_audit = sub.add_parser("audit", help="Analyze proactive alerts and compute precision")
    p_audit.add_argument("--days", type=int, default=30, help="Lookback window in days")

    sub.add_parser("report", help="Render summary from latest audit")

    p_tune = sub.add_parser("tune", help="Adjust per-category alert threshold")
    p_tune.add_argument("--category", required=True, choices=VALID_CATEGORIES)
    p_tune.add_argument("--threshold", required=True, type=float)

    return ap


def main() -> int:
    ap = build_parser()
    args = ap.parse_args()

    if args.cmd == "audit":
        return cmd_audit(args.days)
    if args.cmd == "report":
        return cmd_report()
    if args.cmd == "tune":
        return cmd_tune(args.category, args.threshold)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
