#!/usr/bin/env bash
set -euo pipefail
assert_true(){ "$@" || { echo "ASSERT FAILED: $*"; exit 1; }; }

if ! command -v psql >/dev/null 2>&1; then
  echo "SKIPPED: psql not available"
  exit 0
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/feedback" "$TMP/mockbin"
cp /Users/hd/clawd/tools/feedback/pipeline-reconciliation.sh "$TMP/feedback/"
chmod +x "$TMP/feedback/pipeline-reconciliation.sh"

cat > "$TMP/mockbin/psql" <<'PSQL'
#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"SELECT COUNT(*) FROM cortana_feedback;"* ]]; then echo 10; exit 0; fi
if [[ "$args" == *"SELECT COUNT(*) FROM mc_feedback_items;"* ]]; then echo 8; exit 0; fi
if [[ "$args" == *"source = 'feedback_loop'"* ]]; then echo 1; exit 0; fi
if [[ "$args" == *"source = 'feedback';"* ]]; then echo 3; exit 0; fi
if [[ "$args" == *"lag_count"* || "$args" == *"missing in mc_feedback_items"* ]]; then echo 2; exit 0; fi
if [[ "$args" == *"m.created_at < NOW() - INTERVAL '24 hours'"*"COUNT(*)"* ]]; then echo 4; exit 0; fi
if [[ "$args" == *"feedback_ts_et"* ]]; then echo -e "1\t2026-01-01 00:00:00\tctx"; exit 0; fi
if [[ "$args" == *"linked_task_id"* ]]; then echo -e "9\t2026-01-01 00:00:00\topen\t\tsum\t"; exit 0; fi
if [[ "$args" == *"INSERT INTO cortana_events"* ]]; then echo "$args" >> "${PSQL_LOG}"; exit 0; fi
echo 0
PSQL
chmod +x "$TMP/mockbin/psql"
export PSQL_LOG="$TMP/sql.log"

out="$(PATH="$TMP/mockbin:$PATH" DB_NAME=test bash "$TMP/feedback/pipeline-reconciliation.sh")"
assert_true echo "$out" | grep -q "cortana_feedback: 10"
assert_true echo "$out" | grep -q "Stuck >24h"
assert_true grep -q "feedback_pipeline_reconciliation" "$TMP/sql.log"

echo "PASS: pipeline-reconciliation"
