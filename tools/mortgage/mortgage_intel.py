#!/usr/bin/env python3
"""Mortgage Intel Co-Pilot.

Fetches macro + mortgage news signals, classifies topic/impact, and generates
broker-ready advisories for daily briefs.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Any

DB_NAME = "cortana"
DB_PATH = "/opt/homebrew/opt/postgresql@17/bin"
SOURCE = "mortgage_intel"

SERIES = {
    "MORTGAGE30US": "30Y fixed mortgage average",
    "DGS10": "10Y Treasury yield",
}

RSS_FEEDS = [
    "https://www.mba.org/rss/news-and-research-news.xml",
    "https://www.housingwire.com/feed/",
    "https://www.mortgagenewsdaily.com/rss",
    "https://www.nar.realtor/newsroom/rss",
]

TOPIC_RULES = {
    "rates": ["rate", "yield", "treasury", "fed", "inflation", "cpi", "mortgage pricing", "lock", "float"],
    "regulation_compliance": ["cfpb", "fhfa", "hud", "fannie", "freddie", "compliance", "rule", "regulation", "lawsuit"],
    "underwriting_changes": ["underwriting", "du", "lp", "guideline", "ltv", "dti", "credit", "eligibility", "reserve"],
    "regional_demand": ["inventory", "housing starts", "regional", "metro", "demand", "purchase volume", "refi", "application"],
}


@dataclass
class IntelEvent:
    title: str
    source: str
    url: str
    published_at: str | None
    summary: str
    topic: str
    urgency: int
    lock_float: str
    pipeline_effect: str
    impact_score: float
    what_changed: str
    what_to_do: str
    metadata: dict[str, Any]


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


def log_event(message: str, severity: str, metadata: dict[str, Any], dry_run: bool) -> None:
    if dry_run:
        return
    run_psql(
        "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES "
        f"('mortgage_intel','{SOURCE}','{sql_escape(severity)}','{sql_escape(message)}','{sql_escape(json.dumps(metadata))}'::jsonb);"
    )


def http_get(url: str, timeout: int = 10) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "cortana-mortgage-intel/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def fetch_fred_series(series_id: str) -> dict[str, Any]:
    api_key = os.getenv("FRED_API_KEY", "").strip()
    if api_key:
        qs = urllib.parse.urlencode({"series_id": series_id, "api_key": api_key, "file_type": "json", "sort_order": "desc", "limit": 5})
        url = f"https://api.stlouisfed.org/fred/series/observations?{qs}"
        payload = json.loads(http_get(url))
        obs = payload.get("observations", [])
        points = [o for o in obs if o.get("value") not in (None, ".")][:2]
        if not points:
            raise RuntimeError(f"No observations for {series_id}")
        latest, prior = points[0], (points[1] if len(points) > 1 else points[0])
        return {
            "series_id": series_id,
            "latest_date": latest.get("date"),
            "latest_value": float(latest.get("value")),
            "prior_value": float(prior.get("value")),
        }

    # Fallback: public CSV endpoint (no key)
    csv_url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={urllib.parse.quote(series_id)}"
    rows = [r for r in http_get(csv_url).splitlines() if r and not r.endswith(",.")]
    if len(rows) < 3:
        raise RuntimeError(f"Insufficient CSV rows for {series_id}")
    latest_row = rows[-1].split(",")
    prior_row = rows[-2].split(",")
    return {
        "series_id": series_id,
        "latest_date": latest_row[0],
        "latest_value": float(latest_row[1]),
        "prior_value": float(prior_row[1]),
    }


def fetch_rss_items(limit_per_feed: int = 8) -> list[dict[str, str | None]]:
    out: list[dict[str, str | None]] = []
    for feed in RSS_FEEDS:
        try:
            xml_txt = http_get(feed)
            root = ET.fromstring(xml_txt)
            items = root.findall(".//item") or root.findall(".//{http://www.w3.org/2005/Atom}entry")
            for item in items[:limit_per_feed]:
                title = (item.findtext("title") or item.findtext("{http://www.w3.org/2005/Atom}title") or "").strip()
                link = (item.findtext("link") or item.findtext("{http://www.w3.org/2005/Atom}link") or "").strip()
                if not link:
                    atom_link = item.find("{http://www.w3.org/2005/Atom}link")
                    if atom_link is not None:
                        link = atom_link.attrib.get("href", "")
                desc = (item.findtext("description") or item.findtext("{http://purl.org/rss/1.0/modules/content/}encoded") or "").strip()
                pub = (item.findtext("pubDate") or item.findtext("{http://www.w3.org/2005/Atom}updated") or item.findtext("{http://www.w3.org/2005/Atom}published"))
                if title:
                    out.append({"feed": feed, "title": re.sub(r"\s+", " ", title), "link": link, "summary": re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", desc))[:420], "published_at": pub})
        except Exception:
            continue
    return out


def is_mortgage_relevant(text: str) -> bool:
    anchors = ["mortgage", "housing", "loan", "lending", "borrower", "refi", "purchase", "fannie", "freddie", "rate", "underwriting", "listing", "realtor", "real estate", "home sales", "inventory"]
    return any(_contains_keyword(text, a) for a in anchors)


def _contains_keyword(text: str, keyword: str) -> bool:
    return re.search(r"\\b" + re.escape(keyword.lower()) + r"\\b", text.lower()) is not None


def classify_topic(text: str) -> str:
    best_topic = "regional_demand"
    best_score = 0
    for topic, keywords in TOPIC_RULES.items():
        score = sum(1 for k in keywords if _contains_keyword(text, k))
        if score > best_score:
            best_topic, best_score = topic, score
    return best_topic


def score_impact(topic: str, text: str, rate_shift_bp: float) -> tuple[int, str, str, float]:
    t = text.lower()
    urgency = 2
    if any(w in t for w in ["immediate", "effective", "urgent", "breaking"]):
        urgency = 1
    elif any(w in t for w in ["guidance", "proposal", "comment period"]):
        urgency = 3

    lock_float = "monitor"
    if topic == "rates":
        if rate_shift_bp >= 7:
            lock_float = "bias_lock"
            urgency = min(urgency, 1)
        elif rate_shift_bp <= -7:
            lock_float = "bias_float_selective"

    pipeline_effect = {
        "rates": "pricing_volatility",
        "regulation_compliance": "process_and_disclosure_updates",
        "underwriting_changes": "eligibility_mix_shift",
        "regional_demand": "lead_flow_and_conversion_shift",
    }.get(topic, "monitor")

    base = {"rates": 0.78, "regulation_compliance": 0.72, "underwriting_changes": 0.69, "regional_demand": 0.62}.get(topic, 0.6)
    if urgency == 1:
        base += 0.12
    elif urgency == 2:
        base += 0.05
    base += min(abs(rate_shift_bp) / 100.0, 0.08)
    return urgency, lock_float, pipeline_effect, round(min(base, 0.98), 3)


def advisory_for(item: dict[str, Any], rates: dict[str, Any]) -> IntelEvent:
    title = str(item.get("title") or "")
    summary = str(item.get("summary") or "")
    text = f"{title} {summary}"
    topic = classify_topic(text)

    mort = rates["MORTGAGE30US"]
    dgs10 = rates["DGS10"]
    mort_shift_bp = (mort["latest_value"] - mort["prior_value"]) * 100
    tsy_shift_bp = (dgs10["latest_value"] - dgs10["prior_value"]) * 100

    urgency, lock_float, pipeline_effect, impact_score = score_impact(topic, text, mort_shift_bp)

    macro_blurb = (
        f"30Y mortgage {mort['latest_value']:.2f}% ({mort_shift_bp:+.1f} bps) | "
        f"10Y treasury {dgs10['latest_value']:.2f}% ({tsy_shift_bp:+.1f} bps)"
    )

    what_changed = f"{title}. Macro tape: {macro_blurb}."

    action_map = {
        "rates": "Prioritize same-day lock/float calls for active borrowers; send concise rate-change update to hot pipeline clients.",
        "regulation_compliance": "Review disclosure/process impacts and align scripts/checklists before next borrower touchpoint.",
        "underwriting_changes": "Re-screen active files against guideline changes and flag borderline borrowers for re-structuring.",
        "regional_demand": "Adjust outreach by market segment; focus lead-gen where demand velocity is improving.",
    }

    return IntelEvent(
        title=title,
        source=str(item.get("feed") or "rss"),
        url=str(item.get("link") or ""),
        published_at=item.get("published_at"),
        summary=summary,
        topic=topic,
        urgency=urgency,
        lock_float=lock_float,
        pipeline_effect=pipeline_effect,
        impact_score=impact_score,
        what_changed=what_changed,
        what_to_do=action_map.get(topic, "Monitor for downstream borrower impact and prep comms as needed."),
        metadata={
            "macro": {"mortgage30": mort, "dgs10": dgs10},
            "topic": topic,
            "pipeline_effect": pipeline_effect,
        },
    )


def maybe_create_task(event: IntelEvent, dry_run: bool) -> int | None:
    if dry_run or event.urgency > 1 or event.impact_score < 0.84:
        return None
    title = f"Mortgage Intel: {event.title[:90]}"
    desc = f"{event.what_changed}\n\nWhat to do: {event.what_to_do}"
    sql = (
        "INSERT INTO cortana_tasks (source, title, description, priority, status, auto_executable, execution_plan, metadata) VALUES "
        f"('mortgage_intel','{sql_escape(title)}','{sql_escape(desc)}',1,'pending',FALSE,"
        "'Draft borrower-facing advisory + lock/float outreach list',"
        f"'{sql_escape(json.dumps({'topic': event.topic, 'impact_score': event.impact_score, 'url': event.url}))}'::jsonb) RETURNING id;"
    )
    raw = run_psql(sql)
    return int(raw) if raw else None


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Mortgage Intel Co-Pilot: FRED + mortgage RSS + broker advisory output")
    p.add_argument("--max-items", type=int, default=8, help="Max advisories to produce")
    p.add_argument("--create-tasks", action="store_true", help="Auto-create cortana_tasks for high-urgency/high-impact advisories")
    p.add_argument("--dry-run", action="store_true", help="No DB writes")
    p.add_argument("--json", action="store_true", help="Output JSON instead of text")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    now = datetime.now(timezone.utc).isoformat()

    rates: dict[str, Any] = {}
    errors: list[str] = []
    for sid in SERIES:
        try:
            rates[sid] = fetch_fred_series(sid)
        except Exception as e:
            errors.append(f"FRED {sid}: {e}")

    feed_items = fetch_rss_items(limit_per_feed=8)
    advisories: list[IntelEvent] = []

    if "MORTGAGE30US" in rates and "DGS10" in rates:
        for item in feed_items:
            if not is_mortgage_relevant(f"{item.get('title','')} {item.get('summary','')}"):
                continue
            try:
                advisories.append(advisory_for(item, rates))
            except Exception as e:
                errors.append(f"advisory {item.get('title','?')[:30]}: {e}")

    if not advisories and "MORTGAGE30US" in rates and "DGS10" in rates:
        mort = rates["MORTGAGE30US"]
        dgs10 = rates["DGS10"]
        mort_shift_bp = (mort["latest_value"] - mort["prior_value"]) * 100
        tsy_shift_bp = (dgs10["latest_value"] - dgs10["prior_value"]) * 100
        urgency = 1 if abs(mort_shift_bp) >= 7 else 2
        lock_float = "bias_lock" if mort_shift_bp >= 7 else ("bias_float_selective" if mort_shift_bp <= -7 else "monitor")
        advisories.append(
            IntelEvent(
                title="Daily macro rate snapshot",
                source="FRED",
                url="https://fred.stlouisfed.org/",
                published_at=None,
                summary="Macro-only fallback when RSS signals are thin.",
                topic="rates",
                urgency=urgency,
                lock_float=lock_float,
                pipeline_effect="pricing_volatility",
                impact_score=round(min(0.94, 0.74 + abs(mort_shift_bp) / 80.0), 3),
                what_changed=(
                    f"30Y mortgage {mort['latest_value']:.2f}% ({mort_shift_bp:+.1f} bps) and "
                    f"10Y treasury {dgs10['latest_value']:.2f}% ({tsy_shift_bp:+.1f} bps)."
                ),
                what_to_do="Send lock/float guidance to active pipeline and prioritize borrowers near commitment deadlines.",
                metadata={"macro": {"mortgage30": mort, "dgs10": dgs10}, "fallback": True},
            )
        )

    advisories.sort(key=lambda x: (x.urgency, -x.impact_score))
    advisories = advisories[: max(1, args.max_items)]

    created_tasks: list[int] = []
    if not args.dry_run:
        log_event(
            message=f"Mortgage intel run completed: {len(advisories)} advisories",
            severity="info" if not errors else "warning",
            metadata={"advisories": len(advisories), "errors": errors[:8]},
            dry_run=False,
        )

    if args.create_tasks:
        for adv in advisories:
            try:
                tid = maybe_create_task(adv, dry_run=args.dry_run)
                if tid:
                    created_tasks.append(tid)
            except Exception as e:
                errors.append(f"task-create {adv.title[:30]}: {e}")

    payload = {
        "source": SOURCE,
        "generated_at": now,
        "series": rates,
        "advisories": [asdict(a) for a in advisories],
        "tasks_created": created_tasks,
        "errors": errors,
    }

    if args.json:
        print(json.dumps(payload, indent=2))
        return 0

    print("Mortgage Intel — what changed / what to do")
    for i, a in enumerate(advisories, start=1):
        print(f"\n{i}. [{a.topic}] {a.title}")
        print(f"   what changed: {a.what_changed}")
        print(f"   what to do:   {a.what_to_do}")
        print(f"   impact: urgency={a.urgency} lock/float={a.lock_float} pipeline={a.pipeline_effect} score={a.impact_score}")
    if errors:
        print("\nErrors:")
        for e in errors[:12]:
            print(f"- {e}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
