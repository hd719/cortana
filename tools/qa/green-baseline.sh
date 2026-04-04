#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

overall_ok=true

print_header() {
  printf '\n== %s ==\n' "$1"
}

mark_fail() {
  overall_ok=false
}

run_cmd() {
  local label="$1"
  shift
  print_header "$label"
  if ! "$@"; then
    mark_fail
    return 1
  fi
}

print_header "Config"
if openclaw config validate; then
  printf 'status=ok\n'
else
  printf 'status=fail\n'
  mark_fail
fi

print_header "Gateway Service"
if openclaw gateway status --no-probe; then
  printf 'status=ok\n'
else
  printf 'status=fail\n'
  mark_fail
fi

print_header "Gateway Reachability"
gateway_reachable="$(
  openclaw status --json 2>/tmp/green-baseline-openclaw-status.err \
    | python3 -c 'import json,sys; print("true" if json.load(sys.stdin).get("gateway", {}).get("reachable") else "false")' \
    || true
)"
if [[ "$gateway_reachable" == "true" ]]; then
  printf 'gateway.reachable=true\n'
else
  cat /tmp/green-baseline-openclaw-status.err 2>/dev/null || true
  printf 'gateway.reachable=false\n'
  mark_fail
fi

print_header "Cron Errors"
cron_bad="$(
  python3 - <<'PY'
import json, os
p = os.path.expanduser("~/.openclaw/cron/jobs.json")
with open(p) as f:
    data = json.load(f)
bad = []
for j in data.get("jobs", []):
    st = j.get("state", {})
    if st.get("lastStatus") == "error" or (st.get("consecutiveErrors") or 0) > 0:
        bad.append({
            "name": j.get("name") or j.get("label"),
            "agentId": j.get("agentId"),
            "consecutiveErrors": st.get("consecutiveErrors"),
            "lastError": st.get("lastError"),
        })
print(json.dumps(bad, indent=2))
PY
)"
printf '%s\n' "$cron_bad"
if [[ "$cron_bad" != "[]" ]]; then
  mark_fail
fi

print_header "Synthetic Probe"
probe_out="$(npx tsx tools/monitoring/critical-synthetic-probe.ts 2>&1 || true)"
printf '%s\n' "$probe_out"
if [[ "$probe_out" != "NO_REPLY" ]]; then
  mark_fail
fi

print_header "Runtime Integrity"
integrity_out="$(npx tsx tools/openclaw/runtime-integrity-check.ts --json 2>&1 || true)"
printf '%s\n' "$integrity_out"
if ! printf '%s' "$integrity_out" | python3 -c 'import json,sys; print("true" if json.load(sys.stdin).get("overall_ok") else "false")' | grep -qx 'true'; then
  mark_fail
fi

print_header "Validate System"
validate_out="$(npx tsx tools/qa/validate-system.ts --json 2>&1 || true)"
printf '%s\n' "$validate_out"
if ! printf '%s' "$validate_out" | python3 -c 'import json,sys; print("true" if json.load(sys.stdin).get("summary",{}).get("overall_ok") else "false")' | grep -qx 'true'; then
  mark_fail
fi

print_header "Git"
git_status="$(git status --short)"
if [[ -z "$git_status" ]]; then
  printf 'clean\n'
else
  printf '%s\n' "$git_status"
  mark_fail
fi

print_header "Summary"
if [[ "$overall_ok" == true ]]; then
  printf 'GREEN_BASELINE=ok\n'
else
  printf 'GREEN_BASELINE=fail\n'
  exit 1
fi
