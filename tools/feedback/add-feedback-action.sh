#!/usr/bin/env bash
set -euo pipefail

# Usage: add-feedback-action.sh <feedback_id> <action_type> <description> [action_ref] [status]
# Adds a remediation action to an mc_feedback_items entry

export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 <feedback_id> <action_type> <description> [action_ref] [status]" >&2
  exit 1
fi

feedback_id="$1"
action_type="$2"
description="$3"
action_ref="${4:-}"
status="${5:-planned}"

is_uuid() {
  [[ "$1" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]
}

if ! is_uuid "$feedback_id"; then
  echo "Error: feedback_id must be a UUID" >&2
  exit 1
fi

safe_action_type="${action_type//\'/\'\'}"
safe_description="${description//\'/\'\'}"
safe_action_ref="${action_ref//\'/\'\'}"

if [[ -n "$action_ref" ]]; then
  action_ref_sql="'${safe_action_ref}'"
else
  action_ref_sql="NULL"
fi

psql cortana <<SQL >/dev/null
INSERT INTO mc_feedback_actions (feedback_id, action_type, action_ref, description, status)
VALUES (
  '$feedback_id'::uuid,
  '$safe_action_type',
  $action_ref_sql,
  '$safe_description',
  '$status'
);
SQL

echo "Added action '$action_type' to feedback $feedback_id"
