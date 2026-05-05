#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bash "$ROOT/tools/repo/post-pr-cleanup.sh"
bash "$ROOT/tools/deploy/sync-runtime-from-cortana.sh" "$@"
npx tsx "$ROOT/tools/monitoring/cron-state-reconciler.ts" --dry-run --json --write-report >/tmp/cortana-cron-state-reconciler-post-merge.json || true
bash "$ROOT/tools/openclaw/sync-memory-wiki-if-needed.sh" --repo-root "$ROOT"
