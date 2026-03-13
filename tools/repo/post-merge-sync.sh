#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bash "$ROOT/tools/repo/post-pr-cleanup.sh"
bash "$ROOT/tools/deploy/sync-runtime-from-cortana.sh" "$@"
