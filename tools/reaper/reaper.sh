#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Validate heartbeat state before reaper mutates runs.
"/Users/hd/openclaw/tools/heartbeat/validate-heartbeat-state.sh" >/dev/null 2>&1 || true

python3 "$SCRIPT_DIR/reaper.py" "$@"
