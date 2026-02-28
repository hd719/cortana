#!/usr/bin/env bash
set -euo pipefail

# 1. Tonal tokens
if [[ -f "$HOME/Developer/cortana-external/tonal_tokens.json" ]]; then
  TONAL_STATUS=$(python3 - << 'PYEOF'
import json, pathlib
p = pathlib.Path.home() / 'Developer' / 'cortana-external' / 'tonal_tokens.json'
try:
    t = json.loads(p.read_text())
    print('tonal: ok' if t.get('access_token') else 'tonal: NO TOKEN')
except Exception:
    print('tonal: NO TOKEN')
PYEOF
  )
else
  TONAL_STATUS="tonal: NO TOKEN"
fi

# 2. Services
PG_OK=1
pg_isready -q 2>/dev/null || PG_OK=0
GATEWAY_OK=1
curl -sf http://localhost:18800/json > /dev/null 2>&1 || GATEWAY_OK=0

# 3. Disk usage (% as integer)
DISK_USE=$(df -h / | tail -1 | awk '{gsub("%","",$5); print $5}')

# 4. Oversized session files
OVERSIZED=$(find "$HOME/.openclaw/agents/main/sessions" -name '*.jsonl' -size +400k 2>/dev/null | wc -l | tr -d ' ')
AUTO_HEALED=0
if [[ "$OVERSIZED" =~ ^[0-9]+$ ]] && [ "$OVERSIZED" -gt 0 ]; then
  find "$HOME/.openclaw/agents/main/sessions" -name '*.jsonl' -size +400k -delete 2>/dev/null || true
  export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
  psql cortana -c "INSERT INTO cortana_events (event_type, source, severity, message) VALUES ('auto_heal', 'immune_scan', 'info', 'Cleaned oversized session');" >/dev/null 2>&1 || true
  AUTO_HEALED=1
fi

OUTPUT=""

if [[ "$TONAL_STATUS" != "tonal: ok" ]]; then
  OUTPUT+="$TONAL_STATUS
"
fi

if [ $PG_OK -eq 0 ]; then
  OUTPUT+="postgres: DOWN
"
fi

if [ $GATEWAY_OK -eq 0 ]; then
  OUTPUT+="gateway: DOWN
"
fi

if [[ "$DISK_USE" =~ ^[0-9]+$ ]] && [ "$DISK_USE" -ge 90 ]; then
  OUTPUT+="disk: ${DISK_USE}%
"
fi

if [ $AUTO_HEALED -eq 1 ]; then
  OUTPUT+="auto-heal: cleaned oversized session files
"
fi

if [ -n "$OUTPUT" ]; then
  printf "%s" "$OUTPUT" | sed 's/[[:space:]]*$//'
fi
