#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROMPT_FILE="${ROOT_DIR}/config/researcher/default-prompt.md"
SESSION_ID="researcher-persistent-v1"
DRY_RUN=0
EXTRA_MESSAGE=""
THINKING="low"

usage() {
  cat <<'EOF'
Usage: tools/researcher/start-researcher.sh [options]

Spawn or refresh the dedicated Researcher agent session with the default prompt.

Options:
  --dry-run                 Print the command without executing it
  --session-id <id>         Session id for persistence (default: researcher-persistent-v1)
  --prompt-file <path>      Prompt template file (default: config/researcher/default-prompt.md)
  --message <text>          Optional extra instruction appended to prompt
  --thinking <level>        off|minimal|low|medium|high (default: low)
  -h, --help                Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --session-id) SESSION_ID="$2"; shift 2 ;;
    --prompt-file) PROMPT_FILE="$2"; shift 2 ;;
    --message) EXTRA_MESSAGE="$2"; shift 2 ;;
    --thinking) THINKING="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if ! command -v openclaw >/dev/null 2>&1; then
  echo "openclaw CLI not found in PATH" >&2
  exit 1
fi

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

BOOTSTRAP_MESSAGE="$(cat "$PROMPT_FILE")"
if [[ -n "$EXTRA_MESSAGE" ]]; then
  BOOTSTRAP_MESSAGE+=$'\n\n## Task for this run\n'
  BOOTSTRAP_MESSAGE+="$EXTRA_MESSAGE"
fi

CMD=(
  openclaw agent
  --agent researcher
  --session-id "$SESSION_ID"
  --thinking "$THINKING"
  --message "$BOOTSTRAP_MESSAGE"
  --json
)

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf 'DRY RUN: '
  printf '%q ' "${CMD[@]}"
  echo
  exit 0
fi

"${CMD[@]}"
