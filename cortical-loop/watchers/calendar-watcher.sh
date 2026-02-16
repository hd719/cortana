#!/bin/bash
# Checks for approaching calendar events
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:$PATH"

EVENTS=$(gog --account hameldesai3@gmail.com calendar events "60e1d0b7ca7586249ee94341d65076f28d9b9f3ec67d89b0709371c0ff82d517@group.calendar.google.com" --from today --to tomorrow --json 2>/dev/null)
if [ $? -ne 0 ] || [ -z "$EVENTS" ]; then exit 0; fi

NOW_EPOCH=$(date +%s)
SENT_FILE="$HOME/clawd/cortical-loop/state/calendar-alerts-sent.txt"
mkdir -p "$(dirname "$SENT_FILE")"
touch "$SENT_FILE"

echo "$EVENTS" | jq -c '.events[]' 2>/dev/null | while read -r EVENT; do
  START=$(echo "$EVENT" | jq -r '.start.dateTime // .start.date // empty')
  [ -z "$START" ] && continue
  
  START_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${START%%+*}" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%S" "${START%%Z*}" +%s 2>/dev/null)
  [ -z "$START_EPOCH" ] && continue
  
  MINS_UNTIL=$(( (START_EPOCH - NOW_EPOCH) / 60 ))
  TITLE=$(echo "$EVENT" | jq -r '.summary // "Untitled"')
  EVENT_ID=$(echo "$EVENT" | jq -r '.id // empty')
  
  # Alert at 60, 15, 5 min marks
  for THRESHOLD in 60 15 5; do
    if [ "$MINS_UNTIL" -le "$THRESHOLD" ] && [ "$MINS_UNTIL" -gt 0 ]; then
      ALERT_KEY="${EVENT_ID}_${THRESHOLD}"
      if ! grep -q "$ALERT_KEY" "$SENT_FILE" 2>/dev/null; then
        PAYLOAD=$(jq -n --arg title "$TITLE" --arg start "$START" --argjson mins "$MINS_UNTIL" --argjson thresh "$THRESHOLD" \
          '{title: $title, start: $start, minutes_until: $mins, threshold: $thresh}')
        psql cortana -q -c "INSERT INTO cortana_event_stream (source, event_type, payload) VALUES ('calendar', 'event_approaching', '$PAYLOAD'::jsonb);" 2>/dev/null
        echo "$ALERT_KEY" >> "$SENT_FILE"
      fi
    fi
  done
done

# Clean sent file daily
find "$SENT_FILE" -mtime +1 -exec truncate -s 0 {} \; 2>/dev/null
