#!/bin/bash
# Learning Loop — daily correction-to-behavior pipeline
# Runs once daily at 11 PM ET via LaunchAgent
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:$PATH"

LOG="$HOME/clawd/cortical-loop/logs/learning-loop.log"
log() { echo "$(TZ=America/New_York date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"; }

log "=== Learning Loop starting ==="

# ============================================================
# 1. Process unapplied feedback entries
# ============================================================
UNAPPLIED=$(psql cortana -t -A -c "
  SELECT id, feedback_type, context, lesson 
  FROM cortana_feedback 
  WHERE applied = FALSE 
  ORDER BY timestamp ASC;" 2>/dev/null)

if [ -n "$UNAPPLIED" ]; then
  echo "$UNAPPLIED" | while IFS='|' read -r FB_ID FB_TYPE FB_CTX FB_LESSON; do
    [ -z "$FB_ID" ] && continue
    
    log "Processing feedback #$FB_ID: type=$FB_TYPE lesson=$FB_LESSON"
    
    # Check if it maps to a wake rule (search for rule names in context/lesson)
    MATCHING_RULE=$(psql cortana -t -A -c "
      SELECT name FROM cortana_wake_rules 
      WHERE '$(echo "$FB_CTX $FB_LESSON" | sed "s/'/''/g")' ILIKE '%' || name || '%'
      LIMIT 1;" 2>/dev/null)
    
    if [ -n "$MATCHING_RULE" ]; then
      # Adjust wake rule weight
      psql cortana -q -c "INSERT INTO cortana_feedback_signals 
        (signal_type, source, related_rule, weight_delta, context) 
        VALUES ('negative', 'learning_loop', '$(echo $MATCHING_RULE | tr -d " ")', -0.15, 'From feedback #$FB_ID: $FB_LESSON');" 2>/dev/null
      log "  → Mapped to wake rule: $MATCHING_RULE (delta=-0.15)"
    fi
    
    # Mark as applied
    psql cortana -q -c "UPDATE cortana_feedback SET applied = TRUE WHERE id = $FB_ID;" 2>/dev/null
  done
fi

# ============================================================
# 2. Check for repeated patterns (same lesson 3+ times in 30 days)
# ============================================================
REPEATS=$(psql cortana -t -A -c "
  SELECT feedback_type, lesson, COUNT(*) as cnt
  FROM cortana_feedback 
  WHERE timestamp > NOW() - INTERVAL '30 days'
  GROUP BY feedback_type, lesson 
  HAVING COUNT(*) >= 3
  ORDER BY cnt DESC;" 2>/dev/null)

if [ -n "$REPEATS" ]; then
  log "REPEATED PATTERNS DETECTED:"
  echo "$REPEATS" | while IFS='|' read -r R_TYPE R_LESSON R_COUNT; do
    [ -z "$R_TYPE" ] && continue
    log "  ⚠️  [$R_TYPE] x$R_COUNT: $R_LESSON"
    
    # Log escalation event
    psql cortana -q -c "INSERT INTO cortana_events (event_type, source, severity, message, metadata)
      VALUES ('learning_escalation', 'learning_loop', 'warning', 
        'Lesson repeated ${R_COUNT}x in 30 days — not sticking: $(echo "$R_LESSON" | sed "s/'/''/g")',
        '{\"feedback_type\": \"$R_TYPE\", \"count\": $R_COUNT}');" 2>/dev/null
  done
  
  # Alert Hamel about repeated lessons
  REPEAT_SUMMARY=$(echo "$REPEATS" | while IFS='|' read -r R_TYPE R_LESSON R_COUNT; do
    [ -z "$R_TYPE" ] && continue
    echo "• [$R_TYPE] x$R_COUNT: $R_LESSON"
  done)
  
  if [ -n "$REPEAT_SUMMARY" ]; then
    openclaw cron wake --text "🔄 Learning Loop — lessons that aren't sticking (3+ repeats in 30 days):
$REPEAT_SUMMARY

These need stronger reinforcement. Should I add them to SOUL.md or strengthen the rules?" --mode now 2>/dev/null
  fi
fi

# ============================================================
# 3. Weight decay for rules with no engagement
# ============================================================
# Rules triggered in the last day with no feedback signals get slight decay
DECAYABLE=$(psql cortana -t -A -c "
  SELECT wr.name, wr.weight 
  FROM cortana_wake_rules wr 
  WHERE wr.last_triggered > NOW() - INTERVAL '24 hours'
    AND wr.enabled = TRUE
    AND wr.weight > 0.1
    AND NOT EXISTS (
      SELECT 1 FROM cortana_feedback_signals fs 
      WHERE fs.related_rule = wr.name 
        AND fs.timestamp > wr.last_triggered
    );" 2>/dev/null)

if [ -n "$DECAYABLE" ]; then
  echo "$DECAYABLE" | while IFS='|' read -r D_NAME D_WEIGHT; do
    [ -z "$D_NAME" ] && continue
    NEW_W=$(echo "$D_WEIGHT" | awk '{w=$1-0.02; if(w<0.1) w=0.1; printf "%.2f", w}')
    if [ "$NEW_W" != "$D_WEIGHT" ]; then
      psql cortana -q -c "UPDATE cortana_wake_rules SET weight = $NEW_W WHERE name = '$D_NAME';" 2>/dev/null
      log "  Decay: $D_NAME $D_WEIGHT → $NEW_W (no engagement)"
    fi
  done
fi

# ============================================================
# 4. Reflection sweep (task reflections + rule extraction + policy updates)
# ============================================================
if [ -x "$HOME/clawd/tools/reflection/reflect.py" ]; then
  REFLECTION_OUT=$(python3 "$HOME/clawd/tools/reflection/reflect.py" --mode sweep --trigger-source cron --window-days 30 2>&1)
  if [ $? -eq 0 ]; then
    log "Reflection sweep completed: $REFLECTION_OUT"
  else
    log "Reflection sweep failed: $REFLECTION_OUT"
  fi
else
  log "Reflection sweep skipped: tools/reflection/reflect.py not executable"
fi

log "=== Learning Loop complete ==="
