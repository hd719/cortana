#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

tracked_artifacts="$(
  git ls-files \
    | rg '(^\.openclaw-repair/|^tmp-|^DREAMS\.md$|^identities/[^/]+/DREAMS\.md$|^memory/\.dreams/|^memory/dreaming/|^memory/archive/|^memory/[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$|^memory/.*-sent\.json$|^memory/(circuit-breaker-state|cron-health-48h.*|newsletter-alerted|x-trending-seen)\.json$)' \
    || true
)"

if [[ -n "$tracked_artifacts" ]]; then
  cat >&2 <<'EOF'
Tracked runtime artifacts detected. These files are generated runtime state and
should not be committed. Remove them from git tracking or promote a distilled
version into docs/MEMORY.md instead.

EOF
  printf '%s\n' "$tracked_artifacts" >&2
  exit 1
fi

echo "No tracked runtime artifacts detected."
