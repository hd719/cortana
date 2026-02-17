#!/bin/bash
# Feedback Handler — processes reaction signals and maps them to wake rules
# Called by evaluator after event processing, or standalone
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:$PATH"

LOG="$HOME/clawd/cortical-loop/logs/feedback-handler.log"
log() { echo "$(TZ=America/New_York date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"; }

# ============================================================
# PART 1: Process unprocessed feedback signals
# ============================================================
SIGNALS=$(psql cortana -t -A -c "
  SELECT json_agg(s) FROM (
    SELECT id, signal_type, related_rule, weight_delta 
    FROM cortana_feedback_signals 
    WHERE processed = FALSE 
    ORDER BY timestamp ASC 
    LIMIT 20
  ) s;" 2>/dev/null)

if [ -z "$SIGNALS" ] || [ "$SIGNALS" = "null" ]; then
  exit 0
fi

# Process each signal
echo "$SIGNALS" | jq -c '.[]' 2>/dev/null | while read -r SIG; do
  SIG_ID=$(echo "$SIG" | jq -r '.id')
  SIG_TYPE=$(echo "$SIG" | jq -r '.signal_type')
  RULE_NAME=$(echo "$SIG" | jq -r '.related_rule // empty')
  DELTA=$(echo "$SIG" | jq -r '.weight_delta // 0')

  if [ -z "$RULE_NAME" ]; then
    # No rule to adjust, just mark processed
    psql cortana -q -c "UPDATE cortana_feedback_signals SET processed = TRUE WHERE id = $SIG_ID;" 2>/dev/null
    continue
  fi

  # Get current weight
  CURRENT_WEIGHT=$(psql cortana -t -A -c "SELECT weight FROM cortana_wake_rules WHERE name = '$RULE_NAME';" 2>/dev/null)
  if [ -z "$CURRENT_WEIGHT" ]; then
    log "WARN: Rule '$RULE_NAME' not found, skipping signal $SIG_ID"
    psql cortana -q -c "UPDATE cortana_feedback_signals SET processed = TRUE WHERE id = $SIG_ID;" 2>/dev/null
    continue
  fi

  # Calculate new weight with floor/ceiling
  NEW_WEIGHT=$(echo "$CURRENT_WEIGHT $DELTA" | awk '{
    w = $1 + $2;
    if (w < 0.1) w = 0.1;
    if (w > 2.0) w = 2.0;
    printf "%.2f", w;
  }')

  # Update feedback counters
  if [ "$SIG_TYPE" = "positive" ]; then
    FEEDBACK_COL="positive_feedback = positive_feedback + 1"
  elif [ "$SIG_TYPE" = "negative" ]; then
    FEEDBACK_COL="negative_feedback = negative_feedback + 1"
  else
    FEEDBACK_COL="trigger_count = trigger_count"  # no-op
  fi

  # Apply weight change
  psql cortana -q -c "UPDATE cortana_wake_rules SET weight = $NEW_WEIGHT, $FEEDBACK_COL WHERE name = '$RULE_NAME';" 2>/dev/null

  # Mark signal as processed
  psql cortana -q -c "UPDATE cortana_feedback_signals SET processed = TRUE WHERE id = $SIG_ID;" 2>/dev/null

  # Log the change
  psql cortana -q -c "INSERT INTO cortana_events (event_type, source, severity, message, metadata) 
    VALUES ('weight_change', 'feedback_handler', 'info', 
      'Rule \"$RULE_NAME\" weight: $CURRENT_WEIGHT → $NEW_WEIGHT ($SIG_TYPE)',
      '{\"rule\": \"$RULE_NAME\", \"old_weight\": $CURRENT_WEIGHT, \"new_weight\": $NEW_WEIGHT, \"delta\": $DELTA, \"signal_type\": \"$SIG_TYPE\"}');" 2>/dev/null

  log "Applied: $RULE_NAME $CURRENT_WEIGHT → $NEW_WEIGHT ($SIG_TYPE, delta=$DELTA)"
done

# ============================================================
# PART 2: Auto-suppress rules with 3+ consecutive negatives
# ============================================================
SUPPRESSED=$(psql cortana -t -A -c "
  SELECT name FROM cortana_wake_rules 
  WHERE negative_feedback >= 3 
    AND negative_feedback > positive_feedback 
    AND weight < 0.3 
    AND enabled = TRUE;" 2>/dev/null)

if [ -n "$SUPPRESSED" ]; then
  for RULE in $SUPPRESSED; do
    psql cortana -q -c "UPDATE cortana_wake_rules SET enabled = FALSE WHERE name = '$RULE';" 2>/dev/null
    psql cortana -q -c "INSERT INTO cortana_events (event_type, source, severity, message, metadata) 
      VALUES ('auto_suppress', 'feedback_handler', 'warning', 
        'Auto-suppressed rule \"$RULE\" — 3+ consecutive negatives',
        '{\"rule\": \"$RULE\"}');" 2>/dev/null
    log "AUTO-SUPPRESSED: $RULE (3+ negatives, weight < 0.3)"
    
    # Notify Hamel via wake
    openclaw cron wake --text "⚠️ Auto-suppressed wake rule \"$RULE\" — got 3+ negative reactions with weight below 0.3. Re-enable with: psql cortana -c \"UPDATE cortana_wake_rules SET enabled = TRUE, weight = 1.0, negative_feedback = 0 WHERE name = '$RULE';\"" --mode now 2>/dev/null
  done
fi
