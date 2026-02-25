#!/usr/bin/env python3
"""Behavioral Pattern Detection v2.

- Pulls data from cortana_patterns, cortana_feedback, cortana_events
- Computes simple co-occurrence/timing correlations
- Emits weekly digest
- Stores detected insights back into cortana_patterns (pattern_type='insight')
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from typing import Any

ET = ZoneInfo("America/New_York")
DB_PATH = "/opt/homebrew/opt/postgresql@17/bin"


@dataclass
class Insight:
    key: str
    summary: str
    strength: float
    support_days: int
    metadata: dict[str, Any]


def sql_escape(v: str) -> str:
    return v.replace("'", "''")


def run_psql(sql: str) -> str:
    env = os.environ.copy()
    env["PATH"] = f"{DB_PATH}:{env.get('PATH', '')}"
    cmd = ["psql", "cortana", "-q", "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql]
    p = subprocess.run(cmd, text=True, capture_output=True, env=env)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip() or "psql failed")
    return p.stdout.strip()


def fetch_json(sql: str) -> list[dict[str, Any]]:
    wrapped = f"SELECT COALESCE(json_agg(t), '[]'::json)::text FROM ({sql}) t;"
    raw = run_psql(wrapped)
    return json.loads(raw) if raw else []


def parse_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    txt = str(value).strip()
    m = re.search(r"-?\d+(?:\.\d+)?", txt)
    return float(m.group(0)) if m else None


def parse_time_minutes(value: Any) -> int | None:
    if value is None:
        return None
    txt = str(value).strip()
    m = re.search(r"\b([01]?\d|2[0-3]):([0-5]\d)\b", txt)
    if not m:
        return None
    h = int(m.group(1))
    mm = int(m.group(2))
    return h * 60 + mm


def to_local_date(ts: str) -> datetime.date:
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return dt.astimezone(ET).date()


def load_data(days: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    pats = fetch_json(
        "SELECT timestamp, pattern_type, value, day_of_week, metadata "
        "FROM cortana_patterns "
        f"WHERE timestamp >= NOW() - INTERVAL '{int(days)} days' "
        "ORDER BY timestamp ASC"
    )
    fb = fetch_json(
        "SELECT timestamp, feedback_type, context, lesson, applied "
        "FROM cortana_feedback "
        f"WHERE timestamp >= NOW() - INTERVAL '{int(days)} days' "
        "ORDER BY timestamp ASC"
    )
    ev = fetch_json(
        "SELECT timestamp, event_type, source, severity, message, metadata "
        "FROM cortana_events "
        f"WHERE timestamp >= NOW() - INTERVAL '{int(days)} days' "
        "ORDER BY timestamp ASC"
    )
    return pats, fb, ev


def build_daily_features(patterns: list[dict[str, Any]], feedback: list[dict[str, Any]], events: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    days: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "workout_before_6": False,
        "workout_any": False,
        "sleep_before_23": False,
        "wake_before_7": False,
        "sleep_quality_values": [],
        "error_events": 0,
        "warning_events": 0,
        "corrections": 0,
        "positive_feedback": 0,
    })

    for r in patterns:
        ts = r.get("timestamp")
        if not ts:
            continue
        d = to_local_date(ts).isoformat()
        ptype = str(r.get("pattern_type") or "").lower()
        value = r.get("value")
        md = r.get("metadata") if isinstance(r.get("metadata"), dict) else {}

        tmin = parse_time_minutes(value)
        if tmin is None and isinstance(md, dict):
            tmin = parse_time_minutes(md.get("time") or md.get("start") or md.get("start_time"))

        if any(k in ptype for k in ["workout", "exercise", "tonal", "train"]):
            days[d]["workout_any"] = True
            if tmin is not None and tmin < 360:
                days[d]["workout_before_6"] = True

        if any(k in ptype for k in ["sleep", "sleep_quality", "sleep_score"]):
            q = parse_float(value)
            if q is None and isinstance(md, dict):
                for k in ["score", "quality", "sleep_score"]:
                    if k in md:
                        q = parse_float(md[k])
                        if q is not None:
                            break
            if q is not None:
                days[d]["sleep_quality_values"].append(q)

            if any(k in ptype for k in ["sleep_start", "bed", "bedtime"]):
                if tmin is not None and tmin < 23 * 60:
                    days[d]["sleep_before_23"] = True

        if any(k in ptype for k in ["wake", "wake_time"]):
            if tmin is not None and tmin < 7 * 60:
                days[d]["wake_before_7"] = True

    for r in events:
        ts = r.get("timestamp")
        if not ts:
            continue
        d = to_local_date(ts).isoformat()
        sev = str(r.get("severity") or "").lower()
        if sev in {"error", "critical", "fatal"}:
            days[d]["error_events"] += 1
        elif sev in {"warn", "warning"}:
            days[d]["warning_events"] += 1

    for r in feedback:
        ts = r.get("timestamp")
        if not ts:
            continue
        d = to_local_date(ts).isoformat()
        ftype = str(r.get("feedback_type") or "").lower()
        if ftype in {"correction", "behavior", "tone"}:
            days[d]["corrections"] += 1
        elif ftype in {"preference", "fact", "decision"}:
            days[d]["positive_feedback"] += 1

    for d in list(days.keys()):
        vals = days[d]["sleep_quality_values"]
        days[d]["sleep_quality_avg"] = statistics.mean(vals) if vals else None

    return days


def correlation_binary_vs_numeric(days: dict[str, dict[str, Any]], feature: str, outcome: str) -> tuple[float, int, int, float, float] | None:
    yes, no = [], []
    for row in days.values():
        out = row.get(outcome)
        if out is None:
            continue
        (yes if bool(row.get(feature)) else no).append(float(out))
    if len(yes) < 3 or len(no) < 3:
        return None
    mean_yes = statistics.mean(yes)
    mean_no = statistics.mean(no)
    diff = mean_yes - mean_no
    pooled = statistics.pstdev(yes + no) or 1.0
    strength = diff / pooled
    return strength, len(yes), len(no), mean_yes, mean_no


def correlation_binary_vs_count(days: dict[str, dict[str, Any]], feature: str, outcome: str) -> tuple[float, int, int, float, float] | None:
    return correlation_binary_vs_numeric(days, feature, outcome)


def detect_insights(days: dict[str, dict[str, Any]]) -> list[Insight]:
    insights: list[Insight] = []

    c1 = correlation_binary_vs_numeric(days, "workout_before_6", "sleep_quality_avg")
    if c1 and c1[0] >= 0.25:
        strength, y, n, my, mn = c1
        insights.append(Insight(
            key="sleep_quality_vs_early_workout",
            summary=(
                "Sleep quality trends higher on days with workouts before 6:00 AM "
                f"(mean {my:.2f} vs {mn:.2f})."
            ),
            strength=float(strength),
            support_days=y + n,
            metadata={"feature": "workout_before_6", "outcome": "sleep_quality_avg", "mean_yes": my, "mean_no": mn, "days_yes": y, "days_no": n},
        ))

    c2 = correlation_binary_vs_count(days, "sleep_before_23", "error_events")
    if c2 and c2[0] <= -0.20:
        strength, y, n, my, mn = c2
        insights.append(Insight(
            key="errors_vs_early_sleep",
            summary=(
                "System error events trend lower after sleep before 11:00 PM "
                f"(mean {my:.2f} vs {mn:.2f})."
            ),
            strength=abs(float(strength)),
            support_days=y + n,
            metadata={"feature": "sleep_before_23", "outcome": "error_events", "mean_yes": my, "mean_no": mn, "days_yes": y, "days_no": n},
        ))

    c3 = correlation_binary_vs_count(days, "wake_before_7", "corrections")
    if c3 and c3[0] <= -0.20:
        strength, y, n, my, mn = c3
        insights.append(Insight(
            key="corrections_vs_early_wake",
            summary=(
                "Corrections decrease on early-wake days (<7:00 AM) "
                f"(mean {my:.2f} vs {mn:.2f})."
            ),
            strength=abs(float(strength)),
            support_days=y + n,
            metadata={"feature": "wake_before_7", "outcome": "corrections", "mean_yes": my, "mean_no": mn, "days_yes": y, "days_no": n},
        ))

    insights.sort(key=lambda x: (x.strength, x.support_days), reverse=True)
    return insights


def week_start(date_iso: str) -> str:
    d = datetime.fromisoformat(date_iso).date()
    start = d - timedelta(days=d.weekday())
    return start.isoformat()


def weekly_digest(days: dict[str, dict[str, Any]], insights: list[Insight]) -> str:
    buckets: dict[str, list[str]] = defaultdict(list)
    for day_iso, row in days.items():
        notes = []
        if row.get("workout_before_6"):
            notes.append("early workout")
        if row.get("sleep_before_23"):
            notes.append("sleep<23:00")
        if row.get("wake_before_7"):
            notes.append("wake<07:00")
        if row.get("sleep_quality_avg") is not None:
            notes.append(f"sleep_q={row['sleep_quality_avg']:.1f}")
        if row.get("error_events", 0) > 0:
            notes.append(f"errors={row['error_events']}")
        if notes:
            buckets[week_start(day_iso)].append(f"{day_iso}: " + ", ".join(notes))

    lines = ["# Behavioral Pattern Digest\n"]
    for wk in sorted(buckets.keys(), reverse=True):
        lines.append(f"## Week of {wk}")
        for item in sorted(buckets[wk])[-7:]:
            lines.append(f"- {item}")
        lines.append("")

    lines.append("## Detected Insights")
    if not insights:
        lines.append("- No statistically meaningful correlations found in the selected window.")
    else:
        for i in insights:
            lines.append(f"- {i.summary} [strength={i.strength:.2f}, support_days={i.support_days}]")
    return "\n".join(lines).strip() + "\n"


def persist_insights(insights: list[Insight], days_window: int) -> int:
    inserted = 0
    for i in insights:
        meta = {"kind": "behavioral_pattern_v2", "days_window": days_window, **i.metadata}
        value = i.summary[:250]
        check_sql = (
            "SELECT COUNT(*) FROM cortana_patterns "
            "WHERE pattern_type='insight' "
            f"AND value='{sql_escape(value)}' "
            "AND timestamp >= NOW() - INTERVAL '7 days';"
        )
        exists = int(run_psql(check_sql) or "0")
        if exists > 0:
            continue
        ins_sql = (
            "INSERT INTO cortana_patterns (timestamp, pattern_type, value, day_of_week, metadata) VALUES "
            "(NOW(), 'insight', "
            f"'{sql_escape(value)}', EXTRACT(DOW FROM NOW())::int, '{sql_escape(json.dumps(meta))}'::jsonb);"
        )
        run_psql(ins_sql)
        inserted += 1
    return inserted


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--analyze", action="store_true", help="run analysis")
    ap.add_argument("--days", type=int, default=30, help="lookback days")
    args = ap.parse_args()

    if not args.analyze:
        ap.error("--analyze is required")

    patterns, feedback, events = load_data(args.days)
    daily = build_daily_features(patterns, feedback, events)
    insights = detect_insights(daily)
    inserted = persist_insights(insights, args.days)
    digest = weekly_digest(daily, insights)

    print(digest)
    print(json.dumps({
        "days": args.days,
        "pattern_rows": len(patterns),
        "feedback_rows": len(feedback),
        "event_rows": len(events),
        "days_observed": len(daily),
        "insights_detected": len(insights),
        "insights_inserted": inserted,
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
