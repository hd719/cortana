#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  cat <<'EOF' >&2
Usage: tools/memory/predictive-context.sh "<topic or query>" [max_results]
EOF
  exit 1
fi

QUERY="$1"
MAX_RESULTS="${2:-5}"

if ! command -v openclaw >/dev/null 2>&1; then
  echo "Error: openclaw CLI not found in PATH" >&2
  exit 1
fi

RAW_JSON="$(python3 /Users/hd/openclaw/tools/memory/safe-memory-search.py "$QUERY" --json --max-results "$MAX_RESULTS" 2>/dev/null || true)"

if [[ -z "${RAW_JSON//[[:space:]]/}" ]]; then
  cat <<EOF
## Predictive Context: ${QUERY}

_No related memory found._
EOF
  exit 0
fi

RAW_JSON="$RAW_JSON" python3 - "$QUERY" "$MAX_RESULTS" <<'PY'
import json
import os
import re
import sys

query = sys.argv[1]
max_results = int(sys.argv[2])
raw = os.environ.get("RAW_JSON", "").strip()

# openclaw may print doctor warnings before JSON; trim to first JSON token.
match = re.search(r"[\[{]", raw)
if match:
    raw = raw[match.start():]

try:
    payload = json.loads(raw)
except Exception:
    print(f"## Predictive Context: {query}\n\n_No related memory found._")
    sys.exit(0)

if isinstance(payload, dict):
    for key in ("results", "items", "matches", "data"):
        if isinstance(payload.get(key), list):
            items = payload[key]
            break
    else:
        items = []
elif isinstance(payload, list):
    items = payload
else:
    items = []

def flatten_text(node):
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, dict):
        preferred = [
            "snippet", "content", "text", "summary", "chunk", "body", "value", "message"
        ]
        for key in preferred:
            value = node.get(key)
            if isinstance(value, str) and value.strip():
                return value
        # fallback: stringify compactly
        return json.dumps(node, ensure_ascii=False)
    if isinstance(node, list):
        parts = [flatten_text(x) for x in node]
        return " ".join([p for p in parts if p])
    return str(node)

def source_label(item):
    if not isinstance(item, dict):
        return "memory"
    for key in ("source", "file", "path", "id", "title"):
        v = item.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    meta = item.get("metadata")
    if isinstance(meta, dict):
        for key in ("source", "path", "title"):
            v = meta.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()
    return "memory"

def score(item):
    if not isinstance(item, dict):
        return None
    for key in ("score", "similarity", "relevance"):
        v = item.get(key)
        if isinstance(v, (int, float)):
            return float(v)
    return None

cleaned = []
for item in items:
    txt = ""
    if isinstance(item, dict):
        txt = flatten_text(item)
    else:
        txt = flatten_text(item)
    txt = re.sub(r"\s+", " ", txt).strip()
    if not txt:
        continue
    if len(txt) > 420:
        txt = txt[:417].rstrip() + "..."
    cleaned.append({
        "text": txt,
        "source": source_label(item),
        "score": score(item),
    })

if not cleaned:
    print(f"## Predictive Context: {query}\n\n_No related memory found._")
    sys.exit(0)

cleaned = cleaned[:max_results]

print(f"## Predictive Context: {query}\n")
for idx, row in enumerate(cleaned, 1):
    sc = row["score"]
    score_txt = f" (score: {sc:.3f})" if isinstance(sc, float) else ""
    print(f"{idx}. **{row['source']}**{score_txt}")
    print(f"   - {row['text']}")
print("\n_Use this context to ground the next response in prior decisions, research, and ongoing threads._")
PY
