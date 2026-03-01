#!/usr/bin/env bash
# Wrapper: calls the TypeScript post-update script via npx tsx
set -euo pipefail
exec npx tsx "$(dirname "$0")/post-update.ts" "$@"
