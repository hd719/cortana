#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
pass=0
fail=0
skip=0

run_case() {
  local name="$1"; shift
  echo "\n==> $name"
  set +e
  out="$($@ 2>&1)"
  rc=$?
  set -e
  echo "$out"

  if [[ "$out" == SKIPPED* || "$out" == *"SKIPPED:"* ]]; then
    skip=$((skip+1))
    return 0
  fi

  if [[ $rc -eq 0 ]]; then
    pass=$((pass+1))
  else
    fail=$((fail+1))
  fi
}

if python3 -c 'import pytest' >/dev/null 2>&1; then
  run_case "test_vector_health_gate.py" python3 -m pytest -q "$ROOT/test_vector_health_gate.py"
  run_case "test_safe_memory_search.py" python3 -m pytest -q "$ROOT/test_safe_memory_search.py"
else
  echo "SKIPPED: pytest unavailable (python tests skipped)"
  skip=$((skip+2))
fi

for t in \
  test_compact_memory.sh \
  test_rotate_artifacts.sh \
  test_meta_monitor.sh \
  test_quarantine_tracker.sh \
  test_idempotency.sh \
  test_heartbeat_validation.sh \
  test_pipeline_reconciliation.sh \
  test_alert_intent.sh \
  test_emit_run_event.sh; do
  run_case "$t" bash "$ROOT/$t"
done

echo "\nSUMMARY: pass=$pass fail=$fail skipped=$skip"
[[ $fail -eq 0 ]]
