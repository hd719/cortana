#!/usr/bin/env python3
"""Safe memory search with vector->keyword fallback.

Primary path: `openclaw memory search`.
Fallback path: keyword scan over MEMORY.md and memory/*.md when vector search
is unavailable or embedding quota errors occur.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

WORKSPACE = Path("/Users/hd/openclaw")
STATE_PATH = WORKSPACE / "memory" / "vector-memory-health-state.json"


def load_state() -> dict[str, Any]:
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(state: dict[str, Any]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")


def parse_json(raw: str) -> Any | None:
    raw = raw.strip()
    if not raw:
        return None
    m = re.search(r"[\[{]", raw)
    if m:
        raw = raw[m.start() :]
    try:
        return json.loads(raw)
    except Exception:
        return None


def vector_search(query: str, max_results: int) -> tuple[list[dict[str, Any]] | None, str]:
    proc = subprocess.run(
        ["openclaw", "memory", "search", query, "--json", "--max-results", str(max_results)],
        capture_output=True,
        text=True,
        timeout=90,
    )
    combined = f"{proc.stdout}\n{proc.stderr}".strip()
    payload = parse_json(proc.stdout)
    items: list[dict[str, Any]] = []
    if isinstance(payload, list):
        items = [x for x in payload if isinstance(x, dict)]
    elif isinstance(payload, dict):
        for key in ("results", "items", "matches", "data"):
            val = payload.get(key)
            if isinstance(val, list):
                items = [x for x in val if isinstance(x, dict)]
                break

    text_lower = combined.lower()
    quota_error = bool(re.search(r"(resource_exhausted|embedd\w*[^\n]{0,80}429|429[^\n]{0,80}embedd\w*)", text_lower)) and (
        "failed" in text_lower or "error" in text_lower or "quota" in text_lower
    )

    if proc.returncode != 0 or quota_error:
        return None, combined
    return items, combined


def collect_files(workspace: Path) -> list[Path]:
    files: list[Path] = []
    root = workspace / "MEMORY.md"
    if root.exists():
        files.append(root)
    mem = workspace / "memory"
    if mem.exists():
        files.extend(sorted(mem.glob("*.md")))
    return files


def score_line(query_terms: list[str], line: str) -> int:
    l = line.lower()
    score = 0
    for t in query_terms:
        if t in l:
            score += 2
    if len(query_terms) >= 2 and all(t in l for t in query_terms[:2]):
        score += 1
    return score


def keyword_fallback(query: str, max_results: int) -> list[dict[str, Any]]:
    terms = [t for t in re.findall(r"[a-zA-Z0-9_]+", query.lower()) if len(t) >= 3]
    if not terms:
        terms = [query.lower()]

    hits: list[dict[str, Any]] = []
    for p in collect_files(WORKSPACE):
        try:
            lines = p.read_text(encoding="utf-8", errors="ignore").splitlines()
        except Exception:
            continue
        rel = str(p.relative_to(WORKSPACE))
        for idx, line in enumerate(lines, start=1):
            s = score_line(terms, line)
            if s <= 0:
                continue
            snippet = line.strip()
            if len(snippet) > 420:
                snippet = snippet[:417] + "..."
            hits.append(
                {
                    "source": rel,
                    "line": idx,
                    "snippet": snippet,
                    "score": float(s),
                    "mode": "keyword_fallback",
                }
            )

    hits.sort(key=lambda x: x["score"], reverse=True)
    return hits[:max_results]


def main() -> int:
    ap = argparse.ArgumentParser(description="Safe memory search with fallback")
    ap.add_argument("query")
    ap.add_argument("--max-results", type=int, default=5)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    state = load_state()
    force_fallback = bool(state.get("fallback_mode", False))

    items: list[dict[str, Any]]
    mode = "vector"
    error_text = ""

    if not force_fallback:
        vector_items, error_text = vector_search(args.query, args.max_results)
        if vector_items is not None:
            items = vector_items
        else:
            mode = "keyword_fallback"
            items = keyword_fallback(args.query, args.max_results)
    else:
        mode = "keyword_fallback"
        items = keyword_fallback(args.query, args.max_results)

    if mode == "keyword_fallback":
        state["fallback_mode"] = True
        state["last_fallback_reason"] = error_text[:500]
        save_state(state)

    output = {"mode": mode, "query": args.query, "results": items}
    if args.json:
        print(json.dumps(output, ensure_ascii=False))
    else:
        print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
