#!/usr/bin/env python3
"""
Sync MEMORY.md and memory/*.md sections into LanceDB.

- Chunks by '##' headers
- Deterministic IDs (sha256 of relative file path + header)
- Content hash for change detection
- Deletes LanceDB rows when markdown sections disappear

Usage:
  python3 tools/memory/markdown-sync.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Sequence, Tuple


WORKSPACE = Path("/Users/hd/openclaw")
DB_PATH_DEFAULT = os.path.expanduser("~/.openclaw/memory/lancedb")
CONFIG_DEFAULT = os.path.expanduser("~/.openclaw/openclaw.json")
TABLE_NAME = "memories"
EMBED_MODEL = "text-embedding-3-small"


@dataclass
class Chunk:
    chunk_id: str
    file_rel: str
    header: str
    body: str
    content_hash: str


class ConfigError(RuntimeError):
    pass


def load_openai_key(config_path: str) -> str:
    with open(config_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    key = (
        cfg.get("plugins", {})
        .get("entries", {})
        .get("memory-lancedb", {})
        .get("config", {})
        .get("embedding", {})
        .get("apiKey")
    )
    if not key:
        raise ConfigError("OpenAI API key not found in openclaw.json at plugins.entries.memory-lancedb.config.embedding.apiKey")
    return key


def http_post_json(url: str, payload: Dict[str, Any], api_key: str) -> Dict[str, Any]:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.loads(resp.read().decode("utf-8"))


def embed_texts(api_key: str, texts: Sequence[str]) -> List[List[float]]:
    if not texts:
        return []
    out = http_post_json(
        "https://api.openai.com/v1/embeddings",
        {"model": EMBED_MODEL, "input": list(texts)},
        api_key,
    )
    return [row["embedding"] for row in out["data"]]


def require_lancedb():
    try:
        import lancedb  # type: ignore
    except Exception as e:
        raise RuntimeError("Missing dependency: lancedb. Install with: python3 -m pip install lancedb") from e
    return lancedb


def open_or_create_table(db_path: str, vector_dim: int):
    lancedb = require_lancedb()
    db = lancedb.connect(db_path)
    names = set(db.table_names())
    if TABLE_NAME in names:
        return db.open_table(TABLE_NAME)

    seed = [{
        "id": "__schema__",
        "text": "",
        "vector": [0.0] * vector_dim,
        "importance": 0.0,
        "category": "other",
        "createdAt": 0,
        "source": "markdown_sync",
        "sourceType": "markdown_sync",
        "contentHash": "",
    }]
    t = db.create_table(TABLE_NAME, data=seed)
    t.delete('id = "__schema__"')
    return t


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def discover_files(workspace: Path) -> List[Path]:
    files = []
    memory_md = workspace / "MEMORY.md"
    if memory_md.exists():
        files.append(memory_md)
    for p in sorted((workspace / "memory").glob("*.md")):
        files.append(p)
    return files


def parse_markdown_chunks(path: Path, workspace: Path) -> List[Chunk]:
    text = path.read_text(encoding="utf-8", errors="ignore")
    rel = str(path.relative_to(workspace))

    # sections keyed by ##
    matches = list(re.finditer(r"^##\s+(.+?)\s*$", text, flags=re.MULTILINE))
    chunks: List[Chunk] = []

    if not matches:
        header = "__document__"
        body = text.strip()
        if body:
            cid = sha256_text(f"{rel}|{header}")
            chash = sha256_text(body)
            chunks.append(Chunk(chunk_id=cid, file_rel=rel, header=header, body=body, content_hash=chash))
        return chunks

    for i, m in enumerate(matches):
        header = m.group(1).strip()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[start:end].strip()
        if not body:
            continue
        cid = sha256_text(f"{rel}|{header}")
        chash = sha256_text(body)
        chunks.append(Chunk(chunk_id=cid, file_rel=rel, header=header, body=body, content_hash=chash))
    return chunks


def load_existing_markdown_rows(table: Any) -> Dict[str, Dict[str, Any]]:
    """Return existing markdown_sync rows keyed by id."""
    queries = [
        lambda: table.search().where("sourceType = 'markdown_sync'").limit(100000).to_list(),
        lambda: table.search().where("source = 'markdown_sync'").limit(100000).to_list(),
    ]
    for q in queries:
        try:
            rows = q()
            out: Dict[str, Dict[str, Any]] = {}
            for r in rows:
                rid = str(r.get("id", ""))
                if rid:
                    out[rid] = r
            return out
        except Exception:
            continue
    return {}


def delete_ids(table: Any, ids: Sequence[str]) -> int:
    deleted = 0
    for rid in ids:
        safe = rid.replace("'", "")
        table.delete(f"id = '{safe}'")
        deleted += 1
    return deleted


def upsert_rows(table: Any, rows: Sequence[Dict[str, Any]]) -> None:
    if not rows:
        return
    table.merge_insert("id").when_matched_update_all().when_not_matched_insert_all().execute(list(rows))


def build_embedding_input(chunk: Chunk) -> str:
    return f"Source: {chunk.file_rel}\nSection: {chunk.header}\n\n{chunk.body}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", default=str(WORKSPACE))
    ap.add_argument("--db-path", default=DB_PATH_DEFAULT)
    ap.add_argument("--config", default=CONFIG_DEFAULT)
    args = ap.parse_args()

    workspace = Path(args.workspace)
    files = discover_files(workspace)

    chunks: List[Chunk] = []
    for p in files:
        chunks.extend(parse_markdown_chunks(p, workspace))

    api_key = load_openai_key(args.config)

    if not chunks:
        print("Synced 0 chunks from 0 files. Added 0, updated 0, deleted 0.")
        return 0

    vectors = embed_texts(api_key, [build_embedding_input(c) for c in chunks])
    table = open_or_create_table(args.db_path, len(vectors[0]))

    existing = load_existing_markdown_rows(table)

    current_ids = {c.chunk_id for c in chunks}
    stale_ids = [rid for rid in existing.keys() if rid not in current_ids]

    now_ms = int(time.time() * 1000)
    add_count = 0
    update_count = 0

    upserts: List[Dict[str, Any]] = []
    for c, v in zip(chunks, vectors):
        prev = existing.get(c.chunk_id)
        is_new = prev is None
        changed = True
        if prev is not None:
            prev_hash = str(prev.get("contentHash") or "")
            changed = prev_hash != c.content_hash

        if is_new:
            add_count += 1
        elif changed:
            update_count += 1

        if is_new or changed:
            upserts.append(
                {
                    "id": c.chunk_id,
                    "text": build_embedding_input(c),
                    "vector": list(v),
                    "importance": 0.7,
                    "category": "fact",
                    "createdAt": int(prev.get("createdAt", now_ms)) if prev else now_ms,
                    "updatedAt": now_ms,
                    "source": "markdown_sync",
                    "sourceType": "markdown_sync",
                    "sourceFile": c.file_rel,
                    "sourceHeader": c.header,
                    "contentHash": c.content_hash,
                }
            )

    upsert_rows(table, upserts)
    deleted = delete_ids(table, stale_ids)

    print(
        f"Synced {len(chunks)} chunks from {len(files)} files. "
        f"Added {add_count}, updated {update_count}, deleted {deleted}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
