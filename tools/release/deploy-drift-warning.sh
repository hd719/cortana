#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WATCHDOG="$ROOT_DIR/tools/repo/drift-watchdog.sh"

if [[ ! -x "$WATCHDOG" ]]; then
  echo "[deploy-drift-warning] watchdog missing: $WATCHDOG" >&2
  exit 0
fi

if "$WATCHDOG" >/tmp/deploy_drift_watchdog.out 2>/tmp/deploy_drift_watchdog.err; then
  echo "[deploy-drift-warning] source and runtime repos are in sync"
  exit 0
fi

echo "⚠️ DEPLOY WARNING: source/runtime drift detected"
cat /tmp/deploy_drift_watchdog.out 2>/dev/null || true
cat /tmp/deploy_drift_watchdog.err 2>/dev/null || true

echo "Hint: run /Users/hd/Developer/cortana/tools/deploy/sync-runtime-from-cortana.sh before deploy/restart."
exit 0
