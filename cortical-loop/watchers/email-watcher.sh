#!/bin/bash
# Polls for new unread emails, inserts events for new ones
# Runs every 2 min via launchd
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:$PATH"

LAST_FILE="$HOME/clawd/cortical-loop/state/email-last-ids.txt"
mkdir -p "$(dirname "$LAST_FILE")"
touch "$LAST_FILE"

# Get current unread
UNREAD=$(gog --account hameldesai3@gmail.com gmail search 'is:unread' --max 10 --json 2>/dev/null)
if [ $? -ne 0 ] || [ -z "$UNREAD" ]; then exit 0; fi

# Extract message IDs
CURRENT_IDS=$(echo "$UNREAD" | jq -r '.[].id // empty' 2>/dev/null | sort)
if [ -z "$CURRENT_IDS" ]; then exit 0; fi

# Diff against last known
NEW_IDS=$(comm -23 <(echo "$CURRENT_IDS") <(sort "$LAST_FILE"))
if [ -z "$NEW_IDS" ]; then exit 0; fi

# Insert events for new emails
while IFS= read -r ID; do
  SUBJECT=$(echo "$UNREAD" | jq -r --arg id "$ID" '.[] | select(.id == $id) | .subject // "unknown"' 2>/dev/null | head -c 200)
  FROM=$(echo "$UNREAD" | jq -r --arg id "$ID" '.[] | select(.id == $id) | .from // "unknown"' 2>/dev/null | head -c 100)
  LABELS=$(echo "$UNREAD" | jq -c --arg id "$ID" '.[] | select(.id == $id) | .labelIds // []' 2>/dev/null)
  
  PAYLOAD=$(jq -n --arg id "$ID" --arg subj "$SUBJECT" --arg from "$FROM" --argjson labels "${LABELS:-[]}" \
    '{message_id: $id, subject: $subj, from: $from, labels: $labels}')
  
  psql cortana -q -c "INSERT INTO cortana_event_stream (source, event_type, payload) VALUES ('email', 'new_unread', '$PAYLOAD'::jsonb);" 2>/dev/null
done <<< "$NEW_IDS"

# Update state
echo "$CURRENT_IDS" > "$LAST_FILE"
