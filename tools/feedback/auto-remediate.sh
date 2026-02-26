#!/usr/bin/env bash
set -euo pipefail

# Scans mc_feedback_items for status='new', auto-triages based on category/severity,
# and creates remediation actions for known patterns.
#
# Run during heartbeat reflection sweep.

export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

result="$(psql cortana -t -A -F $'\t' -c "SELECT id::text, category, severity FROM mc_feedback_items WHERE status='new' ORDER BY created_at ASC;")"

if [[ -z "$result" ]]; then
  echo "Auto-remediation summary:"
  echo "- New feedback items scanned: 0"
  echo "- Items triaged: 0"
  echo "- Actions created: 0"
  exit 0
fi

scanned=0
triaged=0
actions=0

while IFS=$'\t' read -r feedback_id category severity; do
  [[ -z "${feedback_id:-}" ]] && continue
  scanned=$((scanned + 1))

  action_type=""
  case "$category:$severity" in
    correction:high|correction:critical)
      action_type="policy_rule"
      ;;
    correction:medium)
      action_type="prompt_patch"
      ;;
    preference:*)
      action_type="prompt_patch"
      ;;
    *)
      ;;
  esac

  if [[ -n "$action_type" ]]; then
    safe_category="${category//\'/\'\'}"
    safe_severity="${severity//\'/\'\'}"

    psql cortana <<SQL >/dev/null
UPDATE mc_feedback_items
SET status = 'triaged', updated_at = NOW()
WHERE id = '$feedback_id'::uuid;

INSERT INTO mc_feedback_actions (feedback_id, action_type, description, status)
VALUES (
  '$feedback_id'::uuid,
  '$action_type',
  'Auto-remediation for ${safe_category}/${safe_severity}',
  'planned'
);
SQL
    triaged=$((triaged + 1))
    actions=$((actions + 1))
  fi
done <<< "$result"

echo "Auto-remediation summary:"
echo "- New feedback items scanned: $scanned"
echo "- Items triaged: $triaged"
echo "- Actions created: $actions"
