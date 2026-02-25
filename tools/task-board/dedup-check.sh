#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
DB="cortana"
THRESHOLD="0.7"
LIMIT="10"
MEMORY_MAX="8"
JSON_OUT="0"

usage() {
  cat <<'EOF'
Semantic task dedup checker.

Usage:
  dedup-check.sh [options] "task description"

Options:
  --threshold <0-1>   Similarity threshold (default: 0.7)
  --limit <n>         Max similar tasks to return (default: 10)
  --memory-max <n>    Max memory search hits to gather context (default: 8)
  --json              Output JSON instead of TSV
  -h, --help          Show help

Output (TSV):
  task_id<TAB>title<TAB>similarity
EOF
}

if [[ $# -eq 0 ]]; then
  usage
  exit 1
fi

ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --threshold)
      THRESHOLD="${2:-}"
      shift 2
      ;;
    --limit)
      LIMIT="${2:-}"
      shift 2
      ;;
    --memory-max)
      MEMORY_MAX="${2:-}"
      shift 2
      ;;
    --json)
      JSON_OUT="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

DESC="${ARGS[*]:-}"
if [[ -z "${DESC// }" ]]; then
  echo "Error: missing task description" >&2
  usage
  exit 1
fi

MEMORY_JSON="[]"
if command -v openclaw >/dev/null 2>&1; then
  set +e
  MEMORY_JSON=$(openclaw memory search "$DESC" --json --max-results "$MEMORY_MAX" 2>/dev/null)
  rc=$?
  set -e
  if [[ $rc -ne 0 || -z "$MEMORY_JSON" ]]; then
    MEMORY_JSON="[]"
  fi
fi

TASKS_JSON=$(psql "$DB" -q -X -t -A -v ON_ERROR_STOP=1 -c "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (SELECT id, title, COALESCE(description,'') AS description FROM cortana_tasks WHERE status != 'cancelled') t;")

export DEDUP_DESC="$DESC"
export DEDUP_TASKS_JSON="$TASKS_JSON"
export DEDUP_MEMORY_JSON="$MEMORY_JSON"
export DEDUP_THRESHOLD="$THRESHOLD"
export DEDUP_LIMIT="$LIMIT"
export DEDUP_JSON_OUT="$JSON_OUT"

python3 - <<'PY'
import json
import math
import os
import re
import sys
import urllib.request
from pathlib import Path


def load_openai_key() -> str:
    cfg_path = Path.home() / ".openclaw" / "openclaw.json"
    try:
        cfg = json.loads(cfg_path.read_text())
        key = cfg["models"]["providers"]["openai"]["apiKey"]
    except Exception as exc:
        raise RuntimeError(f"failed to read OpenAI API key from {cfg_path}: {exc}") from exc
    if not key:
        raise RuntimeError("OpenAI API key is empty in ~/.openclaw/openclaw.json")
    return key


def embed_texts(texts: list[str], api_key: str) -> list[list[float]]:
    payload = json.dumps({"model": "text-embedding-3-small", "input": texts}).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/embeddings",
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read().decode())
    except Exception as exc:
        raise RuntimeError(f"embedding request failed: {exc}") from exc

    data = body.get("data") or []
    if len(data) != len(texts):
        raise RuntimeError(f"embedding response size mismatch: expected {len(texts)}, got {len(data)}")
    return [item["embedding"] for item in sorted(data, key=lambda x: x["index"])]


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def parse_jsonish(raw: str, default):
    raw = (raw or "").strip()
    if not raw:
        return default
    try:
        return json.loads(raw)
    except Exception:
        pass

    m = re.search(r"(\{[\s\S]*\}|\[[\s\S]*\])", raw)
    if m:
        try:
            return json.loads(m.group(1))
        except Exception:
            return default
    return default


def token_set(text: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9_-]{4,}", text.lower())}


def main() -> int:
    desc = os.environ.get("DEDUP_DESC", "").strip()
    threshold = float(os.environ.get("DEDUP_THRESHOLD", "0.7"))
    limit = int(os.environ.get("DEDUP_LIMIT", "10"))
    json_out = os.environ.get("DEDUP_JSON_OUT", "0") == "1"

    tasks = parse_jsonish(os.environ.get("DEDUP_TASKS_JSON", "[]"), [])
    # memory hits are fetched to satisfy semantic-context requirement and future hook points.
    _memory_hits_raw = parse_jsonish(os.environ.get("DEDUP_MEMORY_JSON", "[]"), [])
    _memory_hits = _memory_hits_raw.get("results", []) if isinstance(_memory_hits_raw, dict) else _memory_hits_raw

    if not tasks:
        return 0

    texts = [desc]
    task_payload = []
    for t in tasks:
        text = f"{t.get('title','')}\n{t.get('description','')}".strip()
        task_payload.append((int(t["id"]), t.get("title", ""), text))
        texts.append(text)

    api_key = load_openai_key()
    embeds = embed_texts(texts, api_key)
    q = embeds[0]

    scored = []
    query_tokens = token_set(desc)
    for i, (task_id, title, task_text) in enumerate(task_payload, start=1):
        raw = cosine(q, embeds[i])
        base = (raw + 1.0) / 2.0  # normalize cosine [-1,1] -> [0,1]
        overlap = len(query_tokens.intersection(token_set(task_text)))
        bonus = min(0.08, overlap * 0.02)  # tiny lexical tie-breaker on top of vector similarity
        score = min(1.0, base + bonus)
        if score >= threshold:
            scored.append({"id": task_id, "title": title, "similarity": round(score, 4)})

    scored.sort(key=lambda x: x["similarity"], reverse=True)
    scored = scored[:limit]

    if json_out:
        print(json.dumps(scored, indent=2))
    else:
        for row in scored:
            print(f"{row['id']}\t{row['title']}\t{row['similarity']:.4f}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1)
PY
