#!/usr/bin/env bash
set -euo pipefail

# Usage: resolve-approval.sh <approval_id> <action> [reason]
# action: approve | reject
# Updates mc_approval_requests status and inserts audit event

export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <approval_id> <action> [reason]" >&2
  exit 1
fi

approval_id="$1"
action="${2,,}"
reason="${3:-}"

is_uuid() {
  [[ "$1" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]
}

if ! [[ "$approval_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo "Error: approval_id must be a UUID" >&2
  exit 1
fi

case "$action" in
  approve)
    new_status="approved"
    event_type="approved"
    ;;
  reject)
    new_status="rejected"
    event_type="rejected"
    ;;
  *)
    echo "Error: action must be approve|reject" >&2
    exit 1
    ;;
esac

safe_reason="${reason//\'/\'\'}"

exists_count="$(psql cortana -t -A -c "SELECT COUNT(*) FROM mc_approval_requests WHERE id = '$approval_id'::uuid;")"
if [[ "$exists_count" != "1" ]]; then
  echo "Error: approval request not found: $approval_id" >&2
  exit 1
fi

psql cortana <<SQL >/dev/null
UPDATE mc_approval_requests
SET
  status = '$new_status',
  approved_at = CASE WHEN '$new_status' = 'approved' THEN NOW() ELSE approved_at END,
  rejected_at = CASE WHEN '$new_status' = 'rejected' THEN NOW() ELSE rejected_at END,
  approved_by = CASE WHEN '$new_status' = 'approved' THEN COALESCE(approved_by, 'user') ELSE approved_by END,
  rejected_by = CASE WHEN '$new_status' = 'rejected' THEN COALESCE(rejected_by, 'user') ELSE rejected_by END,
  decision = COALESCE(decision, '{}'::jsonb) || jsonb_build_object('action', '$action', 'reason', NULLIF('$safe_reason', ''))
WHERE id = '$approval_id'::uuid;

INSERT INTO mc_approval_events (approval_id, event_type, actor, payload)
VALUES (
  '$approval_id'::uuid,
  '$event_type',
  'user',
  jsonb_build_object('reason', NULLIF('$safe_reason', ''))
);
SQL

echo "OK $approval_id $new_status"
