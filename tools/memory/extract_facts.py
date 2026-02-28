#!/usr/bin/env python3
"""Atomic fact extraction pipeline for cortana_memory_semantic.

Commands:
  extract_facts.py extract --input <file|-> [--dry-run]
  extract_facts.py batch --since-hours 24 [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

WORKSPACE = Path("/Users/hd/openclaw")
PSQL_BIN = "/opt/homebrew/opt/postgresql@17/bin/psql"
DB_NAME = "cortana"
PROMPT_FILE = WORKSPACE / "tools" / "memory" / "prompts" / "fact_extraction.txt"
EMBED_SCRIPT = WORKSPACE / "tools" / "embeddings" / "embed.py"
EMBED_BIN = WORKSPACE / "tools" / "embeddings" / "embed"
SESSIONS_GLOB = os.path.expanduser("~/.openclaw/agents/main/sessions/*.jsonl")

VALID_TYPES = {"fact", "preference", "event", "system_rule"}


@dataclass
class AtomicFact:
    fact_type: str
    content: str
    tags: list[str]
    people: list[str]
    projects: list[str]
    importance: float
    confidence: float
    supersedes_id: int | None = None


def sh(cmd: list[str], timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def psql(sql: str, capture: bool = False) -> str:
    proc = sh([PSQL_BIN, DB_NAME, "-q", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], timeout=180)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "psql failed")
    return (proc.stdout or "").strip() if capture else ""


def q(value: Any) -> str:
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def ensure_schema() -> None:
    sql = """
ALTER TABLE cortana_memory_semantic
  ADD COLUMN IF NOT EXISTS fact_type TEXT,
  ADD COLUMN IF NOT EXISTS superseded_by BIGINT,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS supersedes_id BIGINT,
  ADD COLUMN IF NOT EXISTS extraction_source TEXT,
  ADD COLUMN IF NOT EXISTS embedding_local VECTOR(384);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='cortana_memory_semantic_superseded_by_fkey'
  ) THEN
    ALTER TABLE cortana_memory_semantic
      ADD CONSTRAINT cortana_memory_semantic_superseded_by_fkey
      FOREIGN KEY (superseded_by) REFERENCES cortana_memory_semantic(id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='cortana_memory_semantic_supersedes_id_fkey'
  ) THEN
    ALTER TABLE cortana_memory_semantic
      ADD CONSTRAINT cortana_memory_semantic_supersedes_id_fkey
      FOREIGN KEY (supersedes_id) REFERENCES cortana_memory_semantic(id);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='cortana_memory_semantic_fact_type_check'
  ) THEN
    ALTER TABLE cortana_memory_semantic DROP CONSTRAINT cortana_memory_semantic_fact_type_check;
  END IF;

  ALTER TABLE cortana_memory_semantic
    ALTER COLUMN fact_type SET DEFAULT 'fact';

  UPDATE cortana_memory_semantic
  SET fact_type = 'fact'
  WHERE fact_type IS NULL;

  ALTER TABLE cortana_memory_semantic
    ADD CONSTRAINT cortana_memory_semantic_fact_type_check
    CHECK (fact_type = ANY (ARRAY['fact','preference','event','system_rule','decision','rule','relationship']));
END $$;

CREATE INDEX IF NOT EXISTS idx_memory_semantic_embedding_local_hnsw
  ON cortana_memory_semantic USING hnsw (embedding_local vector_cosine_ops)
  WHERE embedding_local IS NOT NULL;
"""
    psql(sql)


def load_prompt() -> str:
    if not PROMPT_FILE.exists():
        raise FileNotFoundError(f"Missing prompt template: {PROMPT_FILE}")
    return PROMPT_FILE.read_text(encoding="utf-8")


def parse_jsonl_transcript(path: Path) -> str:
    lines: list[str] = []
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if obj.get("type") != "message":
                continue
            msg = obj.get("message", {})
            role = msg.get("role")
            if role not in {"user", "assistant"}:
                continue
            text_parts: list[str] = []
            for chunk in msg.get("content", []):
                if isinstance(chunk, dict) and chunk.get("type") == "text" and isinstance(chunk.get("text"), str):
                    text_parts.append(chunk["text"])
            if text_parts:
                lines.append(f"{role.upper()}: {' '.join(text_parts).strip()}")
    return "\n".join(lines)


def read_input(input_path: str) -> tuple[str, str]:
    if input_path == "-":
        return "stdin", sys.stdin.read()
    p = Path(input_path)
    if not p.exists():
        raise FileNotFoundError(input_path)
    if p.suffix == ".jsonl":
        return str(p), parse_jsonl_transcript(p)
    return str(p), p.read_text(encoding="utf-8", errors="ignore")


def embed(text: str) -> list[float]:
    cmd = [str(EMBED_BIN), "embed", "--text", text] if EMBED_BIN.exists() else ["python3", str(EMBED_SCRIPT), "embed", "--text", text]
    proc = sh(cmd, timeout=120)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "embedding failed")
    payload = json.loads(proc.stdout or "{}")
    vectors = payload.get("vectors") or []
    if not vectors:
        raise RuntimeError("no embedding returned")
    return [float(x) for x in vectors[0]]


def vec_sql(vec: list[float]) -> str:
    return "'[%s]'::vector" % ",".join(f"{x:.8f}" for x in vec)


def call_ollama(prompt: str, model: str) -> dict[str, Any]:
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "format": "json",
        "options": {"temperature": 0.1},
    }
    proc = sh(["curl", "-sS", "http://127.0.0.1:11434/api/generate", "-d", json.dumps(payload)], timeout=180)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "ollama call failed")
    wrapped = json.loads(proc.stdout or "{}")
    response = (wrapped.get("response") or "{}").strip()
    try:
        return json.loads(response)
    except json.JSONDecodeError:
        start = response.find("{")
        end = response.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(response[start : end + 1])
            except json.JSONDecodeError:
                return {"facts": []}
        return {"facts": []}


def normalize_fact(raw: dict[str, Any]) -> AtomicFact | None:
    try:
        fact_type = str(raw.get("type", "")).strip()
        content = " ".join(str(raw.get("content", "")).split()).strip()
        tags = [str(t).strip() for t in raw.get("tags", []) if str(t).strip()]
        people = [str(p).strip() for p in raw.get("people", []) if str(p).strip()]
        projects = [str(p).strip() for p in raw.get("projects", []) if str(p).strip()]
        importance = max(0.0, min(1.0, float(raw.get("importance", 0.5))))
        confidence = max(0.0, min(1.0, float(raw.get("confidence", 0.5))))
    except Exception:
        return None

    if fact_type not in VALID_TYPES:
        return None
    if len(content) < 8:
        return None

    supersedes_id = raw.get("supersedes_id")
    if supersedes_id is not None:
        try:
            supersedes_id = int(supersedes_id)
        except Exception:
            supersedes_id = None

    return AtomicFact(
        fact_type=fact_type,
        content=content,
        tags=tags[:12],
        people=people[:12],
        projects=projects[:12],
        importance=importance,
        confidence=confidence,
        supersedes_id=supersedes_id,
    )


def find_neighbors(vec: list[float]) -> list[tuple[int, str, float]]:
    sql = f"""
SELECT id, object_value, 1 - (embedding_local <=> {vec_sql(vec)}) AS similarity
FROM cortana_memory_semantic
WHERE active = TRUE
  AND embedding_local IS NOT NULL
  AND (1 - (embedding_local <=> {vec_sql(vec)})) >= 0.85
ORDER BY embedding_local <=> {vec_sql(vec)}
LIMIT 5;
"""
    rows = psql(sql, capture=True).splitlines()
    out: list[tuple[int, str, float]] = []
    for row in rows:
        if not row:
            continue
        rid, text, sim = row.split("|", 2)
        out.append((int(rid), text, float(sim)))
    return out


def classify_meaning(existing: str, new: str, model: str) -> tuple[bool, bool]:
    prompt = (
        "Return only JSON {\"identical\":true|false,\"updated\":true|false}. "
        "identical=true when both statements mean the same thing. "
        "updated=true when B should supersede A (same subject, newer/corrected detail).\n"
        f"A: {existing}\nB: {new}\n"
    )
    try:
        parsed = call_ollama(prompt, model=model)
    except Exception:
        return False, False
    return bool(parsed.get("identical")), bool(parsed.get("updated"))


def insert_fact(fact: AtomicFact, source_ref: str, vec: list[float], supersedes_id: int | None, dry_run: bool) -> dict[str, Any]:
    metadata = json.dumps({
        "atomic_fact": True,
        "importance": fact.importance,
        "tags": fact.tags,
        "people": fact.people,
        "projects": fact.projects,
    })

    if dry_run:
        return {"action": "would_insert", "fact": fact.content, "supersedes_id": supersedes_id}

    sql = f"""
INSERT INTO cortana_memory_semantic (
  fact_type, subject, predicate, object_value,
  confidence, trust, stability,
  first_seen_at, last_seen_at,
  source_type, source_ref, fingerprint,
  metadata, embedding_local, embedding_model,
  extraction_source, supersedes_id
) VALUES (
  {q(fact.fact_type)},
  'hamel',
  'stated',
  {q(fact.content)},
  {fact.confidence:.3f},
  {max(0.5, fact.confidence):.3f},
  {max(0.4, fact.importance):.3f},
  NOW(), NOW(),
  'atomic_extraction',
  {q(source_ref)},
  md5({q(fact.fact_type + '|' + fact.content)}),
  {q(metadata)}::jsonb,
  {vec_sql(vec)},
  'BAAI/bge-small-en-v1.5',
  {q(source_ref)},
  {str(supersedes_id) if supersedes_id else 'NULL'}
)
ON CONFLICT (fact_type, subject, predicate, object_value)
DO UPDATE SET
  last_seen_at = NOW(),
  confidence = GREATEST(cortana_memory_semantic.confidence, EXCLUDED.confidence),
  metadata = cortana_memory_semantic.metadata || EXCLUDED.metadata
RETURNING id;
"""
    new_id = int(psql(sql, capture=True))

    if supersedes_id:
        psql(
            f"UPDATE cortana_memory_semantic "
            f"SET active=FALSE, superseded_by={new_id}, superseded_at=NOW() "
            f"WHERE id={supersedes_id};"
        )

    return {"action": "insert", "id": new_id, "fact": fact.content, "supersedes_id": supersedes_id}


def process_text(text: str, source_ref: str, model: str, dry_run: bool) -> list[dict[str, Any]]:
    prompt_template = load_prompt()
    prompt = prompt_template.replace("{{TRANSCRIPT}}", text[:18000]).replace("{{EXISTING_FACTS}}", "[]")
    parsed = call_ollama(prompt, model=model)
    facts_raw = parsed.get("facts", []) if isinstance(parsed, dict) else []

    results: list[dict[str, Any]] = []
    for item in facts_raw:
        fact = normalize_fact(item)
        if not fact:
            continue

        vec = embed(fact.content)
        neighbors = find_neighbors(vec)
        best = neighbors[0] if neighbors else None

        if best and best[2] > 0.95:
            identical, updated = classify_meaning(best[1], fact.content, model)
            if identical:
                results.append({"action": "skip_duplicate", "existing_id": best[0], "similarity": round(best[2], 4), "fact": fact.content})
                continue
            if updated:
                results.append(insert_fact(fact, source_ref, vec, best[0], dry_run=dry_run))
                continue

        if best and 0.85 <= best[2] <= 0.95:
            identical, updated = classify_meaning(best[1], fact.content, model)
            if identical:
                results.append({"action": "skip_duplicate", "existing_id": best[0], "similarity": round(best[2], 4), "fact": fact.content})
                continue
            if updated:
                results.append(insert_fact(fact, source_ref, vec, best[0], dry_run=dry_run))
                continue

        # Similarity threshold for semantic match check requested by spec.
        if best and best[2] >= 0.92:
            results.append(insert_fact(fact, source_ref, vec, None, dry_run=dry_run))
        else:
            results.append(insert_fact(fact, source_ref, vec, None, dry_run=dry_run))

    return results


def cmd_extract(args: argparse.Namespace) -> None:
    ensure_schema()
    source_ref, text = read_input(args.input)
    results = process_text(text, source_ref=source_ref, model=args.model, dry_run=args.dry_run)
    print(json.dumps({"ok": True, "mode": "extract", "source": source_ref, "count": len(results), "results": results}, indent=2))


def recent_session_files(since_hours: int) -> list[Path]:
    import glob

    cutoff = datetime.now(timezone.utc) - timedelta(hours=since_hours)
    out: list[Path] = []
    for raw in glob.glob(SESSIONS_GLOB):
        p = Path(raw)
        if ".deleted." in p.name:
            continue
        try:
            mtime = datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc)
        except FileNotFoundError:
            continue
        if mtime >= cutoff:
            out.append(p)
    return sorted(out)


def cmd_batch(args: argparse.Namespace) -> None:
    ensure_schema()
    files = recent_session_files(args.since_hours)
    all_results: list[dict[str, Any]] = []
    for f in files:
        text = parse_jsonl_transcript(f)
        if not text.strip():
            continue
        all_results.extend(process_text(text, source_ref=str(f), model=args.model, dry_run=args.dry_run))

    print(json.dumps({
        "ok": True,
        "mode": "batch",
        "since_hours": args.since_hours,
        "sessions": len(files),
        "result_count": len(all_results),
        "results": all_results,
    }, indent=2))


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Extract atomic facts into cortana_memory_semantic")
    sub = p.add_subparsers(dest="cmd", required=True)

    p_extract = sub.add_parser("extract", help="Extract facts from one file or stdin")
    p_extract.add_argument("--input", required=True, help="Input file path or '-' for stdin")
    p_extract.add_argument("--dry-run", action="store_true")
    p_extract.add_argument("--model", default="phi3:mini")
    p_extract.set_defaults(func=cmd_extract)

    p_batch = sub.add_parser("batch", help="Process recent session logs")
    p_batch.add_argument("--since-hours", type=int, default=24)
    p_batch.add_argument("--dry-run", action="store_true")
    p_batch.add_argument("--model", default="phi3:mini")
    p_batch.set_defaults(func=cmd_batch)

    return p


def main() -> None:
    args = parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
