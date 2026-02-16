#!/bin/bash
# Checks key holdings for significant intraday moves (weekdays market hours only)
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:$PATH"

# Skip weekends
DOW=$(date +%u)
[ "$DOW" -gt 5 ] && exit 0

# Skip outside market hours (9:30 AM - 4 PM ET)
HOUR=$(TZ=America/New_York date +%H)
MIN=$(TZ=America/New_York date +%M)
MARKET_MIN=$((HOUR * 60 + MIN))
[ "$MARKET_MIN" -lt 570 ] && exit 0  # Before 9:30
[ "$MARKET_MIN" -gt 960 ] && exit 0  # After 4:00

STATE_FILE="$HOME/clawd/cortical-loop/state/portfolio-baselines.json"
mkdir -p "$(dirname "$STATE_FILE")"

for TICKER in TSLA NVDA GOOGL AAPL QQQ; do
  RESULT=$(cd ~/clawd/skills/stock-analysis && uv run src/stock_analysis/main.py analyze "$TICKER" --json 2>/dev/null)
  [ $? -ne 0 ] && continue
  
  PRICE=$(echo "$RESULT" | jq -r '.price // empty' 2>/dev/null)
  CHANGE_PCT=$(echo "$RESULT" | jq -r '.change_percent // empty' 2>/dev/null)
  [ -z "$PRICE" ] || [ -z "$CHANGE_PCT" ] && continue
  
  # Check threshold (>3% move)
  ABOVE=$(echo "$CHANGE_PCT" | awk '{print ($1 > 3 || $1 < -3) ? "1" : "0"}')
  if [ "$ABOVE" = "1" ]; then
    PAYLOAD=$(jq -n --arg ticker "$TICKER" --argjson price "${PRICE}" --argjson pct "${CHANGE_PCT}" \
      '{ticker: $ticker, price: $price, change_pct: $pct}')
    psql cortana -q -c "INSERT INTO cortana_event_stream (source, event_type, payload) VALUES ('finance', 'price_alert', '$PAYLOAD'::jsonb);" 2>/dev/null
  fi
done
