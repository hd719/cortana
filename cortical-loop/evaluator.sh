#!/bin/bash
# Cortical Loop Evaluator — event-driven wake decisions
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:$PATH"

# CHECK KILL SWITCH
ENABLED=$(psql cortana -t -c "SELECT value::text FROM cortana_chief_model WHERE key='cortical_loop_enabled';" 2>/dev/null | tr -d ' "')
if [ "$ENABLED" != "true" ]; then
  exit 0
fi

# CHECK DAILY WAKE CAP
WAKE_DATA=$(psql cortana -t -c "SELECT value FROM cortana_chief_model WHERE key='daily_wake_count';" 2>/dev/null | tr -d ' ')
TODAY=$(TZ=America/New_York date +%Y-%m-%d)
WAKE_DATE=$(echo "$WAKE_DATA" | jq -r '.date // empty' 2>/dev/null)
WAKE_COUNT=$(echo "$WAKE_DATA" | jq -r '.count // 0' 2>/dev/null)
WAKE_MAX=$(echo "$WAKE_DATA" | jq -r '.max // 10' 2>/dev/null)

if [ "$WAKE_DATE" != "$TODAY" ]; then
  WAKE_COUNT=0
  psql cortana -q -c "UPDATE cortana_chief_model SET value = jsonb_build_object('count', 0, 'date', '$TODAY', 'max', $WAKE_MAX), updated_at = NOW() WHERE key = 'daily_wake_count';" 2>/dev/null
fi

if [ "$WAKE_COUNT" -ge "$WAKE_MAX" ]; then
  psql cortana -q -c "UPDATE cortana_chief_model SET value = '\"false\"', updated_at = NOW(), source = 'budget_guard' WHERE key = 'cortical_loop_enabled';" 2>/dev/null
  psql cortana -q -c "INSERT INTO cortana_events (event_type, source, severity, message) VALUES ('auto_disable', 'cortical_loop', 'warning', 'Daily wake cap ($WAKE_MAX) reached. Loop auto-disabled.');" 2>/dev/null
  exit 0
fi

# GET UNPROCESSED EVENTS
EVENTS=$(psql cortana -t -A -c "SELECT json_agg(e) FROM (SELECT id, source, event_type, payload FROM cortana_event_stream WHERE processed = FALSE ORDER BY timestamp ASC LIMIT 20) e;" 2>/dev/null)
if [ "$EVENTS" = "" ] || [ "$EVENTS" = "null" ]; then
  exit 0
fi

# GET CHIEF STATE
CHIEF_STATE=$(psql cortana -t -c "SELECT value->>'status' FROM cortana_chief_model WHERE key='state';" 2>/dev/null | tr -d ' ')

# GET ENABLED RULES
RULES=$(psql cortana -t -A -c "SELECT json_agg(r) FROM (SELECT id, name, source, event_type, condition, priority, weight, suppress_when FROM cortana_wake_rules WHERE enabled = TRUE ORDER BY priority ASC) r;" 2>/dev/null)

# EVALUATE: match events against rules
WAKE_EVENTS=""
MATCHED_EVENT_IDS=""

for EVENT_JSON in $(echo "$EVENTS" | jq -c '.[]' 2>/dev/null); do
  E_ID=$(echo "$EVENT_JSON" | jq -r '.id')
  E_SOURCE=$(echo "$EVENT_JSON" | jq -r '.source')
  E_TYPE=$(echo "$EVENT_JSON" | jq -r '.event_type')
  E_PAYLOAD=$(echo "$EVENT_JSON" | jq -c '.payload')
  
  for RULE_JSON in $(echo "$RULES" | jq -c '.[]' 2>/dev/null); do
    R_SOURCE=$(echo "$RULE_JSON" | jq -r '.source')
    R_TYPE=$(echo "$RULE_JSON" | jq -r '.event_type')
    R_PRIORITY=$(echo "$RULE_JSON" | jq -r '.priority')
    R_NAME=$(echo "$RULE_JSON" | jq -r '.name')
    R_SUPPRESS=$(echo "$RULE_JSON" | jq -r '.suppress_when.chief_state // empty')
    R_WEIGHT=$(echo "$RULE_JSON" | jq -r '.weight')
    
    # Match source and event type
    if [ "$E_SOURCE" = "$R_SOURCE" ] && [ "$E_TYPE" = "$R_TYPE" ]; then
      # Check suppress condition
      if [ -n "$R_SUPPRESS" ] && [ "$CHIEF_STATE" = "$R_SUPPRESS" ]; then
        continue
      fi
      
      # Check weight threshold (suppressed if weight < 0.3)
      BELOW=$(echo "$R_WEIGHT" | awk '{print ($1 < 0.3) ? "1" : "0"}')
      if [ "$BELOW" = "1" ]; then continue; fi
      
      # MATCH — add to wake events
      WAKE_EVENTS="$WAKE_EVENTS\n- [$R_NAME] (P$R_PRIORITY): $(echo $E_PAYLOAD | jq -c '.')"
      MATCHED_EVENT_IDS="$MATCHED_EVENT_IDS $E_ID"
      
      # Update rule stats
      psql cortana -q -c "UPDATE cortana_wake_rules SET last_triggered = NOW(), trigger_count = trigger_count + 1 WHERE name = '$R_NAME';" 2>/dev/null
    fi
  done
  
  # Mark event as processed regardless
  psql cortana -q -c "UPDATE cortana_event_stream SET processed = TRUE, processed_at = NOW() WHERE id = $E_ID;" 2>/dev/null
done

# If we have wake events, trigger LLM
if [ -n "$WAKE_EVENTS" ]; then
  # Get full chief model for context
  CHIEF_MODEL=$(psql cortana -t -A -c "SELECT json_object_agg(key, value) FROM cortana_chief_model;" 2>/dev/null)
  
  # Get relevant sitrep
  SITREP=$(psql cortana -t -A -c "SELECT json_object_agg(domain || '.' || key, value) FROM cortana_sitrep_latest;" 2>/dev/null)
  
  # Get recent feedback rules
  FEEDBACK=$(psql cortana -t -A -c "SELECT json_agg(f) FROM (SELECT lesson FROM cortana_feedback WHERE applied = TRUE ORDER BY timestamp DESC LIMIT 5) f;" 2>/dev/null)

  # Build wake prompt
  WAKE_PROMPT="CORTICAL LOOP WAKE — Event-driven alert.

TRIGGERED EVENTS:
$(echo -e "$WAKE_EVENTS")

CHIEF MODEL (current state):
$CHIEF_MODEL

RELEVANT SITREP:
$SITREP

BEHAVIORAL RULES (from past feedback):
$FEEDBACK

INSTRUCTIONS:
1. Analyze the triggered events in context of Chief's current state
2. Decide what action to take (message Chief, create task, update sitrep, or suppress)
3. If messaging Chief: adapt tone to communication_preference (brief/normal/minimal)
4. If Chief is asleep/likely_asleep: only message for priority 1-2 events
5. After acting, suggest if any wake rules should be adjusted (thresholds too sensitive/not sensitive enough)

Be concise. Act decisively. You are Cortana's nervous system responding to a real-time signal."

  # Write prompt to temp file
  PROMPT_FILE="$HOME/clawd/cortical-loop/state/current-wake-prompt.txt"
  echo "$WAKE_PROMPT" > "$PROMPT_FILE"
  
  # Increment wake count
  NEW_COUNT=$((WAKE_COUNT + 1))
  psql cortana -q -c "UPDATE cortana_chief_model SET value = jsonb_build_object('count', $NEW_COUNT, 'date', '$TODAY', 'max', $WAKE_MAX), updated_at = NOW() WHERE key = 'daily_wake_count';" 2>/dev/null
  
  # Log the wake
  psql cortana -q -c "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('cortical_wake', 'cortical_loop', 'info', 'LLM wake triggered', '{\"wake_number\": $NEW_COUNT}');" 2>/dev/null
  
  # Use openclaw cron wake to trigger main session
  openclaw cron wake --text "$WAKE_PROMPT" --mode now 2>/dev/null
fi

# ============================================================
# PROCESS FEEDBACK SIGNALS (runs every cycle, even without wake events)
# ============================================================
bash "$HOME/clawd/cortical-loop/feedback-handler.sh" 2>/dev/null
