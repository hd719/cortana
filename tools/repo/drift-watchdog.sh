#!/usr/bin/env bash
set -euo pipefail

SOURCE_REPO="${SOURCE_REPO:-/Users/hd/Developer/cortana}"
RUNTIME_REPO="${RUNTIME_REPO:-$SOURCE_REPO}"
MONITOR="${MONITOR:-$SOURCE_REPO/tools/monitoring/runtime-repo-drift-monitor.ts}"

if [[ ! -f "$MONITOR" ]]; then
  echo "[repo-drift-watchdog] monitor missing: $MONITOR" >&2
  exit 1
fi

output="$(npx --yes tsx "$MONITOR" --source-repo "$SOURCE_REPO" --runtime-repo "$RUNTIME_REPO")"

if [[ "$output" == "NO_REPLY" ]]; then
  exit 0
fi

echo "[repo-drift-watchdog] drift detected:"
echo "$output"

exit 1
