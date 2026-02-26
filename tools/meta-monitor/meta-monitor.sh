#!/usr/bin/env bash
set -euo pipefail

PSQL_BIN="${PSQL_BIN:-/opt/homebrew/opt/postgresql@17/bin/psql}"
DB_NAME="${DB_NAME:-cortana}"
LAST_N="${LAST_N:-10}"
DOWN_THRESHOLD_SECONDS="${DOWN_THRESHOLD_SECONDS:-3600}"
META_STALE_SECONDS="${META_STALE_SECONDS:-28800}" # 8h; cron runs every 6h

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${SCRIPT_DIR}/state"
STATE_FILE="${STATE_DIR}/last_run_epoch"
MODE="full"

usage() {
  cat <<'EOF'
Usage: meta-monitor.sh [--json | --brief]

Monitors monitor health from PostgreSQL:
- cortana_cron_health: flags crons with >=2 consecutive failures
- cortana_tool_health: flags tools down continuously for >1h
- Meta-monitor staleness: checks last run timestamp in local state file

Flags:
  --json   Machine-readable JSON output
  --brief  One-line summary
  -h, --help  Show this help

Environment overrides:
  PSQL_BIN, DB_NAME, LAST_N, DOWN_THRESHOLD_SECONDS, META_STALE_SECONDS
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

if [[ ! -x "$PSQL_BIN" ]]; then
  echo "ERROR: psql binary not executable at $PSQL_BIN" >&2
  exit 1
fi

mkdir -p "$STATE_DIR"

CRON_DATA="$($PSQL_BIN "$DB_NAME" -q -X -t -A -v ON_ERROR_STOP=1 -c "
SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.cron_name, t.timestamp DESC)::text, '[]')
FROM (
  SELECT
    cron_name,
    timestamp,
    status,
    consecutive_failures,
    COALESCE(metadata->>'last_error', metadata->>'error', metadata->>'reason', '') AS last_error
  FROM cortana_cron_health
  WHERE timestamp >= NOW() - INTERVAL '14 days'
) t;
")"

TOOL_DATA="$($PSQL_BIN "$DB_NAME" -q -X -t -A -v ON_ERROR_STOP=1 -c "
SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.tool_name, t.timestamp DESC)::text, '[]')
FROM (
  SELECT
    tool_name,
    timestamp,
    status,
    COALESCE(error, '') AS error
  FROM cortana_tool_health
  WHERE timestamp >= NOW() - INTERVAL '14 days'
) t;
")"

NOW_EPOCH="$(date +%s)"
PREV_RUN_EPOCH=""
if [[ -f "$STATE_FILE" ]]; then
  PREV_RUN_EPOCH="$(cat "$STATE_FILE" 2>/dev/null || true)"
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
printf '%s' "$CRON_DATA" > "$TMP_DIR/cron.json"
printf '%s' "$TOOL_DATA" > "$TMP_DIR/tool.json"

python3 - "$TMP_DIR/cron.json" "$TMP_DIR/tool.json" "$LAST_N" "$DOWN_THRESHOLD_SECONDS" "$NOW_EPOCH" "$PREV_RUN_EPOCH" "$META_STALE_SECONDS" "$MODE" <<'PY'
import json
import sys
from datetime import datetime, timezone

cron_path, tool_path, last_n, down_threshold, now_epoch, prev_run_raw, meta_stale_seconds, mode = sys.argv[1:9]
with open(cron_path) as f:
    cron_rows = json.load(f)
with open(tool_path) as f:
    tool_rows = json.load(f)
last_n = int(last_n or "10")
down_threshold = int(down_threshold or "3600")
now_epoch = int(now_epoch or "0")
prev_run_raw = (prev_run_raw or "").strip()
meta_stale_seconds = int(meta_stale_seconds or "28800")

BAD = {"failed", "fail", "missed", "down", "error", "degraded", "critical"}
GOOD = {"ok", "healthy", "up", "nominal"}

def parse_ts(ts: str) -> int:
    # Handles ISO from postgres (with timezone)
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return int(dt.timestamp())

def iso(epoch: int | None):
    if not epoch:
        return None
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat()

# ---- Cron analysis: >=2 consecutive failures in last N runs ----
by_cron = {}
for row in cron_rows:
    by_cron.setdefault(row.get("cron_name") or "unknown", []).append(row)

cron_alerts = []
for cron_name, rows in by_cron.items():
    # rows are already DESC by timestamp from SQL ordering, but ensure anyway
    rows = sorted(rows, key=lambda r: r.get("timestamp", ""), reverse=True)
    recent = rows[:last_n]
    if not recent:
        continue

    fail_count = 0
    last_error = ""
    for r in recent:
        status = str(r.get("status") or "").strip().lower()
        if status in GOOD:
            break
        fail_count += 1
        if not last_error:
            last_error = (r.get("last_error") or "").strip()

    if fail_count >= 2:
        last_success_epoch = None
        for r in rows:
            status = str(r.get("status") or "").strip().lower()
            if status in GOOD:
                last_success_epoch = parse_ts(r["timestamp"])
                break
        cron_alerts.append({
            "cron_name": cron_name,
            "consecutive_failures": fail_count,
            "last_error": last_error or "(no error message)",
            "last_success_at": iso(last_success_epoch),
            "last_seen_at": recent[0].get("timestamp"),
        })

cron_alerts.sort(key=lambda x: (-x["consecutive_failures"], x["cron_name"]))

# ---- Tool analysis: down continuously for >1h ----
by_tool = {}
for row in tool_rows:
    by_tool.setdefault(row.get("tool_name") or "unknown", []).append(row)

tool_alerts = []
for tool_name, rows in by_tool.items():
    rows = sorted(rows, key=lambda r: r.get("timestamp", ""), reverse=True)
    if not rows:
        continue

    latest = rows[0]
    latest_status = str(latest.get("status") or "").strip().lower()
    if latest_status in GOOD:
        continue

    down_start_epoch = parse_ts(latest["timestamp"])
    latest_error = (latest.get("error") or "").strip()

    # walk backward until first known-good status; down streak starts at oldest bad before that
    for r in rows[1:]:
        status = str(r.get("status") or "").strip().lower()
        ts_epoch = parse_ts(r["timestamp"])
        if status in GOOD:
            break
        down_start_epoch = ts_epoch
        if not latest_error:
            latest_error = (r.get("error") or "").strip()

    down_for = now_epoch - down_start_epoch
    if down_for > down_threshold:
        tool_alerts.append({
            "tool_name": tool_name,
            "status": latest.get("status"),
            "down_since": iso(down_start_epoch),
            "down_for_seconds": down_for,
            "last_error": latest_error or "(no error message)",
            "last_seen_at": latest.get("timestamp"),
        })

tool_alerts.sort(key=lambda x: (-x["down_for_seconds"], x["tool_name"]))

# ---- Meta-monitor self staleness ----
prev_run_epoch = int(prev_run_raw) if prev_run_raw.isdigit() else None
meta = {
    "last_run_at": iso(prev_run_epoch),
    "last_run_epoch": prev_run_epoch,
    "now_at": iso(now_epoch),
    "now_epoch": now_epoch,
    "stale_after_seconds": meta_stale_seconds,
    "is_stale": False,
    "seconds_since_last_run": None,
}
if prev_run_epoch:
    delta = now_epoch - prev_run_epoch
    meta["seconds_since_last_run"] = delta
    meta["is_stale"] = delta > meta_stale_seconds

overall = "ok"
if meta["is_stale"] or cron_alerts or tool_alerts:
    overall = "warn"
if meta["is_stale"] and (cron_alerts or tool_alerts):
    overall = "critical"

icon = {"ok": "✅", "warn": "⚠️", "critical": "❌"}[overall]
payload = {
    "generated_at": iso(now_epoch),
    "overall": overall,
    "status_icon": icon,
    "thresholds": {
        "cron_last_n": last_n,
        "tool_down_seconds": down_threshold,
        "meta_stale_seconds": meta_stale_seconds,
    },
    "cron": {
        "tracked": len(by_cron),
        "alerts": cron_alerts,
    },
    "tools": {
        "tracked": len(by_tool),
        "alerts": tool_alerts,
    },
    "meta_monitor": meta,
}

if mode == "json":
    print(json.dumps(payload, indent=2))
elif mode == "brief":
    print(
        f"{icon} overall={overall} "
        f"cron_alerts={len(cron_alerts)} "
        f"tool_alerts={len(tool_alerts)} "
        f"meta_stale={'yes' if meta['is_stale'] else 'no'}"
    )
else:
    print(f"{icon} Meta Monitor")
    print(f"Generated: {payload['generated_at']}")
    print("")
    print(f"{'✅' if not cron_alerts else '⚠️'} Cron health: {len(cron_alerts)} alert(s) from {len(by_cron)} tracked")
    for a in cron_alerts:
        print(
            f"  - {a['cron_name']}: {a['consecutive_failures']} consecutive failures; "
            f"last error: {a['last_error']}; last success: {a['last_success_at'] or 'never/unknown'}"
        )

    print("")
    print(f"{'✅' if not tool_alerts else '⚠️'} Tool health: {len(tool_alerts)} alert(s) from {len(by_tool)} tracked")
    for a in tool_alerts:
        mins = round(a['down_for_seconds'] / 60, 1)
        print(
            f"  - {a['tool_name']}: status={a['status']}, down_for={mins}m, "
            f"down_since={a['down_since']}, last_error={a['last_error']}"
        )

    print("")
    mm_icon = '⚠️' if meta['is_stale'] else '✅'
    age = meta['seconds_since_last_run']
    age_str = f"{round(age/3600,2)}h" if age is not None else "first run"
    print(f"{mm_icon} Meta-monitor recency: {age_str} since previous run (stale>{round(meta_stale_seconds/3600,2)}h)")
PY

# update state only after successful report generation
printf '%s\n' "$NOW_EPOCH" > "$STATE_FILE"
