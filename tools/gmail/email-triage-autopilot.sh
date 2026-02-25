#!/usr/bin/env bash
set -euo pipefail

# Email triage autopilot
# - Reads unread Gmail via gog
# - Classifies: urgent | action | read_later
# - Creates cortana_tasks for urgent/action emails
# - Emits Telegram digest text (optional send)

export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/local/bin:/usr/bin:/bin"

ACCOUNT="${GOG_ACCOUNT:-hameldesai3@gmail.com}"
DB="${CORTANA_DB:-cortana}"
MAX_EMAILS="${TRIAGE_MAX_EMAILS:-15}"
LOOKBACK_QUERY="${TRIAGE_QUERY:-is:unread newer_than:3d}"
SEND_TELEGRAM="${TRIAGE_SEND_TELEGRAM:-0}"   # 1=send via openclaw cron wake, 0=print only
RUN_INBOX_EXECUTION="${TRIAGE_RUN_INBOX_EXECUTION:-1}" # 1=run Python inbox->execution pipeline

sql_escape() {
  echo "$1" | sed "s/'/''/g"
}

json_escape() {
  python3 - <<'PY' "$1"
import json,sys
print(json.dumps(sys.argv[1]))
PY
}

RAW="$(gog --account "$ACCOUNT" gmail search "$LOOKBACK_QUERY" --max "$MAX_EMAILS" --json 2>/dev/null || echo '[]')"

if [[ -z "$RAW" || "$RAW" == "null" ]]; then
  RAW='[]'
fi

if ! echo "$RAW" | jq -e . >/dev/null 2>&1; then
  echo "email-triage: invalid gog json"
  exit 1
fi

# Normalize + classify. Heuristics intentionally simple/safe.
CLASSIFIED="$(echo "$RAW" | jq -c '
  def items:
    if type=="array" then .
    elif type=="object" and (.threads? | type)=="array" then .threads
    elif type=="object" and (.messages? | type)=="array" then .messages
    else [] end;

  [ items[] | {
      id: (.id // .messageId // .threadId // ""),
      threadId: (.threadId // .id // ""),
      from: (.from // .sender // "Unknown"),
      subject: (.subject // "(no subject)"),
      snippet: (.snippet // .preview // ""),
      date: (.date // .internalDate // null),
      gmailUrl: (.gmailUrl // (if (.id // .threadId // "") != "" then ("https://mail.google.com/mail/u/0/#inbox/" + ((.id // .threadId)|tostring)) else "" end))
    }
    | .text = ((.from + " " + .subject + " " + .snippet) | ascii_downcase)
    | .bucket = (
        if (.text | test("urgent|asap|immediately|today|deadline|payment due|security alert|account locked|interview|offer|expiring")) then "urgent"
        elif (.text | test("please review|action required|follow up|reply needed|todo|can you|need you|meeting request")) then "action"
        else "read_later" end
      )
    | del(.text)
  ]
')"

URGENT_COUNT="$(echo "$CLASSIFIED" | jq '[.[] | select(.bucket=="urgent")] | length')"
ACTION_COUNT="$(echo "$CLASSIFIED" | jq '[.[] | select(.bucket=="action")] | length')"
LATER_COUNT="$(echo "$CLASSIFIED" | jq '[.[] | select(.bucket=="read_later")] | length')"

CREATED=0
create_task_for_email() {
  local id="$1" from="$2" subject="$3" snippet="$4" bucket="$5" url="$6"

  # idempotency: avoid duplicate pending tasks for same gmail id
  local esc_id
  esc_id="$(sql_escape "$id")"
  local existing
  existing="$(psql "$DB" -t -A -c "SELECT id FROM cortana_tasks WHERE status IN ('pending','in_progress') AND metadata->>'gmail_id'='${esc_id}' LIMIT 1;" 2>/dev/null || true)"
  if [[ -n "${existing// /}" ]]; then
    return 0
  fi

  local prio
  if [[ "$bucket" == "urgent" ]]; then prio=1; else prio=2; fi

  local title="Email: ${subject}"
  local desc="From: ${from}\n\n${snippet}\n\nOpen: ${url}"

  local esc_title esc_desc esc_from esc_subject esc_snippet esc_url
  esc_title="$(sql_escape "$title")"
  esc_desc="$(sql_escape "$desc")"
  esc_from="$(sql_escape "$from")"
  esc_subject="$(sql_escape "$subject")"
  esc_snippet="$(sql_escape "$snippet")"
  esc_url="$(sql_escape "$url")"

  psql "$DB" -v ON_ERROR_STOP=1 -c "
    INSERT INTO cortana_tasks (title, description, priority, auto_executable, execution_plan, source, status, metadata)
    VALUES (
      '${esc_title}',
      '${esc_desc}',
      ${prio},
      FALSE,
      'Review and respond to this email manually. No auto-send.',
      'email-triage-autopilot',
      'pending',
      jsonb_build_object(
        'gmail_id','${esc_id}',
        'from','${esc_from}',
        'subject','${esc_subject}',
        'snippet','${esc_snippet}',
        'url','${esc_url}',
        'triage_bucket','${bucket}'
      )
    );" >/dev/null
  CREATED=$((CREATED+1))
}

while IFS= read -r row; do
  [[ -z "$row" ]] && continue
  bucket="$(echo "$row" | jq -r '.bucket')"
  if [[ "$bucket" == "urgent" || "$bucket" == "action" ]]; then
    create_task_for_email \
      "$(echo "$row" | jq -r '.id')" \
      "$(echo "$row" | jq -r '.from')" \
      "$(echo "$row" | jq -r '.subject')" \
      "$(echo "$row" | jq -r '.snippet')" \
      "$bucket" \
      "$(echo "$row" | jq -r '.gmailUrl')"
  fi
done < <(echo "$CLASSIFIED" | jq -c '.[]')

TOP_LINES="$(echo "$CLASSIFIED" | jq -r '
  [.[] | select(.bucket=="urgent" or .bucket=="action")][0:8]
  | to_entries
  | map("\(.key+1). [\(.value.bucket)] \(.value.subject) — \(.value.from)")
  | .[]?
')"

DIGEST="📧 Email Triage Digest\n\n• Unread scanned: $(echo "$CLASSIFIED" | jq 'length')\n• Urgent: ${URGENT_COUNT}\n• Action: ${ACTION_COUNT}\n• Read later: ${LATER_COUNT}\n• Tasks created: ${CREATED}\n"

if [[ -n "$TOP_LINES" ]]; then
  DIGEST+="\nTop urgent/action:\n${TOP_LINES}\n"
fi

DIGEST+="\n(Guardrail: no outbound email actions performed.)"

echo -e "$DIGEST"

if [[ "$RUN_INBOX_EXECUTION" == "1" && -f "tools/email/inbox_to_execution.py" ]]; then
  INBOX_JSON="$(python3 tools/email/inbox_to_execution.py --output-json 2>/dev/null || true)"
  if [[ -n "$INBOX_JSON" ]]; then
    ORPHAN_COUNT="$(echo "$INBOX_JSON" | jq -r '.stats.orphan // 0' 2>/dev/null || echo 0)"
    STALE_COUNT="$(echo "$INBOX_JSON" | jq -r '.stats.stale // 0' 2>/dev/null || echo 0)"
    DIGEST+="\n\nInbox→Execution:\n• Stale commitments: ${STALE_COUNT}\n• Orphan risk: ${ORPHAN_COUNT}"
    echo -e "\nInbox→Execution:\n• Stale commitments: ${STALE_COUNT}\n• Orphan risk: ${ORPHAN_COUNT}"
  fi
fi

if [[ "$SEND_TELEGRAM" == "1" ]]; then
  openclaw cron wake --mode now --text "$DIGEST" >/dev/null 2>&1 || true
fi
