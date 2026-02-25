#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREDICTIVE_SCRIPT="$ROOT_DIR/tools/memory/predictive-context.sh"

if [[ ! -x "$PREDICTIVE_SCRIPT" ]]; then
  chmod +x "$PREDICTIVE_SCRIPT" 2>/dev/null || true
fi

if ! command -v gog >/dev/null 2>&1; then
  echo "Error: gog CLI not found in PATH" >&2
  exit 1
fi
if ! command -v openclaw >/dev/null 2>&1; then
  echo "Error: openclaw CLI not found in PATH" >&2
  exit 1
fi

export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

TODAY="$(date +%Y-%m-%d)"

CAL_RAW="$(gog cal list --days 1 --plain 2>/dev/null || true)"
TASKS_RAW="$(psql cortana -At -F '|' -c "
  SELECT id,
         title,
         COALESCE(to_char(due_at AT TIME ZONE 'America/New_York','YYYY-MM-DD HH24:MI'),'') AS due_local,
         priority
  FROM cortana_tasks
  WHERE status IN ('pending','in_progress')
  ORDER BY priority ASC, due_at ASC NULLS LAST, created_at ASC
  LIMIT 5;
" 2>/dev/null || true)"

# Heuristic extraction: keep non-empty lines that look like event entries.
EVENT_LINES="$(printf '%s\n' "$CAL_RAW" | sed '/^\s*$/d' | head -n 8)"

{
  echo "## Morning Brief Enrichment — ${TODAY}"
  echo
  echo "### Related Context from Long-Term Memory"
  echo

  if [[ -z "${EVENT_LINES//[[:space:]]/}" ]]; then
    echo "#### Calendar-linked context"
    echo "- No calendar events detected for today."
    echo
  else
    echo "#### Calendar-linked context"
    i=0
    while IFS= read -r event; do
      [[ -z "${event//[[:space:]]/}" ]] && continue
      i=$((i+1))
      echo "- **Event ${i}:** ${event}"
      "$PREDICTIVE_SCRIPT" "$event" 3 | sed '1d;$d' | sed 's/^/  /'
      echo
    done <<< "$EVENT_LINES"
  fi

  echo "#### Task-linked context"
  if [[ -z "${TASKS_RAW//[[:space:]]/}" ]]; then
    echo "- No pending tasks found in cortana_tasks."
    echo
  else
    while IFS='|' read -r id title due priority; do
      [[ -z "${id//[[:space:]]/}" ]] && continue
      due_text="${due:-no due date}"
      echo "- **Task #${id} (P${priority}, due: ${due_text})** — ${title}"
      "$PREDICTIVE_SCRIPT" "$title" 3 | sed '1d;$d' | sed 's/^/  /'
      echo
    done <<< "$TASKS_RAW"
  fi

  echo "### Suggested Use"
  echo "- Append this block to the morning brief so today's agenda references prior decisions, active research, and unfinished threads."
}