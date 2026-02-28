#!/usr/bin/env python3
"""Morning Brief 3.0 decision queue (#107).

Builds a ranked top-3 action queue across Time/Health/Wealth/Career.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
DB_PATH = "/opt/homebrew/opt/postgresql@17/bin"


@dataclass
class Candidate:
    source: str
    pillar: str
    title: str
    rationale: str
    urgency: float
    impact: float
    reversibility: float
    effort: float
    metadata: dict[str, Any]

    @property
    def score(self) -> float:
        return round((self.urgency * self.impact * self.reversibility) / max(self.effort, 0.6), 3)


def run_psql(sql: str) -> str:
    env = os.environ.copy()
    env["PATH"] = f"{DB_PATH}:{env.get('PATH', '')}"
    p = subprocess.run(["psql", "cortana", "-q", "-X", "-t", "-A", "-c", sql], text=True, capture_output=True, env=env)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip() or "psql failed")
    return p.stdout.strip()


def fetch_json(sql: str) -> list[dict[str, Any]]:
    wrapped = f"SELECT COALESCE(json_agg(t), '[]'::json)::text FROM ({sql}) t;"
    raw = run_psql(wrapped)
    return json.loads(raw) if raw else []


def ensure_feedback_tables() -> None:
    run_psql(
        "CREATE TABLE IF NOT EXISTS cortana_decision_queue_runs ("
        "id BIGSERIAL PRIMARY KEY, generated_at TIMESTAMPTZ DEFAULT NOW(), metadata JSONB DEFAULT '{}'::jsonb);"
    )
    run_psql(
        "CREATE TABLE IF NOT EXISTS cortana_decision_queue_feedback ("
        "id BIGSERIAL PRIMARY KEY, run_id BIGINT REFERENCES cortana_decision_queue_runs(id) ON DELETE CASCADE, "
        "item_rank INT NOT NULL, title TEXT NOT NULL, pillar TEXT NOT NULL, source TEXT NOT NULL, score NUMERIC(8,3) NOT NULL, "
        "accepted BOOLEAN, completed BOOLEAN, completed_at TIMESTAMPTZ, metadata JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT NOW());"
    )


def gog_events() -> list[dict[str, Any]]:
    to_date = (datetime.now(timezone.utc).astimezone(ET) + timedelta(hours=24)).date().isoformat()
    p = subprocess.run(["gog", "calendar", "events", "primary", "--from", "today", "--to", to_date, "--json"], text=True, capture_output=True)
    if p.returncode != 0 or not p.stdout.strip():
        return []
    try:
        js = json.loads(p.stdout)
        return js if isinstance(js, list) else (js.get("events") or [])
    except Exception:
        return []


def parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        if value.endswith("Z"):
            return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(ET)
        dt = datetime.fromisoformat(value)
        return dt if dt.tzinfo else dt.replace(tzinfo=ET)
    except Exception:
        return None


def from_calendar(now: datetime) -> list[Candidate]:
    out: list[Candidate] = []
    for ev in gog_events():
        s = (ev.get("start") or {}) if isinstance(ev.get("start"), dict) else {"dateTime": ev.get("start")}
        st = parse_dt(s.get("dateTime") or s.get("date"))
        if not st or st < now or st > now + timedelta(hours=24):
            continue
        mins = max(1, int((st - now).total_seconds() / 60))
        urgency = 5.0 if mins < 120 else 4.0 if mins < 360 else 3.0
        title = str(ev.get("summary") or "Calendar commitment")
        out.append(Candidate(
            source="calendar",
            pillar="Time",
            title=f"Prepare: {title}",
            rationale=f"Starts in {mins}m — protect prep/context-switch time.",
            urgency=urgency,
            impact=3.8,
            reversibility=4.0,
            effort=2.2,
            metadata={"event_start": st.isoformat(), "event_id": ev.get("id")},
        ))
    return out


def from_watchlist() -> list[Candidate]:
    try:
        rows = fetch_json(
            "SELECT category, item, condition, threshold, metadata "
            "FROM cortana_watchlist WHERE enabled IS DISTINCT FROM FALSE "
            "ORDER BY created_at DESC LIMIT 10"
        )
    except Exception:
        rows = []

    out: list[Candidate] = []
    for r in rows[:4]:
        item = str(r.get("item") or "watchlist")
        out.append(Candidate(
            source="watchlist",
            pillar="Wealth",
            title=f"Review {item} setup quality",
            rationale="Pre-commit entry/exit before open; reduce impulse execution.",
            urgency=3.5,
            impact=4.4,
            reversibility=3.7,
            effort=1.8,
            metadata={
                "item": item,
                "category": r.get("category"),
                "condition": r.get("condition"),
                "threshold": r.get("threshold"),
                "raw": r.get("metadata"),
            },
        ))
    return out


def from_tasks() -> list[Candidate]:
    rows = fetch_json(
        "SELECT id, title, priority, due_at, auto_executable "
        "FROM cortana_tasks WHERE status IN ('ready','in_progress') ORDER BY priority ASC, due_at ASC NULLS LAST LIMIT 12"
    )
    out: list[Candidate] = []
    now = datetime.now(timezone.utc).astimezone(ET)
    for r in rows:
        due = parse_dt(r.get("due_at")) if r.get("due_at") else None
        urgency = 4.5 if (due and due < now + timedelta(hours=24)) else 3.2
        out.append(Candidate(
            source="tasks",
            pillar="Career",
            title=f"Task #{r.get('id')}: {r.get('title')}",
            rationale=("Due soon" if due else "Pending task") + f", priority P{r.get('priority', 3)}.",
            urgency=urgency,
            impact=4.0,
            reversibility=3.2,
            effort=2.8,
            metadata={"task_id": r.get("id"), "due_at": r.get("due_at"), "auto": r.get("auto_executable")},
        ))
    return out


def from_proactive() -> list[Candidate]:
    rows = fetch_json(
        "SELECT source, signal_type, title, summary, confidence, severity "
        "FROM cortana_proactive_signals ORDER BY created_at DESC LIMIT 15"
    )
    out: list[Candidate] = []
    for r in rows:
        conf = float(r.get("confidence") or 0.6)
        sev = str(r.get("severity") or "medium")
        urgency = 4.6 if sev == "high" else 3.6
        out.append(Candidate(
            source="proactive",
            pillar="Time",
            title=str(r.get("title") or "Proactive signal"),
            rationale=str(r.get("summary") or "Proactive detector surfaced a relevant signal."),
            urgency=urgency,
            impact=3.5 + conf,
            reversibility=3.0,
            effort=2.0,
            metadata={"signal_type": r.get("signal_type"), "confidence": conf},
        ))
    return out


def from_risk_radar() -> list[Candidate]:
    script = "/Users/hd/openclaw/tools/proactive/risk_radar.py"
    p = subprocess.run(["python3", script, "--horizon-hours", "16", "--json"], text=True, capture_output=True)
    if p.returncode != 0 or not p.stdout.strip():
        return []
    try:
        js = json.loads(p.stdout)
    except Exception:
        return []

    out: list[Candidate] = []
    scores = js.get("scores") or {}
    recovery = float(scores.get("recovery_score") or 55)
    combined = float(scores.get("combined_risk_score") or 50)
    if combined >= 65:
        out.append(Candidate(
            source="risk_radar",
            pillar="Health",
            title="Defend readiness window",
            rationale=f"Recovery {recovery:.0f} + elevated combined risk {combined:.0f}.",
            urgency=4.8,
            impact=4.5,
            reversibility=4.4,
            effort=2.0,
            metadata={"scores": scores, "priority_mitigations": js.get("priority_mitigations") or []},
        ))
    else:
        out.append(Candidate(
            source="risk_radar",
            pillar="Health",
            title="Lock in baseline recovery protections",
            rationale=f"Combined risk {combined:.0f}; stay disciplined to avoid preventable drift.",
            urgency=3.1,
            impact=3.8,
            reversibility=4.2,
            effort=1.7,
            metadata={"scores": scores},
        ))
    return out


def select_top(candidates: list[Candidate], top_n: int) -> list[Candidate]:
    ranked = sorted(candidates, key=lambda c: c.score, reverse=True)
    out: list[Candidate] = []
    seen: set[str] = set()

    # First pass: pillar diversity where possible.
    for c in ranked:
        if c.pillar in seen:
            continue
        out.append(c)
        seen.add(c.pillar)
        if len(out) >= top_n:
            return out

    # Fill remaining slots by raw score.
    for c in ranked:
        if c in out:
            continue
        out.append(c)
        if len(out) >= top_n:
            break
    return out


def persist_feedback_stub(top: list[Candidate]) -> int:
    ensure_feedback_tables()
    run_id = int(run_psql("INSERT INTO cortana_decision_queue_runs (metadata) VALUES ('{}'::jsonb) RETURNING id;"))
    for i, c in enumerate(top, start=1):
        meta = json.dumps(c.metadata)
        safe_title = c.title.replace("'", "''")
        safe_source = c.source.replace("'", "''")
        safe_pillar = c.pillar.replace("'", "''")
        run_psql(
            "INSERT INTO cortana_decision_queue_feedback (run_id, item_rank, title, pillar, source, score, metadata) VALUES "
            f"({run_id}, {i}, '{safe_title}', '{safe_pillar}', '{safe_source}', {c.score:.3f}, '{meta.replace("'", "''")}'::jsonb);"
        )
    return run_id


def record_feedback(run_id: int, item_rank: int, accepted: bool | None, completed: bool | None) -> None:
    sets = []
    if accepted is not None:
        sets.append(f"accepted={'TRUE' if accepted else 'FALSE'}")
    if completed is not None:
        sets.append(f"completed={'TRUE' if completed else 'FALSE'}")
        if completed:
            sets.append("completed_at=NOW()")
    if not sets:
        return
    run_psql(
        "UPDATE cortana_decision_queue_feedback SET " + ", ".join(sets) + f" WHERE run_id={run_id} AND item_rank={item_rank};"
    )


def format_brief(top: list[Candidate]) -> list[str]:
    lines = []
    for i, c in enumerate(top, start=1):
        lines.append(f"{i}) [{c.pillar}] {c.title} — {c.rationale}")
    return lines


def main() -> int:
    ap = argparse.ArgumentParser(description="Morning Brief 3.0 decision queue")
    ap.add_argument("--top", type=int, default=3, help="Number of top moves")
    ap.add_argument("--json", action="store_true", help="Output JSON")
    ap.add_argument("--record-feedback", action="store_true", help="Persist queue rows for acceptance/completion tracking")
    ap.add_argument("--feedback-run-id", type=int, help="Run ID to update feedback for")
    ap.add_argument("--feedback-rank", type=int, help="Rank item to update")
    ap.add_argument("--accepted", choices=["true", "false"], help="Set acceptance on feedback row")
    ap.add_argument("--completed", choices=["true", "false"], help="Set completion on feedback row")
    args = ap.parse_args()

    if args.feedback_run_id and args.feedback_rank:
        record_feedback(
            run_id=args.feedback_run_id,
            item_rank=args.feedback_rank,
            accepted=(None if args.accepted is None else args.accepted == "true"),
            completed=(None if args.completed is None else args.completed == "true"),
        )
        print(json.dumps({"ok": True, "run_id": args.feedback_run_id, "rank": args.feedback_rank}, indent=2))
        return 0

    now = datetime.now(timezone.utc).astimezone(ET)
    candidates = []
    candidates.extend(from_calendar(now))
    candidates.extend(from_watchlist())
    candidates.extend(from_tasks())
    candidates.extend(from_proactive())
    candidates.extend(from_risk_radar())

    top = select_top(candidates, args.top)
    run_id = persist_feedback_stub(top) if args.record_feedback else None

    output = {
        "generated_at": now.isoformat(),
        "candidate_count": len(candidates),
        "top_n": args.top,
        "run_id": run_id,
        "top_moves": [
            {
                **asdict(c),
                "score": c.score,
            }
            for c in top
        ],
        "formatted_queue": format_brief(top),
    }

    if args.json:
        print(json.dumps(output, indent=2))
    else:
        print("\n".join(output["formatted_queue"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
