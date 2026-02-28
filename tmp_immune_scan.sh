#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

# 1. Check Tonal tokens
ACCESS_TOKEN=""
if [ -f "$HOME/Developer/cortana-external/tonal_tokens.json" ]; then
  ACCESS_TOKEN=$(python3 - << 'PY'
import json, pathlib
p = pathlib.Path.home() / 'Developer/cortana-external/tonal_tokens.json'
try:
    with p.open() as f:
        t = json.load(f)
    print(t.get('access_token') or '')
except Exception:
    print('')
PY
  )
fi
if [ -n "$ACCESS_TOKEN" ]; then
  TONAL_STATUS="tonal: ok"
else
  TONAL_STATUS="tonal: NO TOKEN"
fi

# 2. Check services
if command -v pg_isready >/dev/null 2>&1 && pg_isready -q >/dev/null 2>&1; then
  PG_STATUS="postgres: ok"
else
  PG_STATUS="postgres: DOWN"
fi
if curl -sf http://localhost:18800/json >/dev/null 2>&1; then
  GATEWAY_STATUS="gateway: ok"
else
  GATEWAY_STATUS="gateway: DOWN"
fi

# 3. Check disk
DISK_STATUS=$(df -h / | tail -1 | awk '{print "disk: " $5}')
DISK_PCT=${DISK_STATUS#disk: }
DISK_PCT_NUM=${DISK_PCT%%%}

# 4. Oversized session files + auto-heal
OVERSIZED_FILES=$(find "$HOME/.openclaw/agents/main/sessions" -name '*.jsonl' -size +400k 2>/dev/null || true)
AUTOHEAL_MSG=""
if [ -n "$OVERSIZED_FILES" ]; then
  echo "$OVERSIZED_FILES" | xargs rm -f 2>/dev/null || true
  psql cortana -c "INSERT INTO cortana_events (event_type, source, severity, message) VALUES ('auto_heal', 'immune_scan', 'info', 'Cleaned oversized session');" >/dev/null 2>&1 || true
  AUTOHEAL_MSG="auto-heal: cleaned oversized session files"
fi

OUTPUT=""
[ "$TONAL_STATUS" != "tonal: ok" ] && OUTPUT+="$TONAL_STATUS
"
[ "$PG_STATUS" != "postgres: ok" ] && OUTPUT+="$PG_STATUS
"
[ "$GATEWAY_STATUS" != "gateway: ok" ] && OUTPUT+="$GATEWAY_STATUS
"
if [ "${DISK_PCT_NUM:-0}" -ge 90 ] 2>/dev/null; then OUTPUT+="$DISK_STATUS
"; fi
[ -n "$AUTOHEAL_MSG" ] && OUTPUT+="$AUTOHEAL_MSG
"

if [ -n "$OUTPUT" ]; then
  printf '%s' "$OUTPUT" | sed '/^$/d'
fi
