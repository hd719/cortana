#!/bin/bash
# Updates the Chief Model based on passive signals
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:$PATH"

NOW_HOUR=$(TZ=America/New_York date +%H)
NOW_DOW=$(date +%u)

# Get last Telegram message time from OpenClaw (approximate via session file mtime)
LAST_MSG_AGE_MIN=999
SESSION_DIR="$HOME/.openclaw/agents/main/sessions"
if [ -d "$SESSION_DIR" ]; then
  LATEST=$(find "$SESSION_DIR" -name '*.jsonl' -maxdepth 1 -exec stat -f '%m %N' {} \; 2>/dev/null | sort -rn | head -1 | awk '{print $1}')
  if [ -n "$LATEST" ]; then
    NOW_EPOCH=$(date +%s)
    LAST_MSG_AGE_MIN=$(( (NOW_EPOCH - LATEST) / 60 ))
  fi
fi

# Infer awake/asleep
if [ "$LAST_MSG_AGE_MIN" -lt 30 ]; then
  STATE="awake"
  CONFIDENCE="0.95"
elif [ "$NOW_HOUR" -ge 7 ] && [ "$NOW_HOUR" -lt 23 ]; then
  STATE="likely_awake"
  CONFIDENCE="0.6"
else
  STATE="likely_asleep"
  CONFIDENCE="0.7"
fi

# Check if in meeting (calendar within ±15 min)
IN_MEETING="false"
EVENTS=$(gog --account hameldesai3@gmail.com calendar events "60e1d0b7ca7586249ee94341d65076f28d9b9f3ec67d89b0709371c0ff82d517@group.calendar.google.com" --from today --to tomorrow --json 2>/dev/null)
if [ -n "$EVENTS" ]; then
  NOW_EPOCH=$(date +%s)
  IN_MEETING=$(echo "$EVENTS" | jq -c '.[]' 2>/dev/null | while read -r EV; do
    START=$(echo "$EV" | jq -r '.start.dateTime // empty')
    END=$(echo "$EV" | jq -r '.end.dateTime // empty')
    [ -z "$START" ] || [ -z "$END" ] && continue
    S_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${START%%+*}" +%s 2>/dev/null)
    E_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${END%%+*}" +%s 2>/dev/null)
    if [ -n "$S_EPOCH" ] && [ -n "$E_EPOCH" ] && [ "$NOW_EPOCH" -ge "$S_EPOCH" ] && [ "$NOW_EPOCH" -le "$E_EPOCH" ]; then
      echo "true"
      break
    fi
  done)
  [ -z "$IN_MEETING" ] && IN_MEETING="false"
fi

# Determine energy from last Whoop recovery
RECOVERY=$(psql cortana -t -c "SELECT value->>'recovery_score' FROM cortana_sitrep_latest WHERE domain='health' AND key='whoop_recovery' LIMIT 1;" 2>/dev/null | tr -d ' ')
if [ -n "$RECOVERY" ] && [ "$RECOVERY" != "" ]; then
  REC_INT=${RECOVERY%%.*}
  if [ "$REC_INT" -ge 67 ]; then ENERGY="high"
  elif [ "$REC_INT" -ge 34 ]; then ENERGY="medium"
  else ENERGY="low"; fi
else
  ENERGY="unknown"
fi

# Bedtime check
PAST_BEDTIME="false"
if [ "$NOW_HOUR" -ge 22 ]; then PAST_BEDTIME="true"; fi

# Late activity event
if [ "$PAST_BEDTIME" = "true" ] && [ "$STATE" = "awake" ]; then
  FIRED=$(psql cortana -t -c "SELECT COUNT(*) FROM cortana_event_stream WHERE source='chief' AND event_type='late_activity' AND timestamp > CURRENT_DATE;" 2>/dev/null | tr -d ' ')
  if [ "$FIRED" = "0" ]; then
    psql cortana -q -c "INSERT INTO cortana_event_stream (source, event_type, payload) VALUES ('chief', 'late_activity', '{\"past_bedtime\": true, \"hour\": $NOW_HOUR}');" 2>/dev/null
  fi
fi

# Communication preference based on state
if [ "$ENERGY" = "low" ] || [ "$STATE" = "likely_asleep" ]; then
  COMM_STYLE="brief"
elif [ "$IN_MEETING" = "true" ]; then
  COMM_STYLE="minimal"
else
  COMM_STYLE="normal"
fi

# Update Chief Model
psql cortana -q -c "
  UPDATE cortana_chief_model SET value = jsonb_build_object('status', '$STATE', 'confidence', $CONFIDENCE), updated_at = NOW(), source = 'chief-state-watcher' WHERE key = 'state';
  UPDATE cortana_chief_model SET value = jsonb_build_object('level', '$ENERGY', 'recovery_score', $(echo ${RECOVERY:-null})), updated_at = NOW(), source = 'chief-state-watcher' WHERE key = 'energy';
  UPDATE cortana_chief_model SET value = jsonb_build_object('mode', CASE WHEN '$IN_MEETING' = 'true' THEN 'meeting' WHEN $NOW_HOUR >= 9 AND $NOW_HOUR < 17 AND $NOW_DOW <= 5 THEN 'work' ELSE 'personal' END, 'in_meeting', $IN_MEETING), updated_at = NOW(), source = 'chief-state-watcher' WHERE key = 'focus';
  UPDATE cortana_chief_model SET value = jsonb_build_object('style', '$COMM_STYLE', 'detail_level', CASE WHEN '$COMM_STYLE' = 'brief' THEN 'low' WHEN '$COMM_STYLE' = 'minimal' THEN 'minimal' ELSE 'medium' END), updated_at = NOW(), source = 'chief-state-watcher' WHERE key = 'communication_preference';
" 2>/dev/null
