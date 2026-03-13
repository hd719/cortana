#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
exec npx --yes tsx "$ROOT_DIR/tools/heartbeat/validate-heartbeat-state.ts" "$@"
