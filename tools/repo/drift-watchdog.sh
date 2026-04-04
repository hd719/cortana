#!/usr/bin/env bash
set -euo pipefail

DEFAULT_SOURCE_REPO="/Users/hd/Developer/cortana"
if [[ -d "/Users/hd/Developer/cortana-deploy/.git" ]]; then
  DEFAULT_SOURCE_REPO="/Users/hd/Developer/cortana-deploy"
fi

SOURCE_REPO="${SOURCE_REPO:-$DEFAULT_SOURCE_REPO}"
DEFAULT_RUNTIME_REPO="/Users/hd/openclaw"
if [[ ! -e "$DEFAULT_RUNTIME_REPO" && ! -L "$DEFAULT_RUNTIME_REPO" ]]; then
  DEFAULT_RUNTIME_REPO="$SOURCE_REPO"
fi

RUNTIME_REPO="${RUNTIME_REPO:-$DEFAULT_RUNTIME_REPO}"
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
