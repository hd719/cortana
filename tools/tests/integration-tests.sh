#!/usr/bin/env bash
set -uo pipefail

PSQL_BIN="/opt/homebrew/opt/postgresql@17/bin/psql"
DB_NAME="cortana"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

STATE_ENFORCER="$ROOT_DIR/tools/task-board/state-enforcer.sh"
STALE_DETECTOR="$ROOT_DIR/tools/task-board/stale-detector.sh"
COST_BREAKER="$ROOT_DIR/tools/alerting/cost-breaker.sh"
CRON_PREFLIGHT="$ROOT_DIR/tools/alerting/cron-preflight.sh"
OAUTH_REFRESH="$ROOT_DIR/tools/gog/oauth-refresh.sh"
META_MONITOR="$ROOT_DIR/tools/meta-monitor/meta-monitor.sh"
SELF_DIAG="$ROOT_DIR/tools/self-diagnostic/self-diagnostic.sh"

REPORT_ROWS=()
ANY_FAIL=0
TEST_TASK_IDS=()

now_ms() {
  python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
}

json_ok() {
  local payload="$1"
  printf '%s' "$payload" | jq -e . >/dev/null 2>&1
}

check_deps() {
  local missing=0
  for bin in "$PSQL_BIN" jq python3 timeout; do
    if ! command -v "$bin" >/dev/null 2>&1 && [[ ! -x "$bin" ]]; then
      echo "Missing dependency: $bin" >&2
      missing=1
    fi
  done
  return $missing
}

create_test_task() {
  local title="$1"
  local id
  id="$($PSQL_BIN "$DB_NAME" -X -q -t -A -v ON_ERROR_STOP=1 <<SQL
INSERT INTO cortana_tasks (source, title, description, priority, status, auto_executable, metadata)
VALUES (
  'integration-tests',
  '$title',
  'Temporary task created by tools/tests/integration-tests.sh',
  5,
  'ready',
  false,
  jsonb_build_object('integration_test', true, 'created_at', NOW())
)
RETURNING id;
SQL
)" || return 1
  id="$(echo "$id" | tr -d '[:space:]')"
  TEST_TASK_IDS+=("$id")
  echo "$id"
}

cleanup_test_tasks() {
  if [[ ${#TEST_TASK_IDS[@]} -eq 0 ]]; then
    return 0
  fi

  local csv
  csv="$(IFS=,; echo "${TEST_TASK_IDS[*]}")"

  "$PSQL_BIN" "$DB_NAME" -X -q -v ON_ERROR_STOP=1 <<SQL >/dev/null 2>&1 || true
DELETE FROM cortana_tasks WHERE id IN ($csv);
SQL
}

record_result() {
  local tool="$1" status="$2" runtime_ms="$3" error="$4"
  REPORT_ROWS+=("$tool|$status|$runtime_ms|$error")
  if [[ "$status" == "fail" ]]; then
    ANY_FAIL=1
  fi
}

run_json_test() {
  local name="$1"
  local cmd="$2"
  local start end runtime rc output

  start="$(now_ms)"
  set +e
  output="$(eval "$cmd" 2>&1)"
  rc=$?
  set -e
  end="$(now_ms)"
  runtime=$((end - start))

  if [[ $rc -ne 0 ]]; then
    record_result "$name" "fail" "$runtime" "exit_code=$rc output=$(echo "$output" | tr '\n' ' ' | cut -c1-300)"
    return
  fi

  if ! json_ok "$output"; then
    record_result "$name" "fail" "$runtime" "invalid_json output=$(echo "$output" | tr '\n' ' ' | cut -c1-300)"
    return
  fi

  record_result "$name" "pass" "$runtime" ""
}

run_text_test() {
  local name="$1"
  local cmd="$2"
  local expect_substr="$3"
  local start end runtime rc output

  start="$(now_ms)"
  set +e
  output="$(eval "$cmd" 2>&1)"
  rc=$?
  set -e
  end="$(now_ms)"
  runtime=$((end - start))

  if [[ $rc -ne 0 ]]; then
    record_result "$name" "fail" "$runtime" "exit_code=$rc output=$(echo "$output" | tr '\n' ' ' | cut -c1-300)"
    return
  fi

  if [[ -n "$expect_substr" ]] && [[ "$output" != *"$expect_substr"* ]]; then
    record_result "$name" "fail" "$runtime" "missing_expected_substring='$expect_substr' output=$(echo "$output" | tr '\n' ' ' | cut -c1-300)"
    return
  fi

  record_result "$name" "pass" "$runtime" ""
}

test_state_enforcer_transitions() {
  local spawn_task complete_task fail_task
  local output rc start end runtime

  start="$(now_ms)"

  spawn_task="$(create_test_task "IT spawn-start $(date +%s)")" || {
    end="$(now_ms)"; runtime=$((end - start));
    record_result "tools/task-board/state-enforcer.sh:spawn-start" "fail" "$runtime" "failed_to_create_test_task"
    return
  }

  complete_task="$(create_test_task "IT complete $(date +%s)")" || {
    end="$(now_ms)"; runtime=$((end - start));
    record_result "tools/task-board/state-enforcer.sh:complete" "fail" "$runtime" "failed_to_create_test_task"
    return
  }

  fail_task="$(create_test_task "IT fail $(date +%s)")" || {
    end="$(now_ms)"; runtime=$((end - start));
    record_result "tools/task-board/state-enforcer.sh:fail" "fail" "$runtime" "failed_to_create_test_task"
    return
  }

  set +e
  output="$($STATE_ENFORCER spawn-start "$spawn_task" "integration-test-agent" 2>&1)"
  rc=$?
  set -e
  if [[ $rc -ne 0 ]] || ! json_ok "$output" || [[ "$(printf '%s' "$output" | jq -r '.ok // false')" != "true" ]]; then
    end="$(now_ms)"; runtime=$((end - start));
    record_result "tools/task-board/state-enforcer.sh:spawn-start" "fail" "$runtime" "output=$(echo "$output" | tr '\n' ' ' | cut -c1-300)"
  else
    end="$(now_ms)"; runtime=$((end - start));
    record_result "tools/task-board/state-enforcer.sh:spawn-start" "pass" "$runtime" ""
  fi

  # complete path: must be in_progress first
  run_text_test "tools/task-board/state-enforcer.sh:prep-complete" "\"$STATE_ENFORCER\" spawn-start \"$complete_task\" \"integration-test-agent\" >/dev/null" ""

  start="$(now_ms)"
  set +e
  output="$($STATE_ENFORCER complete "$complete_task" "integration test complete" 2>&1)"
  rc=$?
  set -e
  end="$(now_ms)"; runtime=$((end - start))
  if [[ $rc -ne 0 ]] || ! json_ok "$output" || [[ "$(printf '%s' "$output" | jq -r '.ok // false')" != "true" ]]; then
    record_result "tools/task-board/state-enforcer.sh:complete" "fail" "$runtime" "output=$(echo "$output" | tr '\n' ' ' | cut -c1-300)"
  else
    record_result "tools/task-board/state-enforcer.sh:complete" "pass" "$runtime" ""
  fi

  # fail path: must be in_progress first
  run_text_test "tools/task-board/state-enforcer.sh:prep-fail" "\"$STATE_ENFORCER\" spawn-start \"$fail_task\" \"integration-test-agent\" >/dev/null" ""

  start="$(now_ms)"
  set +e
  output="$($STATE_ENFORCER fail "$fail_task" "integration test fail" 2>&1)"
  rc=$?
  set -e
  end="$(now_ms)"; runtime=$((end - start))
  if [[ $rc -ne 0 ]] || ! json_ok "$output" || [[ "$(printf '%s' "$output" | jq -r '.ok // false')" != "true" ]]; then
    record_result "tools/task-board/state-enforcer.sh:fail" "fail" "$runtime" "output=$(echo "$output" | tr '\n' ' ' | cut -c1-300)"
  else
    record_result "tools/task-board/state-enforcer.sh:fail" "pass" "$runtime" ""
  fi
}

print_report() {
  echo "tool|status|runtime_ms|error"
  local row
  for row in "${REPORT_ROWS[@]}"; do
    echo "$row"
  done
}

main() {
  if ! check_deps; then
    echo "Dependency check failed" >&2
    exit 1
  fi

  trap cleanup_test_tasks EXIT

  test_state_enforcer_transitions
  run_json_test "tools/task-board/stale-detector.sh" "\"$STALE_DETECTOR\" run"
  run_json_test "tools/alerting/cost-breaker.sh" "\"$COST_BREAKER\""
  run_text_test "tools/alerting/cron-preflight.sh" "\"$CRON_PREFLIGHT\" integration-tests pg" "preflight"
  run_text_test "tools/gog/oauth-refresh.sh" "\"$OAUTH_REFRESH\"" "gog oauth"
  run_json_test "tools/meta-monitor/meta-monitor.sh" "\"$META_MONITOR\" --json"
  run_text_test "tools/self-diagnostic/self-diagnostic.sh" "\"$SELF_DIAG\" --brief" "overall="

  print_report

  if [[ $ANY_FAIL -eq 1 ]]; then
    exit 1
  fi
  exit 0
}

main "$@"
