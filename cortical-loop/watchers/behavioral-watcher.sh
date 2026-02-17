#!/bin/bash
# Behavioral Watcher — detects implicit feedback from Hamel's behavior
# Runs every 30 min via LaunchAgent
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:$PATH"

LOG="$HOME/clawd/cortical-loop/logs/behavioral-watcher.log"
STATE_FILE="$HOME/clawd/cortical-loop/state/behavioral-last-check.txt"
log() { echo "$(TZ=America/New_York date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"; }

LAST_CHECK=$(cat "$STATE_FILE" 2>/dev/null || echo "1 hour ago")
NOW=$(TZ=America/New_York date '+%Y-%m-%d %H:%M:%S%z')

# ============================================================
# 1. Response Latency — check recent wake events for engagement
# ============================================================
# Find wake events from the last 3 hours that haven't been checked
WAKE_EVENTS=$(psql cortana -t -A -c "
  SELECT id, timestamp, metadata->>'wake_number' as wake_num
  FROM cortana_events 
  WHERE event_type = 'cortical_wake' 
    AND timestamp > NOW() - INTERVAL '3 hours'
    AND id NOT IN (
      SELECT CAST(metadata->>'wake_event_id' AS INTEGER) 
      FROM cortana_events 
      WHERE event_type = 'behavioral_check' 
        AND metadata->>'wake_event_id' IS NOT NULL
    )
  ORDER BY timestamp ASC;" 2>/dev/null)

if [ -n "$WAKE_EVENTS" ]; then
  echo "$WAKE_EVENTS" | while IFS='|' read -r EVT_ID EVT_TIME WAKE_NUM; do
    [ -z "$EVT_ID" ] && continue
    
    # Check how long ago the wake was
    WAKE_AGE_MIN=$(psql cortana -t -A -c "SELECT EXTRACT(EPOCH FROM NOW() - '$EVT_TIME'::timestamptz) / 60;" 2>/dev/null | awk '{printf "%d", $1}')
    
    # Only evaluate if enough time has passed (at least 30 min)
    if [ "$WAKE_AGE_MIN" -lt 30 ]; then
      continue
    fi
    
    # Check if there was a session interaction after the wake
    # Look for recent session file modifications as proxy for engagement
    SESSION_DIR="$HOME/.openclaw/sessions"
    if [ -d "$SESSION_DIR" ]; then
      # Find main session files modified after the wake event
      ENGAGED=$(find "$SESSION_DIR" -name "*.json" -newer "$STATE_FILE" -mmin -"$WAKE_AGE_MIN" 2>/dev/null | head -1)
    fi
    
    # Determine signal based on latency
    if [ "$WAKE_AGE_MIN" -lt 5 ] && [ -n "$ENGAGED" ]; then
      # Quick response — positive signal
      SIGNAL="positive"
      DELTA="0.05"
    elif [ "$WAKE_AGE_MIN" -lt 30 ] && [ -n "$ENGAGED" ]; then
      # Moderate response — neutral, no adjustment
      SIGNAL="neutral"
      DELTA="0"
    elif [ "$WAKE_AGE_MIN" -ge 120 ]; then
      # No reply for 2+ hours — slight negative
      SIGNAL="negative"
      DELTA="-0.02"
    else
      SIGNAL="neutral"
      DELTA="0"
    fi
    
    if [ "$DELTA" != "0" ]; then
      # Try to find the related wake rule from the wake prompt
      RELATED_RULE=$(psql cortana -t -A -c "
        SELECT name FROM cortana_wake_rules 
        WHERE last_triggered IS NOT NULL 
          AND last_triggered BETWEEN '$EVT_TIME'::timestamptz - INTERVAL '5 minutes' AND '$EVT_TIME'::timestamptz + INTERVAL '1 minute'
        LIMIT 1;" 2>/dev/null)
      
      psql cortana -q -c "INSERT INTO cortana_feedback_signals (signal_type, source, related_rule, weight_delta, context) 
        VALUES ('$SIGNAL', 'behavioral', '$(echo $RELATED_RULE | tr -d " ")', $DELTA, 'Response latency: ${WAKE_AGE_MIN}min after wake #$WAKE_NUM');" 2>/dev/null
      log "Behavioral signal: $SIGNAL (latency=${WAKE_AGE_MIN}min, rule=$RELATED_RULE, delta=$DELTA)"
    fi
    
    # Mark this wake event as checked
    psql cortana -q -c "INSERT INTO cortana_events (event_type, source, severity, message, metadata)
      VALUES ('behavioral_check', 'behavioral_watcher', 'info', 'Checked wake event $EVT_ID', '{\"wake_event_id\": $EVT_ID}');" 2>/dev/null
  done
fi

# ============================================================
# 2. Correction Detection — scan for correction language
# ============================================================
# This is best handled at the LLM level (AGENTS.md correction protocol)
# The watcher just checks for cortana_feedback entries that map to wake rules

UNMAPPED=$(psql cortana -t -A -c "
  SELECT id, feedback_type, lesson 
  FROM cortana_feedback 
  WHERE applied = TRUE 
    AND timestamp > NOW() - INTERVAL '1 hour'
    AND feedback_type IN ('correction', 'behavior')
  LIMIT 5;" 2>/dev/null)

if [ -n "$UNMAPPED" ]; then
  echo "$UNMAPPED" | while IFS='|' read -r FB_ID FB_TYPE FB_LESSON; do
    [ -z "$FB_ID" ] && continue
    # Check if this correction already generated a signal
    EXISTS=$(psql cortana -t -A -c "SELECT COUNT(*) FROM cortana_feedback_signals WHERE context LIKE 'correction_fb_$FB_ID%';" 2>/dev/null | tr -d ' ')
    if [ "$EXISTS" -gt 0 ]; then continue; fi
    
    # Strong negative signal for corrections
    psql cortana -q -c "INSERT INTO cortana_feedback_signals (signal_type, source, weight_delta, context) 
      VALUES ('negative', 'correction', -0.15, 'correction_fb_$FB_ID: $FB_LESSON');" 2>/dev/null
    log "Correction signal from feedback #$FB_ID: $FB_LESSON"
  done
fi

# Update last check timestamp
echo "$NOW" > "$STATE_FILE"
log "Behavioral watcher cycle complete"
