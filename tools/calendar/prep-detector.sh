#!/usr/bin/env bash
set -euo pipefail

CALENDAR_ID="Clawdbot-Calendar"
TO_DATE="$(date -v+2d +%Y-%m-%d)"

python3 - "$CALENDAR_ID" "$TO_DATE" <<'PY'
import csv
import json
import os
import re
import shlex
import subprocess
import sys
from datetime import datetime, timezone

calendar_id = sys.argv[1]
to_date = sys.argv[2]

KEYWORDS = ["review", "presentation", "demo", "interview"]
ONE_ON_ONE_PAT = re.compile(r"\b(1:1|1-1|one on one|one-on-one)\b", re.IGNORECASE)


def run(cmd: list[str]) -> str:
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(shlex.quote(x) for x in cmd)}\n{p.stderr.strip()}")
    return p.stdout


def parse_iso(dt_s: str | None):
    if not dt_s:
        return None
    try:
        return datetime.fromisoformat(dt_s.replace("Z", "+00:00"))
    except Exception:
        return None


def event_start_end(ev: dict):
    s = ev.get("start", {})
    e = ev.get("end", {})
    if "dateTime" in s:
        start = parse_iso(s.get("dateTime"))
        end = parse_iso(e.get("dateTime"))
        all_day = False
    else:
        # Google all-day uses date (exclusive end)
        ds = s.get("date")
        de = e.get("date")
        start = parse_iso(ds + "T00:00:00+00:00") if ds else None
        end = parse_iso(de + "T00:00:00+00:00") if de else None
        all_day = True
    return start, end, all_day


def has_external_attendees(ev: dict):
    attendees = ev.get("attendees") or []
    if not attendees:
        return False

    organizer_email = ((ev.get("organizer") or {}).get("email") or "").lower()
    creator_email = ((ev.get("creator") or {}).get("email") or "").lower()
    known_internal = {organizer_email, creator_email, "hameldesai3@gmail.com"}

    for a in attendees:
        email = (a.get("email") or "").lower()
        if not email:
            continue
        if email in known_internal:
            continue
        if email.endswith("@group.calendar.google.com"):
            continue
        return True
    return False


def format_delta(target: datetime | None):
    if not target:
        return "unknown"
    now = datetime.now(timezone.utc)
    delta = target.astimezone(timezone.utc) - now
    secs = int(delta.total_seconds())
    if secs <= 0:
        return "started/already passed"
    hours, rem = divmod(secs, 3600)
    mins = rem // 60
    if hours >= 24:
        days = hours // 24
        hrs = hours % 24
        return f"{days}d {hrs}h {mins}m"
    return f"{hours}h {mins}m"


def build_actions(reasons: list[str], low_priority: bool):
    actions = []
    if any("external attendees" in r for r in reasons):
        actions += [
            "Review attendee context and company background",
            "Prepare a tight agenda and expected outcomes",
        ]
    if any("keyword" in r for r in reasons):
        actions += [
            "Review supporting docs/slides and key decisions",
            "Draft talking points and likely Q&A",
        ]
    if any("1:1" in r for r in reasons):
        actions += [
            "Skim last 1:1 notes",
            "Add 1-2 priorities or blockers to discuss",
        ]

    if not actions:
        actions = ["Quick pre-read: objective, risks, and decisions needed"]

    deduped = []
    seen = set()
    for a in actions:
        if a not in seen:
            seen.add(a)
            deduped.append(a)

    if low_priority:
        deduped.append("Keep prep light: 5-10 minutes max")

    return deduped


raw = run([
    "gog",
    "cal",
    "list",
    calendar_id,
    "--from",
    "today",
    "--to",
    to_date,
    "--plain",
])

lines = [ln for ln in raw.splitlines() if ln.strip()]
reader = csv.DictReader(lines, delimiter='\t')

report = {
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "calendar": calendar_id,
    "range": {"from": "today", "to": to_date},
    "totals": {"events_seen": 0, "all_day_skipped": 0, "flagged": 0},
    "flagged_events": [],
    "summary": "",
}

for row in reader:
    event_id = (row.get("ID") or "").strip()
    if not event_id:
        continue
    report["totals"]["events_seen"] += 1

    # Pull full event to inspect attendees/recurrence/all-day accurately
    try:
        detail_raw = run(["gog", "cal", "event", calendar_id, event_id, "--json", "--results-only"])
        ev = json.loads(detail_raw)
    except Exception:
        # fallback from list row
        ev = {
            "id": event_id,
            "summary": (row.get("SUMMARY") or "").strip(),
            "start": {"dateTime": (row.get("START") or "").strip()},
            "end": {"dateTime": (row.get("END") or "").strip()},
        }

    title = (ev.get("summary") or "(no title)").strip()
    start_dt, end_dt, all_day = event_start_end(ev)

    if all_day:
        report["totals"]["all_day_skipped"] += 1
        continue

    reasons = []
    low_priority = False

    if has_external_attendees(ev):
        reasons.append("external attendees")

    lower_title = title.lower()
    kw_hits = [kw for kw in KEYWORDS if kw in lower_title]
    if kw_hits:
        reasons.append(f"keyword in title: {', '.join(kw_hits)}")

    recurring = bool(ev.get("recurringEventId") or ev.get("recurrence"))
    if recurring and ONE_ON_ONE_PAT.search(title):
        reasons.append("recurring 1:1")
        low_priority = True

    if not reasons:
        continue

    report["totals"]["flagged"] += 1
    report["flagged_events"].append(
        {
            "id": ev.get("id", event_id),
            "title": title,
            "start": start_dt.isoformat() if start_dt else None,
            "end": end_dt.isoformat() if end_dt else None,
            "time_until": format_delta(start_dt),
            "priority": "low" if low_priority else "normal",
            "reasons": reasons,
            "prep_actions": build_actions(reasons, low_priority),
            "html_link": ev.get("htmlLink"),
        }
    )

flagged = report["totals"]["flagged"]
seen = report["totals"]["events_seen"]
skipped = report["totals"]["all_day_skipped"]
report["summary"] = f"Flagged {flagged} of {seen} events ({skipped} all-day skipped)."

# JSON report
print(json.dumps(report, indent=2))
print("\n--- SUMMARY ---")
print(report["summary"])

if flagged:
    for i, e in enumerate(report["flagged_events"], 1):
        print(f"{i}. [{e['priority']}] {e['title']} ({e['time_until']})")
        print(f"   Reasons: {', '.join(e['reasons'])}")
        print(f"   Prep: {('; '.join(e['prep_actions']))}")

# Log to cortana_events (best effort)
try:
    metadata = json.dumps(
        {
            "calendar": calendar_id,
            "range_to": to_date,
            "events_seen": seen,
            "all_day_skipped": skipped,
            "flagged": flagged,
            "flagged_titles": [e["title"] for e in report["flagged_events"]],
        }
    ).replace("'", "''")

    msg = report["summary"].replace("'", "''")
    sql = (
        "INSERT INTO cortana_events (timestamp, event_type, source, severity, message, metadata) "
        "VALUES (NOW(), 'calendar_prep_detector', 'prep-detector.sh', 'info', "
        f"'{msg}', '{metadata}'::jsonb);"
    )

    psql_bin = os.environ.get("PSQL_BIN") or "/opt/homebrew/opt/postgresql@17/bin/psql"
    if not os.path.exists(psql_bin):
        psql_bin = "psql"
    subprocess.run([psql_bin, "cortana", "-c", sql], check=False, capture_output=True, text=True)
except Exception:
    pass
PY
