#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: log-decision.sh <category> <priority> <summary> [details_json] [expires_minutes]" >&2
}

if [[ $# -lt 3 ]]; then
  usage
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec npx tsx "$SCRIPT_DIR/log-decision.ts" "$@"
