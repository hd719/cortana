#!/usr/bin/env python3
"""Capability Marketplace.

Find recurring capability gaps from Cortana telemetry, map to local/new skills,
rank proposals, and optionally create implementation tasks.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import urllib.parse
import urllib.request
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DB_NAME = "cortana"
DB_PATH = "/opt/homebrew/opt/postgresql@17/bin"
SOURCE = "capability_marketplace"
SKILLS_DIR = Path("/Users/hd/clawd/skills")


@dataclass
class Gap:
    name: str
    evidence_count: int
    examples: list[str]
    intent_terms: list[str]


@dataclass
class Proposal:
    gap: str
    local_matches: list[str]
    clawdhub_matches: list[str]
    integration_pattern: str
    effort: float
    impact: float
    risk: float
    expected_payoff: float
    confidence: float
    recommendation: str



def sql_escape(text: str) -> str:
    return (text or "").replace("'", "''")


def run_psql(sql: str) -> str:
    env = os.environ.copy()
    env["PATH"] = f"{DB_PATH}:{env.get('PATH', '')}"
    cmd = ["psql", DB_NAME, "-q", "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql]
    out = subprocess.run(cmd, text=True, capture_output=True, env=env)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or "psql failed")
    return out.stdout.strip()


def fetch_json(sql: str) -> list[dict[str, Any]]:
    wrapped = f"SELECT COALESCE(json_agg(t), '[]'::json)::text FROM ({sql}) t;"
    raw = run_psql(wrapped)
    return json.loads(raw) if raw else []


def log_event(message: str, severity: str, metadata: dict[str, Any], dry_run: bool) -> None:
    if dry_run:
        return
    run_psql(
        "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES "
        f"('capability_marketplace','{SOURCE}','{sql_escape(severity)}','{sql_escape(message)}','{sql_escape(json.dumps(metadata))}'::jsonb);"
    )


def http_get(url: str, timeout: int = 10) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "cortana-capability-marketplace/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")


def tokenize(text: str) -> list[str]:
    toks = re.findall(r"[a-zA-Z][a-zA-Z0-9_-]{2,}", (text or "").lower())
    stop = {"the", "and", "for", "with", "that", "this", "from", "task", "error", "failed", "manual", "need", "should"}
    return [t for t in toks if t not in stop]


def mine_gaps(window_days: int) -> list[Gap]:
    rows = fetch_json(
        "SELECT COALESCE(source,'task') AS source, COALESCE(title,'') AS title, COALESCE(description,'') AS description, COALESCE(outcome,'') AS outcome "
        "FROM cortana_tasks "
        f"WHERE created_at > NOW() - INTERVAL '{max(7, window_days)} days' "
        "AND status IN ('pending','in_progress','cancelled') "
        "UNION ALL "
        "SELECT 'feedback' AS source, COALESCE(context,'') AS title, COALESCE(lesson,'') AS description, '' AS outcome "
        "FROM cortana_feedback "
        f"WHERE timestamp > NOW() - INTERVAL '{max(7, window_days)} days' "
        "UNION ALL "
        "SELECT COALESCE(source,'event') AS source, COALESCE(message,'') AS title, COALESCE(metadata::text,'') AS description, '' AS outcome "
        "FROM cortana_events "
        f"WHERE timestamp > NOW() - INTERVAL '{max(7, window_days)} days' "
        "AND severity IN ('warning','error')"
    )

    bucket: dict[str, dict[str, Any]] = {}
    for r in rows:
        text = f"{r.get('title','')} {r.get('description','')} {r.get('outcome','')}"
        terms = tokenize(text)
        if not terms:
            continue

        # lightweight intent bucketing
        label = "workflow_automation"
        if any(k in terms for k in ["calendar", "gmail", "email", "inbox"]):
            label = "comms_calendar"
        elif any(k in terms for k in ["security", "incident", "alert", "auth"]):
            label = "security_ops"
        elif any(k in terms for k in ["market", "mortgage", "rate", "portfolio"]):
            label = "market_intel"
        elif any(k in terms for k in ["memory", "context", "knowledge", "search"]):
            label = "knowledge_retrieval"

        b = bucket.setdefault(label, {"count": 0, "examples": [], "terms": {}})
        b["count"] += 1
        if len(b["examples"]) < 5:
            b["examples"].append(text[:200])
        for t in terms[:18]:
            b["terms"][t] = b["terms"].get(t, 0) + 1

    gaps = []
    for name, data in bucket.items():
        top_terms = [k for k, _ in sorted(data["terms"].items(), key=lambda kv: kv[1], reverse=True)[:8]]
        gaps.append(Gap(name=name, evidence_count=int(data["count"]), examples=data["examples"], intent_terms=top_terms))
    return sorted(gaps, key=lambda g: g.evidence_count, reverse=True)


def local_skills() -> list[str]:
    if not SKILLS_DIR.exists():
        return []
    return sorted([p.name for p in SKILLS_DIR.iterdir() if p.is_dir() and not p.name.startswith(".")])


def map_local_skills(gap: Gap, skills: list[str]) -> list[str]:
    curated = {
        "workflow_automation": ["clawddocs", "clawdhub", "process-watch", "telegram-usage"],
        "security_ops": ["healthcheck", "process-watch"],
        "comms_calendar": ["gog", "caldav-calendar"],
        "market_intel": ["news-summary", "weather", "bird"],
        "knowledge_retrieval": ["clawddocs", "skill-creator"],
    }
    seed = [s for s in curated.get(gap.name, []) if s in skills]

    terms = set(gap.intent_terms + gap.name.split("_"))
    fuzzy = []
    for s in skills:
        s_tokens = set(tokenize(s.replace("-", " ")))
        if terms.intersection(s_tokens):
            fuzzy.append(s)

    merged = []
    for name in seed + fuzzy:
        if name not in merged:
            merged.append(name)
    return merged[:6]


def clawdhub_search(term: str) -> list[str]:
    candidates: list[str] = []
    urls = [
        f"https://clawdhub.com/search?q={urllib.parse.quote(term)}",
        f"https://clawdhub.com/skills?q={urllib.parse.quote(term)}",
        f"https://clawdhub.com/api/skills?query={urllib.parse.quote(term)}",
    ]
    for url in urls:
        try:
            body = http_get(url, timeout=8)
            # JSON path
            if body.strip().startswith("{") or body.strip().startswith("["):
                try:
                    js = json.loads(body)
                    rows = js if isinstance(js, list) else js.get("skills") or js.get("results") or []
                    for r in rows[:10]:
                        if isinstance(r, dict):
                            nm = str(r.get("name") or r.get("slug") or "").strip()
                            if nm:
                                candidates.append(nm)
                except Exception:
                    pass
            # HTML path
            for m in re.findall(r"/skills/([a-zA-Z0-9_-]+)", body):
                candidates.append(m)
        except Exception:
            continue
    return sorted(set(candidates))[:8]


def pick_pattern(gap: Gap) -> str:
    if gap.name == "comms_calendar":
        return "heartbeat-driven triage + task auto-sync"
    if gap.name == "security_ops":
        return "event ingestion + severity routing + playbook execution"
    if gap.name == "market_intel":
        return "daily signal collector + advisor formatter + task trigger"
    if gap.name == "knowledge_retrieval":
        return "memory index refresh + retrieval scoring + response templates"
    return "detect -> score -> propose -> task"


def rank_proposal(gap: Gap, local: list[str], hub: list[str]) -> Proposal:
    impact = min(0.97, 0.45 + gap.evidence_count * 0.06)
    effort = max(0.15, 0.70 - (0.08 * len(local)) - (0.03 * len(hub)))
    risk = 0.25 + (0.08 if not local else 0.0) + (0.05 if len(hub) > 0 else 0.0)
    expected_payoff = round(max(0.0, impact - effort - (risk * 0.35)), 3)
    confidence = round(min(0.96, 0.50 + min(gap.evidence_count, 8) * 0.04 + len(local) * 0.03), 3)
    rec = (
        f"Address '{gap.name}' by reusing {', '.join(local[:3]) or 'existing tools'}"
        f" and adding {', '.join(hub[:2]) or 'targeted custom glue'} if needed."
    )
    return Proposal(
        gap=gap.name,
        local_matches=local,
        clawdhub_matches=hub,
        integration_pattern=pick_pattern(gap),
        effort=round(effort, 3),
        impact=round(impact, 3),
        risk=round(min(0.95, risk), 3),
        expected_payoff=expected_payoff,
        confidence=confidence,
        recommendation=rec,
    )


def maybe_create_task(prop: Proposal, threshold: float, dry_run: bool) -> int | None:
    if dry_run or prop.confidence < threshold or prop.expected_payoff < 0.22:
        return None
    title = f"Capability upgrade: {prop.gap}"
    desc = (
        f"Recommendation: {prop.recommendation}\n"
        f"Pattern: {prop.integration_pattern}\n"
        f"Impact/Effort/Risk/Payoff: {prop.impact}/{prop.effort}/{prop.risk}/{prop.expected_payoff}"
    )
    meta = asdict(prop)
    raw = run_psql(
        "INSERT INTO cortana_tasks (source, title, description, priority, status, auto_executable, execution_plan, metadata) VALUES "
        f"('capability_marketplace','{sql_escape(title)}','{sql_escape(desc)}',2,'pending',TRUE,"
        "'1) Validate fit 2) Prototype integration 3) Measure impact and harden',"
        f"'{sql_escape(json.dumps(meta))}'::jsonb) RETURNING id;"
    )
    return int(raw) if raw else None


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Capability Marketplace: mine gaps, map skills, rank upgrade proposals")
    p.add_argument("--window-days", type=int, default=30, help="Lookback window for tasks/feedback/events")
    p.add_argument("--max-proposals", type=int, default=5, help="Maximum ranked proposals to emit")
    p.add_argument("--task-threshold", type=float, default=0.84, help="Confidence threshold for auto implementation task")
    p.add_argument("--create-tasks", action="store_true", help="Auto-create implementation tasks for high confidence matches")
    p.add_argument("--dry-run", action="store_true", help="No DB writes")
    p.add_argument("--json", action="store_true", help="Output JSON")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    errors: list[str] = []

    try:
        gaps = mine_gaps(window_days=args.window_days)
    except Exception as e:
        gaps = []
        errors.append(f"gap-mining: {e}")

    skills = local_skills()
    proposals: list[Proposal] = []

    for gap in gaps:
        local = map_local_skills(gap, skills)
        hub_matches: list[str] = []
        for term in gap.intent_terms[:3]:
            try:
                hub_matches.extend(clawdhub_search(term))
            except Exception as e:
                errors.append(f"clawdhub {term}: {e}")
        hub_matches = sorted(set(hub_matches))[:8]
        proposals.append(rank_proposal(gap, local, hub_matches))

    proposals = sorted(proposals, key=lambda p: (-p.expected_payoff, -p.confidence, p.effort))[: max(1, args.max_proposals)]

    created_tasks: list[int] = []
    if args.create_tasks:
        for p in proposals:
            try:
                tid = maybe_create_task(p, threshold=args.task_threshold, dry_run=args.dry_run)
                if tid:
                    created_tasks.append(tid)
            except Exception as e:
                errors.append(f"task-create {p.gap}: {e}")

    log_event(
        message=f"Capability marketplace generated {len(proposals)} proposals",
        severity="info" if not errors else "warning",
        metadata={"proposals": len(proposals), "tasks_created": created_tasks, "errors": errors[:8]},
        dry_run=args.dry_run,
    )

    payload = {
        "source": SOURCE,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "gaps_identified": [asdict(g) for g in gaps],
        "proposals": [asdict(p) for p in proposals],
        "tasks_created": created_tasks,
        "errors": errors,
    }

    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print("Capability Marketplace Proposals")
        for i, p in enumerate(proposals, start=1):
            print(f"\n{i}. {p.gap}")
            print(f"   recommendation: {p.recommendation}")
            print(f"   local skills:   {', '.join(p.local_matches) or '-'}")
            print(f"   clawdhub:       {', '.join(p.clawdhub_matches) or '-'}")
            print(f"   effort/impact/risk/payoff/conf: {p.effort}/{p.impact}/{p.risk}/{p.expected_payoff}/{p.confidence}")
        if created_tasks:
            print(f"\nTasks created: {created_tasks}")
        if errors:
            print("\nErrors:")
            for e in errors[:12]:
                print(f"- {e}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
