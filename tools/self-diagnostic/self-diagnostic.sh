#!/usr/bin/env bash
set -euo pipefail

PSQL_BIN="/opt/homebrew/opt/postgresql@17/bin/psql"
DB_NAME="cortana"
REPO_ROOT="${HOME}/clawd"
MEMORY_FILE="${REPO_ROOT}/MEMORY.md"
DAILY_DIR="${REPO_ROOT}/memory"
SESSIONS_DIR="${HOME}/.openclaw/agents/main/sessions"
BLOAT_BYTES=$((400 * 1024))
MODE="full"

usage() {
  cat <<'EOF'
Usage: self-diagnostic.sh [--json | --brief]

  --json   Output machine-readable JSON
  --brief  Output one-line human summary
  (none)   Output full formatted report
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)
      [[ "$MODE" == "full" ]] || { echo "Only one mode flag may be used" >&2; exit 2; }
      MODE="json"
      shift
      ;;
    --brief)
      [[ "$MODE" == "full" ]] || { echo "Only one mode flag may be used" >&2; exit 2; }
      MODE="brief"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown flag: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

sql_json() {
  local sql="$1"
  if [[ ! -x "$PSQL_BIN" ]]; then
    echo "null"
    return 0
  fi

  if ! "$PSQL_BIN" "$DB_NAME" -q -X -t -A -v ON_ERROR_STOP=1 -c "$sql" 2>/dev/null; then
    echo "null"
    return 0
  fi
}

SELF_MODEL_JSON="$(sql_json "
SELECT COALESCE(row_to_json(t)::text, 'null')
FROM (
  SELECT * FROM cortana_self_model WHERE id = 1 LIMIT 1
) t;")"

CRON_HEALTH_JSON="$(sql_json "
WITH recent AS (
  SELECT *
  FROM cortana_cron_health
  WHERE timestamp >= NOW() - INTERVAL '24 hours'
), latest AS (
  SELECT DISTINCT ON (cron_name)
    cron_name,
    status,
    consecutive_failures,
    run_duration_sec,
    timestamp,
    metadata
  FROM recent
  ORDER BY cron_name, timestamp DESC
), failures AS (
  SELECT
    cron_name,
    COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'')) NOT IN ('ok','healthy','up','nominal')) AS failure_events,
    MAX(COALESCE(consecutive_failures,0)) AS max_consecutive_failures
  FROM recent
  GROUP BY cron_name
)
SELECT COALESCE(json_agg(json_build_object(
  'cron_name', l.cron_name,
  'status', l.status,
  'consecutive_failures', COALESCE(l.consecutive_failures,0),
  'run_duration_sec', l.run_duration_sec,
  'timestamp', l.timestamp,
  'failure_events_24h', COALESCE(f.failure_events,0),
  'max_consecutive_failures_24h', COALESCE(f.max_consecutive_failures,0)
) ORDER BY l.cron_name)::text, '[]')
FROM latest l
LEFT JOIN failures f USING (cron_name);")"

TOOL_HEALTH_JSON="$(sql_json "
WITH recent AS (
  SELECT *
  FROM cortana_tool_health
  WHERE timestamp >= NOW() - INTERVAL '24 hours'
), latest AS (
  SELECT DISTINCT ON (tool_name)
    tool_name,
    status,
    response_ms,
    error,
    self_healed,
    timestamp
  FROM recent
  ORDER BY tool_name, timestamp DESC
), outages AS (
  SELECT
    tool_name,
    COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'')) NOT IN ('ok','healthy','up','nominal')) AS outage_events,
    MAX(timestamp) FILTER (WHERE LOWER(COALESCE(status,'')) NOT IN ('ok','healthy','up','nominal')) AS last_outage_at
  FROM recent
  GROUP BY tool_name
)
SELECT COALESCE(json_agg(json_build_object(
  'tool_name', l.tool_name,
  'status', l.status,
  'response_ms', l.response_ms,
  'error', l.error,
  'self_healed', l.self_healed,
  'timestamp', l.timestamp,
  'outage_events_24h', COALESCE(o.outage_events,0),
  'last_outage_at', o.last_outage_at
) ORDER BY l.tool_name)::text, '[]')
FROM latest l
LEFT JOIN outages o USING (tool_name);")"

BUDGET_JSON="$(sql_json "
SELECT COALESCE(row_to_json(t)::text, 'null')
FROM (
  SELECT id, timestamp, spend_to_date, burn_rate, projected, pct_used, breakdown
  FROM cortana_budget_log
  ORDER BY timestamp DESC
  LIMIT 1
) t;")"

TODAY="$(date +%F)"
YESTERDAY="$(date -v-1d +%F)"

MEMORY_SIZE=0
MEMORY_MTIME="null"
if [[ -f "$MEMORY_FILE" ]]; then
  MEMORY_SIZE="$(stat -f %z "$MEMORY_FILE" 2>/dev/null || echo 0)"
  MEMORY_MTIME="$(stat -f %m "$MEMORY_FILE" 2>/dev/null || echo null)"
fi

TODAY_NOTE_EXISTS=false
YESTERDAY_NOTE_EXISTS=false
[[ -f "${DAILY_DIR}/${TODAY}.md" ]] && TODAY_NOTE_EXISTS=true
[[ -f "${DAILY_DIR}/${YESTERDAY}.md" ]] && YESTERDAY_NOTE_EXISTS=true

SESSION_JSON="[]"
if [[ -d "$SESSIONS_DIR" ]]; then
  SESSION_JSON="$(python3 - "$SESSIONS_DIR" "$BLOAT_BYTES" <<'PY'
import json, os, sys
from pathlib import Path

sessions_dir = Path(sys.argv[1]).expanduser()
threshold = int(sys.argv[2])
out = []
for p in sorted(sessions_dir.glob('*.jsonl')):
    try:
        sz = p.stat().st_size
    except OSError:
        continue
    out.append({
        'path': str(p),
        'size_bytes': sz,
        'size_kb': round(sz/1024, 1),
        'bloated': sz > threshold,
    })
print(json.dumps(out, separators=(',',':')))
PY
)"
fi

export SELF_MODEL_JSON CRON_HEALTH_JSON TOOL_HEALTH_JSON BUDGET_JSON SESSION_JSON
export MEMORY_SIZE MEMORY_MTIME TODAY YESTERDAY TODAY_NOTE_EXISTS YESTERDAY_NOTE_EXISTS

python3 - "$MODE" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

mode = sys.argv[1]

self_model = json.loads(os.environ.get('SELF_MODEL_JSON', 'null') or 'null')
cron_health = json.loads(os.environ.get('CRON_HEALTH_JSON', '[]') or '[]')
tool_health = json.loads(os.environ.get('TOOL_HEALTH_JSON', '[]') or '[]')
budget = json.loads(os.environ.get('BUDGET_JSON', 'null') or 'null')
sessions = json.loads(os.environ.get('SESSION_JSON', '[]') or '[]')

memory_size = int(os.environ.get('MEMORY_SIZE', '0') or '0')
memory_mtime_raw = os.environ.get('MEMORY_MTIME', 'null')
memory_mtime = None
if memory_mtime_raw not in ('', 'null', 'None'):
    try:
        memory_mtime = datetime.fromtimestamp(int(memory_mtime_raw), tz=timezone.utc).isoformat()
    except Exception:
        memory_mtime = None

today = os.environ.get('TODAY')
yesterday = os.environ.get('YESTERDAY')
today_note_exists = os.environ.get('TODAY_NOTE_EXISTS', 'false').lower() == 'true'
yesterday_note_exists = os.environ.get('YESTERDAY_NOTE_EXISTS', 'false').lower() == 'true'

BAD = {'failed', 'fail', 'missed', 'down', 'error', 'degraded', 'critical'}

cron_failures = [c for c in cron_health if str(c.get('status', '')).lower() in BAD or int(c.get('failure_events_24h') or 0) > 0 or int(c.get('consecutive_failures') or 0) > 0]
tool_outages = [t for t in tool_health if str(t.get('status', '')).lower() in BAD or int(t.get('outage_events_24h') or 0) > 0]
bloated = [s for s in sessions if s.get('bloated')]

section = {}
section['self_model'] = 'ok' if self_model else 'fail'
section['cron'] = 'ok' if not cron_failures else 'warn'
section['tools'] = 'ok' if not tool_outages else 'warn'
section['budget'] = 'ok' if budget else 'warn'
section['memory'] = 'ok' if memory_size > 0 and today_note_exists and yesterday_note_exists else 'warn'
section['sessions'] = 'ok' if not bloated else 'warn'

if section['self_model'] == 'fail':
    overall = 'fail'
elif any(v == 'warn' for v in section.values()):
    overall = 'warn'
else:
    overall = 'ok'

icon = {'ok': '✅', 'warn': '⚠️', 'fail': '❌'}

payload = {
    'generated_at': datetime.now(timezone.utc).isoformat(),
    'overall': overall,
    'status_icon': icon[overall],
    'sections': section,
    'self_model': self_model,
    'cron': {
        'count_recent': len(cron_health),
        'failures': cron_failures,
    },
    'tools': {
        'count_recent': len(tool_health),
        'outages': tool_outages,
    },
    'budget': budget,
    'memory': {
        'memory_md_size_bytes': memory_size,
        'memory_md_size_kb': round(memory_size / 1024, 1),
        'memory_md_last_modified_utc': memory_mtime,
        'daily_note_today': {'date': today, 'exists': today_note_exists},
        'daily_note_yesterday': {'date': yesterday, 'exists': yesterday_note_exists},
    },
    'sessions': {
        'count': len(sessions),
        'bloated_count': len(bloated),
        'bloated_threshold_bytes': 409600,
        'bloated_files': bloated,
    },
}

if mode == 'json':
    print(json.dumps(payload, indent=2))
    raise SystemExit

if mode == 'brief':
    score = self_model.get('health_score') if isinstance(self_model, dict) else None
    print(
        f"{icon[overall]} overall={overall} "
        f"self_model={'ok' if self_model else 'missing'} "
        f"cron_failures={len(cron_failures)} "
        f"tool_outages={len(tool_outages)} "
        f"session_bloat={len(bloated)} "
        f"memory_today={'yes' if today_note_exists else 'no'} "
        f"memory_yesterday={'yes' if yesterday_note_exists else 'no'} "
        f"health_score={score if score is not None else 'n/a'}"
    )
    raise SystemExit

print(f"{icon[overall]} Cortana Self-Diagnostic")
print(f"Generated: {payload['generated_at']}")
print('')

print(f"{icon[section['self_model']]} Self Model")
if self_model:
    print(f"  health_score: {self_model.get('health_score', 'n/a')}")
    print(f"  status: {self_model.get('status', 'n/a')}")
    print(f"  updated_at: {self_model.get('updated_at', 'n/a')}")
else:
    print("  missing: no row returned from cortana_self_model(id=1)")

print('')
print(f"{icon[section['cron']]} Cron Health (last 24h)")
print(f"  tracked crons: {len(cron_health)}")
print(f"  crons with failures: {len(cron_failures)}")
for c in cron_failures[:10]:
    print(f"  - {c.get('cron_name')}: status={c.get('status')} failures_24h={c.get('failure_events_24h',0)} consecutive={c.get('consecutive_failures',0)}")
if len(cron_failures) > 10:
    print(f"  ... and {len(cron_failures)-10} more")

print('')
print(f"{icon[section['tools']]} Tool Health (last 24h)")
print(f"  tracked tools: {len(tool_health)}")
print(f"  tools with outages: {len(tool_outages)}")
for t in tool_outages[:10]:
    print(f"  - {t.get('tool_name')}: status={t.get('status')} outages_24h={t.get('outage_events_24h',0)}")
if len(tool_outages) > 10:
    print(f"  ... and {len(tool_outages)-10} more")

print('')
print(f"{icon[section['budget']]} Budget")
if budget:
    print(f"  timestamp: {budget.get('timestamp','n/a')}")
    print(f"  spend_to_date: {budget.get('spend_to_date','n/a')}")
    print(f"  burn_rate: {budget.get('burn_rate','n/a')}")
    print(f"  projected: {budget.get('projected','n/a')}")
    print(f"  pct_used: {budget.get('pct_used','n/a')}")
else:
    print("  missing: no rows in cortana_budget_log")

print('')
print(f"{icon[section['memory']]} Memory Coherence")
print(f"  MEMORY.md size: {memory_size} bytes ({round(memory_size/1024,1)} KB)")
print(f"  MEMORY.md modified (UTC): {memory_mtime or 'n/a'}")
print(f"  daily note today ({today}): {'present' if today_note_exists else 'missing'}")
print(f"  daily note yesterday ({yesterday}): {'present' if yesterday_note_exists else 'missing'}")

print('')
print(f"{icon[section['sessions']]} Session File Bloat")
print(f"  scanned session files: {len(sessions)}")
print(f"  bloated files (>400KB): {len(bloated)}")
for s in bloated[:10]:
    print(f"  - {s.get('path')} ({s.get('size_kb')} KB)")
if len(bloated) > 10:
    print(f"  ... and {len(bloated)-10} more")
PY
