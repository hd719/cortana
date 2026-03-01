#!/usr/bin/env bash
set -u

TEST_CMD=(npx tsx ~/openclaw/tools/tests/integration-tests.ts)
PSQL_BIN="/opt/homebrew/opt/postgresql@17/bin/psql"
DB_NAME="cortana"

OUTPUT="$(${TEST_CMD[@]} 2>&1)"
TEST_EXIT=$?

echo "$OUTPUT"

if echo "$OUTPUT" | grep -q "|fail|" || [ "$TEST_EXIT" -ne 0 ]; then
  EVENT_TYPE="integration_test_failure"
  SEVERITY="warning"
  MESSAGE="Integration tests reported failures"
else
  EVENT_TYPE="integration_test_pass"
  SEVERITY="info"
  MESSAGE="Integration tests passed"
fi

if [ -x "$PSQL_BIN" ]; then
  ESCAPED_MESSAGE=$(printf "%s" "$MESSAGE" | sed "s/'/''/g")
  SQL="INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('${EVENT_TYPE}', 'integration-tests', '${SEVERITY}', '${ESCAPED_MESSAGE}', jsonb_build_object('exit_code', ${TEST_EXIT}));"
  "$PSQL_BIN" "$DB_NAME" -q -X -v ON_ERROR_STOP=1 -c "$SQL" >/dev/null 2>&1 || true
fi

echo "To schedule as a cron: add to ~/.openclaw/cron/jobs.json with schedule '0 8 * * *' (daily 8 AM)"
exit 0
