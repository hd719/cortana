#!/usr/bin/env bash
set -euo pipefail

# Earnings alert engine
# - Reads held symbols from Alpaca portfolio API (localhost:3033)
# - Reads local earnings date map from earnings-calendar.json
# - Emits JSON: {"alerts":[{"symbol":"NVDA","alert_type":"t-24h","earnings_date":"2026-03-05"}]}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CALENDAR_FILE="$SCRIPT_DIR/earnings-calendar.json"
PORTFOLIO_URL="${PORTFOLIO_URL:-http://localhost:3033/alpaca/portfolio}"
TZ_NAME="${TZ_NAME:-America/New_York}"

if ! command -v jq >/dev/null 2>&1; then
  echo '{"alerts":[],"error":"jq is required"}'
  exit 1
fi

if [[ ! -f "$CALENDAR_FILE" ]]; then
  echo '{"alerts":[],"error":"earnings-calendar.json not found"}'
  exit 1
fi

# 1) Holdings from Alpaca
portfolio_json="$(curl -fsS "$PORTFOLIO_URL" 2>/dev/null || echo '{"positions":[]}')"
held_symbols="$(echo "$portfolio_json" | jq -r '.positions[]?.symbol // empty' | sort -u)"

# Fallback: if no live positions, evaluate all symbols in the local calendar.
if [[ -z "$held_symbols" ]]; then
  held_symbols="$(jq -r 'keys[]' "$CALENDAR_FILE" | sort -u)"
fi

now_et="$(TZ="$TZ_NAME" date '+%Y-%m-%d %H:%M:%S')"

echo "$held_symbols" | python3 - "$CALENDAR_FILE" "$now_et" <<'PY'
import json, sys
from datetime import datetime, date, timedelta

calendar_path = sys.argv[1]
now_et = datetime.strptime(sys.argv[2], "%Y-%m-%d %H:%M:%S")

with open(calendar_path, "r", encoding="utf-8") as f:
    cal = json.load(f)

symbols = [s.strip().upper() for s in sys.stdin.read().splitlines() if s.strip()]

alerts = []
today = now_et.date()
tomorrow = today + timedelta(days=1)

for symbol in symbols:
    earnings_date_raw = cal.get(symbol)
    if not earnings_date_raw:
        continue
    try:
        e_date = datetime.strptime(earnings_date_raw, "%Y-%m-%d").date()
    except ValueError:
        continue

    # Always flag earnings day itself.
    if e_date == today:
        alerts.append({
            "symbol": symbol,
            "alert_type": "today",
            "earnings_date": earnings_date_raw,
            "message": f"{symbol} reports earnings today"
        })

    # T-24h reminder (tomorrow)
    if e_date == tomorrow:
        alerts.append({
            "symbol": symbol,
            "alert_type": "t-24h",
            "earnings_date": earnings_date_raw,
            "message": f"Heads up — {symbol} reports earnings tomorrow after close"
        })

    # T-1h reminder at/after 3:00 PM ET on earnings day
    if e_date == today and now_et.hour == 15:
        alerts.append({
            "symbol": symbol,
            "alert_type": "t-1h",
            "earnings_date": earnings_date_raw,
            "message": f"Final reminder — {symbol} earnings dropping after close today"
        })

# deterministic order
alerts = sorted(alerts, key=lambda x: (x["earnings_date"], x["symbol"], x["alert_type"]))
print(json.dumps({"alerts": alerts}, indent=2))
PY
