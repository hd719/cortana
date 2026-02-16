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
  # Fetch quote from Yahoo Finance API
  RESULT=$(curl -s "https://query1.finance.yahoo.com/v8/finance/chart/${TICKER}?range=1d&interval=1d" 2>/dev/null)
  [ $? -ne 0 ] && continue

  PRICE=$(echo "$RESULT" | jq -r '.chart.result[0].meta.regularMarketPrice // empty' 2>/dev/null)
  PREV_CLOSE=$(echo "$RESULT" | jq -r '.chart.result[0].meta.chartPreviousClose // empty' 2>/dev/null)
  [ -z "$PRICE" ] || [ -z "$PREV_CLOSE" ] && continue
  CHANGE_PCT=$(echo "$PRICE $PREV_CLOSE" | awk '{printf "%.2f", (($1 - $2) / $2) * 100}')
  
  # Check threshold (>3% move)
  ABOVE=$(echo "$CHANGE_PCT" | awk '{print ($1 > 3 || $1 < -3) ? "1" : "0"}')
  if [ "$ABOVE" = "1" ]; then
    PAYLOAD=$(jq -n --arg ticker "$TICKER" --argjson price "${PRICE}" --argjson pct "${CHANGE_PCT}" \
      '{ticker: $ticker, price: $price, change_pct: $pct}')
    psql cortana -q -c "INSERT INTO cortana_event_stream (source, event_type, payload) VALUES ('finance', 'price_alert', '$PAYLOAD'::jsonb);" 2>/dev/null
  fi
done
