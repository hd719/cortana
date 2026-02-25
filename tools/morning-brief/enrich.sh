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
  LIMIT 10;
" 2>/dev/null || true)"

EVENT_LINES="$(printf '%s\n' "$CAL_RAW" | sed '/^\s*$/d' | head -n 12)"

TOPICS_FILE="$(mktemp)"
trap 'rm -f "$TOPICS_FILE"' EXIT

# Collect calendar topics
if [[ -n "${EVENT_LINES//[[:space:]]/}" ]]; then
  while IFS= read -r event; do
    [[ -z "${event//[[:space:]]/}" ]] && continue
    printf '%s\n' "$event" >> "$TOPICS_FILE"
  done <<< "$EVENT_LINES"
fi

# Collect task board topics
if [[ -n "${TASKS_RAW//[[:space:]]/}" ]]; then
  while IFS='|' read -r _id title _due _priority; do
    [[ -z "${title//[[:space:]]/}" ]] && continue
    printf '%s\n' "$title" >> "$TOPICS_FILE"
  done <<< "$TASKS_RAW"
fi

CONSOLIDATED_CONTEXT="$(
TOPICS_FILE="$TOPICS_FILE" python3 - <<'PY'
import concurrent.futures
import json
import os
import re
import subprocess
from collections import OrderedDict

TOPICS_FILE = os.environ["TOPICS_FILE"]
MAX_RESULTS = 4
MAX_SNIPPETS = 20

def load_topics(path: str) -> list[str]:
    topics = []
    seen = set()
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            t = re.sub(r"\s+", " ", raw).strip(" -\t\n")
            if not t:
                continue
            key = t.lower()
            if key in seen:
                continue
            seen.add(key)
            topics.append(t)
    return topics

def parse_output(raw: str):
    raw = (raw or "").strip()
    if not raw:
        return []
    m = re.search(r"[\[{]", raw)
    if m:
        raw = raw[m.start():]
    try:
        payload = json.loads(raw)
    except Exception:
        return []

    if isinstance(payload, dict):
        for k in ("results", "items", "matches", "data"):
            if isinstance(payload.get(k), list):
                payload = payload[k]
                break
        else:
            payload = []
    if not isinstance(payload, list):
        return []

    out = []
    for item in payload:
        if isinstance(item, dict):
            source = item.get("source") or item.get("path") or item.get("title") or "memory"
            txt = (
                item.get("snippet")
                or item.get("content")
                or item.get("text")
                or item.get("summary")
                or item.get("body")
                or ""
            )
            score = item.get("score") or item.get("similarity") or item.get("relevance")
        else:
            source = "memory"
            txt = str(item)
            score = None

        txt = re.sub(r"\s+", " ", str(txt)).strip()
        if not txt:
            continue
        if len(txt) > 300:
            txt = txt[:297].rstrip() + "..."
        out.append({"source": str(source), "text": txt, "score": score})
    return out

def search_topic(topic: str):
    cmds = [
        ["openclaw", "ltm", "search", topic, "--json", "--max-results", str(MAX_RESULTS)],
        ["openclaw", "memory", "search", topic, "--json", "--max-results", str(MAX_RESULTS)],
    ]
    for cmd in cmds:
        try:
            p = subprocess.run(cmd, text=True, capture_output=True, timeout=12)
            if p.returncode == 0 and p.stdout.strip():
                rows = parse_output(p.stdout)
                if rows:
                    return topic, rows
        except Exception:
            pass
    return topic, []


topics = load_topics(TOPICS_FILE)
if not topics:
    print("_No event/task topics available for predictive preload._")
    raise SystemExit(0)

results = []
with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, max(2, len(topics)))) as ex:
    futs = [ex.submit(search_topic, t) for t in topics]
    for fut in concurrent.futures.as_completed(futs):
        results.append(fut.result())

# Aggregate + dedupe across all event/task searches.
unique = OrderedDict()
for topic, rows in sorted(results, key=lambda x: x[0].lower()):
    for r in rows:
        key = (r["source"].strip().lower(), r["text"].strip().lower())
        if key not in unique:
            unique[key] = {"topic": topic, **r}

if not unique:
    print("_No related memory found for today's events/tasks._")
    raise SystemExit(0)

lines = []
for i, row in enumerate(list(unique.values())[:MAX_SNIPPETS], 1):
    score_txt = ""
    try:
        if row.get("score") is not None:
            score_txt = f" (score: {float(row['score']):.3f})"
    except Exception:
        score_txt = ""
    lines.append(f"{i}. [{row['topic']}] **{row['source']}**{score_txt} — {row['text']}")

print("\n".join(lines))
PY
)"

{
  echo "## Morning Brief Enrichment — ${TODAY}"
  echo
  echo "### Consolidated Predictive Memory Context (Preload)"
  echo "_Prefetched across today's calendar events + task board topics, aggregated and deduplicated._"
  echo
  printf '%s\n' "$CONSOLIDATED_CONTEXT"
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
  echo "- Prepend the consolidated preload block to the morning brief to ground the day in prior decisions and active threads."
}