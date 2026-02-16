#!/bin/bash
# Polls Whoop for recovery updates
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:$PATH"

STATE_FILE="$HOME/clawd/cortical-loop/state/health-last-recovery.txt"
mkdir -p "$(dirname "$STATE_FILE")"

WHOOP=$(curl -s http://localhost:8080/whoop/data 2>/dev/null)
if [ $? -ne 0 ] || [ -z "$WHOOP" ]; then exit 0; fi

RECOVERY=$(echo "$WHOOP" | jq -r '.recovery[0].score.recovery_score // empty' 2>/dev/null)
HRV=$(echo "$WHOOP" | jq -r '.recovery[0].score.hrv_rmssd_milli // empty' 2>/dev/null)
[ -z "$RECOVERY" ] && exit 0

LAST_RECOVERY=$(cat "$STATE_FILE" 2>/dev/null)

if [ "$RECOVERY" != "$LAST_RECOVERY" ]; then
  PAYLOAD=$(jq -n --argjson rec "${RECOVERY:-0}" --argjson hrv "${HRV:-0}" \
    '{recovery_score: $rec, hrv: $hrv}')
  psql cortana -q -c "INSERT INTO cortana_event_stream (source, event_type, payload) VALUES ('health', 'recovery_update', '$PAYLOAD'::jsonb);" 2>/dev/null
  echo "$RECOVERY" > "$STATE_FILE"
fi
