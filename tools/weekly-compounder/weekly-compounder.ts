#!/usr/bin/env npx tsx
import { spawnSync } from "child_process";
import { resolveRepoPath } from "../lib/paths.js";

const ROOT_DIR = resolveRepoPath();

const script = String.raw`set -euo pipefail

# Weekly Compounder Scoreboard
# Builds a Telegram-ready weekly brief for Time / Health / Wealth / Career.

ROOT="${WEEKLY_COMPOUNDER_ROOT:?missing WEEKLY_COMPOUNDER_ROOT}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
GOG_HELPER="$ROOT/tools/gog/gog-with-env.ts"

NOW_ET="$(TZ=America/New_York date '+%Y-%m-%d %I:%M %p ET')"
TODAY="$(date +%Y-%m-%d)"
WEEK_END="$(date -v+7d +%Y-%m-%d 2>/dev/null || python3 - <<'PY'
from datetime import date, timedelta
print((date.today()+timedelta(days=7)).isoformat())
PY
)"

CAL_OUT="$TMP_DIR/calendar.txt"
WHOOP_JSON="$TMP_DIR/whoop.json"
TONAL_HEALTH="$TMP_DIR/tonal-health.json"
MARKET_TXT="$TMP_DIR/market.txt"
PORTFOLIO_JSON="$TMP_DIR/portfolio.json"

# 1) Calendar load + deadlines (requested command first)
if ! npx tsx "$GOG_HELPER" cal list "Clawdbot-Calendar" --from today --to "$WEEK_END" --plain >"$CAL_OUT" 2>/dev/null; then
  CAL_ID="60e1d0b7ca7586249ee94341d65076f28d9b9f3ec67d89b0709371c0ff82d517@group.calendar.google.com"
  npx tsx "$GOG_HELPER" calendar events "$CAL_ID" --from "$TODAY" --to "$WEEK_END" --json >"$CAL_OUT" 2>/dev/null || echo "(calendar unavailable)" >"$CAL_OUT"
fi

# 2) Whoop / Tonal trend data
curl -s http://localhost:3033/whoop/data > "$WHOOP_JSON" || echo '{}' > "$WHOOP_JSON"
curl -s http://localhost:3033/tonal/health > "$TONAL_HEALTH" || echo '{"status":"unhealthy"}' > "$TONAL_HEALTH"

# 3) Portfolio concentration + market intel
"$ROOT/tools/market-intel/market-intel.sh" --portfolio > "$MARKET_TXT" 2>/dev/null || echo "Portfolio intel unavailable" > "$MARKET_TXT"
curl -s http://localhost:3033/alpaca/portfolio > "$PORTFOLIO_JSON" || echo '{}' > "$PORTFOLIO_JSON"

# 4) Synthesize one-page Telegram markdown
python3 - "$CAL_OUT" "$WHOOP_JSON" "$TONAL_HEALTH" "$MARKET_TXT" "$PORTFOLIO_JSON" <<'PY'
import json, re, sys
from datetime import datetime
from pathlib import Path

cal_path, whoop_path, tonal_health_path, market_path, portfolio_path = map(Path, sys.argv[1:6])
now = datetime.now().strftime("%Y-%m-%d %I:%M %p ET")

calendar_text = cal_path.read_text(errors="ignore").strip()
market_text = market_path.read_text(errors="ignore").strip()

# ---- Calendar / Time ----
cal_lines = []
try:
    maybe_json = json.loads(calendar_text)
    if isinstance(maybe_json, dict) and isinstance(maybe_json.get("events"), list):
        for e in maybe_json["events"]:
            summary = (e.get("summary") or "(untitled)").strip()
            start = e.get("start") or {}
            when = (start.get("dateTime") or start.get("date") or "")[:10]
            cal_lines.append(f"{when} {summary}".strip())
except Exception:
    cal_lines = [l.strip() for l in calendar_text.splitlines() if l.strip()]

keywords = ("deadline", "due", "quiz", "exam", "hw", "assignment", "project")
deadline_lines = [l for l in cal_lines if any(k in l.lower() for k in keywords)]
meetingish = [l for l in cal_lines if any(k in l.lower() for k in ("meeting", "class", "sync", "standup"))]
time_score = min(100, len(cal_lines)*8 + len(deadline_lines)*15)

# ---- Health ----
try:
    whoop = json.loads(whoop_path.read_text())
except Exception:
    whoop = {}

recovery = []
sleep = []
for r in (whoop.get("recovery") or [])[:7]:
    try:
        recovery.append(float(r.get("score", {}).get("recovery_score", 0)))
    except Exception:
        pass
for s in (whoop.get("sleep") or [])[:7]:
    try:
        sleep.append(float(s.get("score", {}).get("sleep_performance_percentage", 0)))
    except Exception:
        pass

avg_recovery = round(sum(recovery)/len(recovery),1) if recovery else None
avg_sleep = round(sum(sleep)/len(sleep),1) if sleep else None
health_flags = 0
if avg_recovery is not None and avg_recovery < 67: health_flags += 1
if avg_sleep is not None and avg_sleep < 80: health_flags += 1
health_score = 35 + health_flags*30

try:
    tonal_health = json.loads(tonal_health_path.read_text())
except Exception:
    tonal_health = {"status":"unknown"}

# ---- Wealth ----
try:
    portfolio = json.loads(portfolio_path.read_text())
except Exception:
    portfolio = {}

positions = portfolio.get("positions") if isinstance(portfolio, dict) else None
weights = []
if isinstance(positions, list):
    for p in positions:
        w = p.get("weight")
        if w is None:
            mv = p.get("market_value")
            tv = (portfolio.get("total_value") or portfolio.get("equity")) if isinstance(portfolio, dict) else None
            try:
                if mv is not None and tv:
                    w = (float(mv) / float(tv)) * 100
            except Exception:
                w = None
        try:
            if w is not None:
                weights.append(float(w))
        except Exception:
            pass
weights = sorted(weights, reverse=True)
top2 = round(sum(weights[:2]),1) if weights else 50.0  # fallback from known profile
wealth_score = 40 + (25 if top2 >= 50 else 10 if top2 >= 40 else 0)

macro_items = []
for pat in [r"\bCPI\b", r"\bPPI\b", r"\bNFP\b", r"\bFOMC\b", r"\bFed\b", r"\bGDP\b", r"\bPCE\b"]:
    m = re.search(pat, market_text, re.I)
    if m:
        macro_items.append(m.group(0).upper())
macro_items = sorted(set(macro_items))
if not macro_items:
    macro_items = ["CPI", "PCE", "Jobs (NFP)"]

# ---- Career ----
career_items = [l for l in cal_lines if any(k in l.lower() for k in ("em-605", "masters", "homework", "quiz", "engineering", "project"))]
career_score = 45 + (20 if career_items else 0)

pillar_scores = {
    "Time": time_score,
    "Health": health_score,
    "Wealth": wealth_score,
    "Career": career_score,
}
ranked = sorted(pillar_scores.items(), key=lambda kv: kv[1], reverse=True)
top_two = [ranked[0][0], ranked[1][0]]

# Task templates
base_tasks = {
    "Time": "Time-block Monday: lock 2 x 90-minute deep-work blocks before meetings fill the week.",
    "Health": "Protect sleep floor: 9:30 PM lights-out for 5 nights; no phone in bed.",
    "Wealth": f"Diversification pass: if adding capital, route 70% to non-TSLA/NVDA positions until top-2 weight drops below 50% (now ~{top2}%).",
    "Career": "EM-605 + engineering sprint: finish the next graded deliverable by Wednesday and ship one measurable engineering artifact by Friday.",
}

task1 = base_tasks[top_two[0]]
task2 = base_tasks[top_two[1]]
task3 = "Wildcard: Sunday reset ritual (30 min) — review this scoreboard, choose one non-negotiable daily habit, and pre-commit in calendar."

# Build brief
print("📊 *Weekly Compounder Scoreboard*")
print(f"_Generated: {now}_\n")

print("*1) Time*")
print(f"• Calendar load (next 7d): {len(cal_lines)} events, {len(deadline_lines)} deadline-style items")
if deadline_lines:
    print(f"• Deadlines: {' | '.join(deadline_lines[:3])}")
else:
    print("• Deadlines: none detected (still protect focus blocks)")
print()

print("*2) Health*")
if avg_recovery is None or avg_sleep is None:
    print("• Whoop trend: unavailable")
else:
    print(f"• 7-day trend: Recovery {avg_recovery}% avg, Sleep {avg_sleep}% avg")
print(f"• Tonal status: {tonal_health.get('status','unknown')}")
print()

print("*3) Wealth*")
print(f"• Portfolio concentration: top-2 weight ~{top2}%")
print(f"• Market intel: {market_text.splitlines()[0] if market_text else 'unavailable'}")
print(f"• Macro watchlist this week: {', '.join(macro_items[:4])}")
print()

print("*4) Career*")
if career_items:
    print("• Pipeline signals: " + " | ".join(career_items[:3]))
else:
    print("• Pipeline signals: EM-605 coursework + engineering compounding remain weekly priorities")
print("• Focus: keep master's progress and shipping velocity in the same week")
print()

print("*Impact ranking (highest first)*")
print("• " + " > ".join([f"{k} ({v})" for k,v in ranked]))
print()
print("*3 concrete tasks for this week*")
print(f"1. {task1}")
print(f"2. {task2}")
print(f"3. {task3}")
PY
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const r = spawnSync("bash", ["-lc", script, "script", ...args], {
    encoding: "utf8",
    cwd: ROOT_DIR,
    env: { ...process.env, WEEKLY_COMPOUNDER_ROOT: ROOT_DIR },
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status ?? 1);
}

main();
