#!/usr/bin/env bash
set -euo pipefail
assert_true(){ "$@" || { echo "ASSERT FAILED: $*"; exit 1; }; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/monitoring" "$TMP/home/.openclaw/cron/quarantine"
cp /Users/hd/clawd/tools/monitoring/quarantine-tracker.sh "$TMP/monitoring/quarantine-tracker.sh"
chmod +x "$TMP/monitoring/quarantine-tracker.sh"

cat > "$TMP/mock-psql" <<'PSQL'
#!/usr/bin/env bash
q="$*"
if [[ "$q" == *"SELECT id"*"cortana_tasks"* ]]; then
  [[ -f "${TASK_CREATED_FLAG}" ]] && echo 42 || echo ""
  exit 0
fi
if [[ "$q" == *"INSERT INTO cortana_tasks"* ]]; then touch "${TASK_CREATED_FLAG}"; exit 0; fi
if [[ "$q" == *"SELECT priority FROM cortana_tasks WHERE id = 77"* ]]; then
  [[ -f "${ESCALATED_FLAG}" ]] && echo 1 || echo 2
  exit 0
fi
if [[ "$q" == *"UPDATE cortana_tasks"*"id = 77"* ]]; then touch "${ESCALATED_FLAG}"; exit 0; fi
if [[ "$q" == *"SELECT COUNT(*)"* ]]; then echo 0; exit 0; fi
exit 0
PSQL
chmod +x "$TMP/mock-psql"
export TASK_CREATED_FLAG="$TMP/task.created"
export ESCALATED_FLAG="$TMP/task.escalated"

# >24h task creation
f1="$TMP/home/.openclaw/cron/quarantine/job1.quarantined"
touch "$f1" && touch -t "$(date -v-25H +%Y%m%d%H%M.%S)" "$f1"
HOME="$TMP/home" PSQL_BIN="$TMP/mock-psql" DB_NAME=test bash "$TMP/monitoring/quarantine-tracker.sh" > "$TMP/out1"
assert_true grep -q "total_quarantined=1" "$TMP/out1"
assert_true test -f "$TASK_CREATED_FLAG"

# >48h escalation
rm -f "$TMP/home/.openclaw/cron/quarantine"/*.quarantined
f2="$TMP/home/.openclaw/cron/quarantine/job2.quarantined"
touch "$f2" && touch -t "$(date -v-49H +%Y%m%d%H%M.%S)" "$f2"
cat > "$TMP/mock-psql" <<'PSQL2'
#!/usr/bin/env bash
q="$*"
if [[ "$q" == *"SELECT id"*"cortana_tasks"* ]]; then echo 77; exit 0; fi
if [[ "$q" == *"SELECT priority FROM cortana_tasks WHERE id = 77"* ]]; then
  [[ -f "${ESCALATED_FLAG}" ]] && echo 1 || echo 2
  exit 0
fi
if [[ "$q" == *"UPDATE cortana_tasks"*"id = 77"* ]]; then touch "${ESCALATED_FLAG}"; exit 0; fi
if [[ "$q" == *"SELECT COUNT(*)"* ]]; then echo 0; exit 0; fi
exit 0
PSQL2
chmod +x "$TMP/mock-psql"
HOME="$TMP/home" PSQL_BIN="$TMP/mock-psql" DB_NAME=test bash "$TMP/monitoring/quarantine-tracker.sh" > "$TMP/out2"
assert_true test -f "$ESCALATED_FLAG"
assert_true grep -q "escalated_tasks=1" "$TMP/out2"

echo "PASS: quarantine-tracker"
