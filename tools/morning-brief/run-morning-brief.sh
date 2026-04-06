#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="/Users/hd/Developer/cortana"
cd "$REPO_ROOT"

exec npx tsx "$REPO_ROOT/tools/morning-brief/orchestrate-brief.ts" "$@"
