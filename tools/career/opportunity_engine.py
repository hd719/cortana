#!/usr/bin/env python3
"""Proactive Opportunity Engine for Career.

Aggregates engineering signals, matches to goals, scores ROI vs effort, and
proposes one Career Move of the Week.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Any

DB_NAME = "cortana"
DB_PATH = "/opt/homebrew/opt/postgresql@17/bin"
SOURCE = "opportunity_engine"

STACK_KEYWORDS = ["typescript", "react", "tanstack", "go", "golang", "security", "architecture", "reliability", "prisma", "auth"]
GOALS = {
    "masters_program": ["paper", "research", "architecture", "distributed", "security", "analysis"],
    "resilience_role": ["security", "incident", "resilience", "detection", "reliability", "threat"],
    "side_projects": ["typescript", "react", "go", "api", "automation", "oauth", "product"],
}

FEEDS = [
    "https://github.blog/security/feed/",
    "https://krebsonsecurity.com/feed/",
    "https://www.cisa.gov/cybersecurity-advisories/all.xml",
    "https://martinfowler.com/feed.atom",
    "https://www.infoq.com/feed/architecture-design/",
]


@dataclass
class Opportunity:
    title: str
    source: str
    url: str
    summary: str
    tags: list[str]
    goal_match: dict[str, float]
    roi: float
    effort: float
    confidence: float
    why_now: str
    execution_plan: list[str]



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


def log_event(event_type: str, message: str, severity: str, metadata: dict[str, Any], dry_run: bool) -> None:
    if dry_run:
        return
    run_psql(
        "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES "
        f"('{sql_escape(event_type)}','{SOURCE}','{sql_escape(severity)}','{sql_escape(message)}','{sql_escape(json.dumps(metadata))}'::jsonb);"
    )


def http_get(url: str, timeout: int = 10) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "cortana-opportunity-engine/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")


def fetch_github_trending(language: str = "typescript") -> list[dict[str, str]]:
    # Public HTML parse (no auth).
    url = f"https://github.com/trending/{urllib.parse.quote(language)}?since=weekly"
    html = http_get(url)
    cards = re.findall(r'<h2 class="h3 lh-condensed">\s*<a href="([^"]+)"[^>]*>(.*?)</a>', html, re.S)
    out = []
    for href, raw_title in cards[:12]:
        title = re.sub(r"\s+", "", raw_title).replace("/", " / ")
        out.append({"title": title.strip(), "url": f"https://github.com{href.strip()}", "summary": "Trending repository"})
    return out


def parse_feed(feed_url: str, limit: int = 8) -> list[dict[str, str]]:
    xml = http_get(feed_url)
    root = ET.fromstring(xml)
    items = root.findall(".//item") or root.findall(".//{http://www.w3.org/2005/Atom}entry")
    out: list[dict[str, str]] = []
    for it in items[:limit]:
        title = (it.findtext("title") or it.findtext("{http://www.w3.org/2005/Atom}title") or "").strip()
        link = (it.findtext("link") or "").strip()
        if not link:
            atom_link = it.find("{http://www.w3.org/2005/Atom}link")
            if atom_link is not None:
                link = atom_link.attrib.get("href", "")
        summary = (it.findtext("description") or it.findtext("{http://www.w3.org/2005/Atom}summary") or "").strip()
        summary = re.sub(r"<[^>]+>", " ", summary)
        if title:
            out.append({"title": re.sub(r"\s+", " ", title), "url": link, "summary": re.sub(r"\s+", " ", summary)[:420]})
    return out


def extract_tags(text: str) -> list[str]:
    t = text.lower()
    tags = [k for k in STACK_KEYWORDS if k in t]
    if "oauth" in t:
        tags.append("oauth")
    if "zero trust" in t:
        tags.append("zero-trust")
    return sorted(set(tags))


def goal_alignment(tags: list[str], text: str) -> dict[str, float]:
    t = text.lower()
    out: dict[str, float] = {}
    for goal, words in GOALS.items():
        hits = sum(1 for w in words if w in t or w in tags)
        out[goal] = round(min(1.0, hits / max(2, len(words) * 0.45)), 3)
    return out


def score_roi_effort(tags: list[str], align: dict[str, float], text: str) -> tuple[float, float, float]:
    align_total = sum(align.values()) / max(1, len(align))
    stack_fit = min(1.0, len(tags) / 4)
    novelty_penalty = 0.08 if any(k in text.lower() for k in ["deep dive", "book", "long form"]) else 0.0

    roi = round(min(0.98, 0.52 + 0.30 * align_total + 0.22 * stack_fit), 3)
    effort = round(min(0.95, 0.30 + 0.40 * (1 - stack_fit) + novelty_penalty), 3)
    confidence = round(min(0.98, 0.55 + 0.28 * align_total + 0.17 * stack_fit - 0.06 * novelty_penalty), 3)
    return roi, effort, confidence


def build_plan(title: str, tags: list[str]) -> list[str]:
    focus = ", ".join(tags[:4]) if tags else "relevant stack"
    return [
        f"Read and summarize '{title}' in 10 bullets with emphasis on {focus}.",
        "Extract one reusable pattern for Resilience role deliverables this week.",
        "Implement a tiny proof-of-concept (60-90 min) in a side project repo.",
        "Publish internal notes: problem, pattern, implementation, tradeoffs.",
        "Create one follow-up task to productionize if signal quality remains high.",
    ]


def choose_move(candidates: list[Opportunity]) -> Opportunity | None:
    if not candidates:
        return None
    return sorted(candidates, key=lambda o: (-(o.roi - o.effort), -o.confidence, -sum(o.goal_match.values())))[0]


def maybe_create_task(move: Opportunity, threshold: float, dry_run: bool) -> int | None:
    if dry_run or move.confidence < threshold:
        return None
    title = f"Career Move of the Week: {move.title[:80]}"
    desc = (
        f"Why now: {move.why_now}\n\n"
        f"ROI={move.roi} Effort={move.effort} Confidence={move.confidence}\n"
        "Execution plan:\n- " + "\n- ".join(move.execution_plan)
    )
    meta = {"source": move.source, "url": move.url, "tags": move.tags, "goal_match": move.goal_match, "confidence": move.confidence}
    raw = run_psql(
        "INSERT INTO cortana_tasks (source, title, description, priority, status, auto_executable, execution_plan, metadata) VALUES "
        f"('opportunity_engine','{sql_escape(title)}','{sql_escape(desc)}',2,'pending',TRUE,"
        "'Execute this move in one focused block and capture artifact.',"
        f"'{sql_escape(json.dumps(meta))}'::jsonb) RETURNING id;"
    )
    return int(raw) if raw else None


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Career opportunity engine: aggregate signals and produce one weekly move")
    p.add_argument("--task-threshold", type=float, default=0.82, help="Confidence threshold for auto task creation")
    p.add_argument("--create-task", action="store_true", help="Create task in cortana_tasks when threshold passes")
    p.add_argument("--dry-run", action="store_true", help="No DB writes")
    p.add_argument("--json", action="store_true", help="Output JSON")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    errors: list[str] = []
    signals: list[dict[str, str]] = []

    for lang in ("typescript", "go"):
        try:
            signals.extend(fetch_github_trending(language=lang))
        except Exception as e:
            errors.append(f"trending {lang}: {e}")

    for feed in FEEDS:
        try:
            signals.extend(parse_feed(feed, limit=6))
        except Exception as e:
            errors.append(f"feed {feed}: {e}")

    opportunities: list[Opportunity] = []
    for s in signals:
        text = f"{s.get('title','')} {s.get('summary','')}"
        tags = extract_tags(text)
        if not tags:
            continue
        align = goal_alignment(tags, text)
        roi, effort, confidence = score_roi_effort(tags, align, text)
        opportunities.append(
            Opportunity(
                title=s.get("title", "Untitled"),
                source=s.get("url", "") or "signal",
                url=s.get("url", ""),
                summary=s.get("summary", ""),
                tags=tags,
                goal_match=align,
                roi=roi,
                effort=effort,
                confidence=confidence,
                why_now="Compounds stack relevance for role + masters while producing side-project artifacts.",
                execution_plan=build_plan(s.get("title", "Untitled"), tags),
            )
        )

    move = choose_move(opportunities)
    created_task = None
    if move and args.create_task:
        try:
            created_task = maybe_create_task(move, threshold=args.task_threshold, dry_run=args.dry_run)
        except Exception as e:
            errors.append(f"task-create: {e}")

    if move:
        log_event(
            event_type="career_opportunity",
            message=f"Career move generated: {move.title[:120]}",
            severity="info" if not errors else "warning",
            metadata={"confidence": move.confidence, "roi": move.roi, "effort": move.effort, "task_id": created_task, "errors": errors[:6]},
            dry_run=args.dry_run,
        )

    payload = {
        "source": SOURCE,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "signals_seen": len(signals),
        "opportunities_scored": len(opportunities),
        "career_move_of_the_week": asdict(move) if move else None,
        "task_created": created_task,
        "errors": errors,
    }

    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        if not move:
            print("No qualifying opportunity found.")
        else:
            print("Career Move of the Week")
            print(f"- move: {move.title}")
            print(f"- why now: {move.why_now}")
            print(f"- roi/effort/confidence: {move.roi}/{move.effort}/{move.confidence}")
            print("- execution plan:")
            for step in move.execution_plan:
                print(f"  - {step}")
            if created_task:
                print(f"- task created: #{created_task}")
        if errors:
            print("- errors:")
            for e in errors[:10]:
                print(f"  - {e}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
