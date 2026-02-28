#!/usr/bin/env python3
"""Conversation Insight Promotion Pipeline.

Promotes meaningful conversation/daily-note insights into cortana_memory_semantic.

Commands:
  promote_insights.py scan --source session|daily-notes --since-hours 24 [--dry-run]
  promote_insights.py stats [--days 30]
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import subprocess
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

WORKSPACE = Path("/Users/hd/openclaw")
PSQL_BIN = "/opt/homebrew/opt/postgresql@17/bin/psql"
DB_NAME = "cortana"
SESSIONS_GLOB = str(Path.home() / ".openclaw" / "agents" / "main" / "sessions" / "*.jsonl")
DAILY_NOTES_DIR = WORKSPACE / "memory"
EMBED_SCRIPT = WORKSPACE / "tools" / "embeddings" / "embed.py"
EMBED_BIN = WORKSPACE / "tools" / "embeddings" / "embed"

DEFAULT_MODEL = "phi3:mini"
EMBED_MODEL = "BAAI/bge-small-en-v1.5"
VALID_TYPES = {"preference", "decision", "fact", "event"}


@dataclass
class Candidate:
    source_ref: str
    source_kind: str
    happened_at: datetime
    text: str


@dataclass
class Insight:
    fact_type: str
    subject: str
    predicate: str
    object_value: str
    confidence: float
    importance: float
    tags: list[str]
    rationale: str


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


def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def md5s(value: str) -> str:
    return hashlib.md5(value.encode("utf-8")).hexdigest()


def vec_sql(vec: list[float]) -> str:
    return "'[%s]'::vector" % ",".join(f"{x:.8f}" for x in vec)


def ensure_schema() -> None:
    sql = """
ALTER TABLE cortana_memory_semantic
  ADD COLUMN IF NOT EXISTS embedding_local VECTOR(384),
  ADD COLUMN IF NOT EXISTS embedding_model TEXT,
  ADD COLUMN IF NOT EXISTS extraction_source TEXT,
  ADD COLUMN IF NOT EXISTS superseded_by BIGINT,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS supersedes_id BIGINT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='cortana_memory_semantic_fact_type_check'
  ) THEN
    ALTER TABLE cortana_memory_semantic DROP CONSTRAINT cortana_memory_semantic_fact_type_check;
  END IF;

  ALTER TABLE cortana_memory_semantic
    ADD CONSTRAINT cortana_memory_semantic_fact_type_check
    CHECK (fact_type = ANY (ARRAY['fact','preference','event','system_rule','decision','rule','relationship']));
END $$;

CREATE INDEX IF NOT EXISTS idx_memory_semantic_embedding_local_hnsw
  ON cortana_memory_semantic USING hnsw (embedding_local vector_cosine_ops)
  WHERE embedding_local IS NOT NULL;
"""
    psql(sql)


def parse_session_candidates(since_hours: int) -> list[Candidate]:
    cutoff = datetime.now(timezone.utc) - timedelta(hours=since_hours)
    out: list[Candidate] = []
    for raw in glob.glob(SESSIONS_GLOB):
        p = Path(raw)
        if ".deleted." in p.name:
            continue
        try:
            mtime = datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc)
        except FileNotFoundError:
            continue
        if mtime < cutoff:
            continue

        with p.open("r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") != "message":
                    continue
                msg = obj.get("message", {})
                if msg.get("role") != "user":
                    continue
                parts: list[str] = []
                for chunk in msg.get("content", []):
                    if isinstance(chunk, dict) and chunk.get("type") == "text" and isinstance(chunk.get("text"), str):
                        parts.append(chunk["text"].strip())
                text = " ".join(x for x in parts if x).strip()
                if len(text) < 16:
                    continue

                ts = obj.get("timestamp")
                happened_at = mtime
                if isinstance(ts, str):
                    try:
                        happened_at = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                    except ValueError:
                        pass

                out.append(Candidate(source_ref=str(p), source_kind="session", happened_at=happened_at, text=text))
    return out


def parse_daily_note_candidates(since_hours: int) -> list[Candidate]:
    cutoff = datetime.now(timezone.utc) - timedelta(hours=since_hours)
    out: list[Candidate] = []
    for p in sorted(DAILY_NOTES_DIR.glob("20*.md")):
        try:
            mtime = datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc)
        except FileNotFoundError:
            continue
        if mtime < cutoff:
            continue

        text = p.read_text(encoding="utf-8", errors="ignore")
        for raw in text.splitlines():
            line = raw.strip()
            if not line:
                continue
            if line.startswith("#"):
                continue
            if line.startswith("- "):
                line = line[2:].strip()
            if len(line) < 24:
                continue
            out.append(Candidate(source_ref=str(p), source_kind="daily-notes", happened_at=mtime, text=line))
    return out


def load_candidates(source: str, since_hours: int) -> list[Candidate]:
    if source == "session":
        return parse_session_candidates(since_hours)
    if source == "daily-notes":
        return parse_daily_note_candidates(since_hours)
    raise ValueError(f"Unsupported source: {source}")


def call_ollama(prompt: str, model: str = DEFAULT_MODEL) -> dict[str, Any]:
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
            return json.loads(response[start : end + 1])
        return {"classification": "skip"}


def classify_candidate(c: Candidate, model: str) -> Insight | None:
    prompt = f"""
You classify one user statement for memory promotion.
Return strict JSON only with keys:
- classification: one of preference|decision|fact|event|skip
- subject: short lowercase subject (default hamel)
- predicate: short normalized predicate (e.g. prefers, decided, works_as, plans)
- object_value: concise atomic statement value
- confidence: number 0..1
- importance: number 0..1
- tags: array of <=6 lowercase tags
- rationale: <=20 words

Rules:
- Use skip for chit-chat, one-off procedural commands, or weak/noisy lines.
- Keep object_value factual and concise.
- No markdown, no prose, valid JSON only.

Source: {c.source_kind}
Statement: {c.text}
""".strip()

    parsed = call_ollama(prompt, model=model)
    cls = str(parsed.get("classification", "skip")).strip().lower()
    if cls not in VALID_TYPES:
        return None

    object_value = " ".join(str(parsed.get("object_value", "")).split()).strip()
    if len(object_value) < 8:
        return None

    subject = str(parsed.get("subject", "hamel")).strip().lower() or "hamel"
    predicate = str(parsed.get("predicate", "stated")).strip().lower() or "stated"
    confidence = clamp(float(parsed.get("confidence", 0.7)), 0.0, 1.0)
    importance = clamp(float(parsed.get("importance", 0.6)), 0.0, 1.0)
    tags = [str(t).strip().lower() for t in parsed.get("tags", []) if str(t).strip()][:6]
    rationale = str(parsed.get("rationale", "")).strip()[:200]

    return Insight(
        fact_type=cls,
        subject=subject,
        predicate=predicate,
        object_value=object_value,
        confidence=confidence,
        importance=importance,
        tags=tags,
        rationale=rationale,
    )


def embed(text: str) -> list[float]:
    cmd = [str(EMBED_BIN), "embed", "--text", text] if EMBED_BIN.exists() else ["python3", str(EMBED_SCRIPT), "embed", "--text", text]
    proc = sh(cmd, timeout=180)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "embedding failed")
    payload = json.loads(proc.stdout or "{}")
    vectors = payload.get("vectors") or []
    if not vectors:
        raise RuntimeError("no embedding returned")
    return [float(x) for x in vectors[0]]


def top_neighbor(vec: list[float]) -> tuple[int, str, str, str, float] | None:
    sql = f"""
SELECT id, fact_type, predicate, object_value,
       1 - (embedding_local <=> {vec_sql(vec)}) AS similarity
FROM cortana_memory_semantic
WHERE active = TRUE
  AND embedding_local IS NOT NULL
ORDER BY embedding_local <=> {vec_sql(vec)}
LIMIT 1;
"""
    row = psql(sql, capture=True)
    if not row:
        return None
    rid, fact_type, predicate, object_value, sim = row.split("|", 4)
    return int(rid), fact_type, predicate, object_value, float(sim)


def is_semantic_duplicate(insight: Insight, neighbor: tuple[int, str, str, str, float] | None) -> tuple[bool, float, int | None]:
    if not neighbor:
        return False, 0.0, None
    rid, fact_type, predicate, object_value, sim = neighbor

    # High vector overlap + type/predicate agreement is considered duplicate.
    if sim >= 0.94 and fact_type == insight.fact_type and predicate == insight.predicate:
        return True, sim, rid

    # Very high overlap regardless of predicate means we should skip to avoid memory spam.
    if sim >= 0.975:
        return True, sim, rid

    # Lightweight lexical overlap guard for near-identical statements.
    a = set(insight.object_value.lower().split())
    b = set(object_value.lower().split())
    overlap = (len(a & b) / len(a | b)) if (a or b) else 0.0
    if sim >= 0.92 and overlap >= 0.75:
        return True, sim, rid

    return False, sim, rid


def insert_insight(insight: Insight, candidate: Candidate, vec: list[float], dry_run: bool) -> dict[str, Any]:
    fingerprint = md5s(f"insight|{insight.fact_type}|{insight.subject}|{insight.predicate}|{insight.object_value}")
    metadata = {
        "pipeline": "conversation-insight-promotion",
        "source_kind": candidate.source_kind,
        "tags": insight.tags,
        "importance": insight.importance,
        "classifier_rationale": insight.rationale,
        "raw_excerpt": candidate.text[:500],
        "happened_at": candidate.happened_at.isoformat(),
    }

    if dry_run:
        return {
            "action": "would_insert",
            "type": insight.fact_type,
            "predicate": insight.predicate,
            "object_value": insight.object_value,
            "source_ref": candidate.source_ref,
        }

    sql = f"""
INSERT INTO cortana_memory_semantic (
  fact_type, subject, predicate, object_value,
  confidence, trust, stability,
  first_seen_at, last_seen_at,
  source_type, source_ref, fingerprint,
  metadata, embedding_local, embedding_model, extraction_source
) VALUES (
  {q(insight.fact_type)},
  {q(insight.subject)},
  {q(insight.predicate)},
  {q(insight.object_value)},
  {insight.confidence:.3f},
  {max(0.6, insight.confidence):.3f},
  {max(0.45, insight.importance):.3f},
  {q(candidate.happened_at.isoformat())},
  NOW(),
  'insight_promotion',
  {q(candidate.source_ref)},
  {q(fingerprint)},
  {q(json.dumps(metadata))}::jsonb,
  {vec_sql(vec)},
  {q(EMBED_MODEL)},
  {q(candidate.source_kind)}
)
ON CONFLICT (fact_type, subject, predicate, object_value)
DO UPDATE SET
  last_seen_at = NOW(),
  confidence = GREATEST(cortana_memory_semantic.confidence, EXCLUDED.confidence),
  metadata = cortana_memory_semantic.metadata || EXCLUDED.metadata
RETURNING id;
"""
    mid = int(psql(sql, capture=True))
    return {
        "action": "inserted",
        "id": mid,
        "type": insight.fact_type,
        "predicate": insight.predicate,
        "object_value": insight.object_value,
        "source_ref": candidate.source_ref,
    }


def cmd_scan(args: argparse.Namespace) -> None:
    ensure_schema()
    candidates = load_candidates(args.source, args.since_hours)

    results: list[dict[str, Any]] = []
    counts = {"promoted": 0, "skip_classification": 0, "skip_duplicate": 0, "errors": 0}

    for c in candidates:
        try:
            insight = classify_candidate(c, model=args.model)
            if not insight:
                counts["skip_classification"] += 1
                continue

            vec = embed(f"{insight.fact_type} | {insight.subject} | {insight.predicate} | {insight.object_value}")
            duplicate, similarity, existing_id = is_semantic_duplicate(insight, top_neighbor(vec))
            if duplicate:
                counts["skip_duplicate"] += 1
                results.append({
                    "action": "skip_duplicate",
                    "existing_id": existing_id,
                    "similarity": round(similarity, 4),
                    "type": insight.fact_type,
                    "object_value": insight.object_value,
                })
                continue

            rec = insert_insight(insight, c, vec, dry_run=args.dry_run)
            counts["promoted"] += 1
            results.append(rec)
        except Exception as e:
            counts["errors"] += 1
            results.append({"action": "error", "source_ref": c.source_ref, "error": str(e)})

    print(json.dumps({
        "ok": True,
        "mode": "scan",
        "source": args.source,
        "since_hours": args.since_hours,
        "candidates": len(candidates),
        "summary": counts,
        "results": results,
    }, indent=2))


def cmd_stats(args: argparse.Namespace) -> None:
    sql = f"""
SELECT to_char(date_trunc('day', first_seen_at), 'YYYY-MM-DD') AS day,
       fact_type,
       COUNT(*)
FROM cortana_memory_semantic
WHERE source_type = 'insight_promotion'
  AND first_seen_at >= NOW() - INTERVAL '{int(args.days)} days'
GROUP BY 1,2
ORDER BY 1 DESC, 2;
"""
    rows = psql(sql, capture=True).splitlines()
    data: list[dict[str, Any]] = []
    for row in rows:
        if not row:
            continue
        day, fact_type, count = row.split("|", 2)
        data.append({"day": day, "type": fact_type, "count": int(count)})

    totals_sql = f"""
SELECT fact_type, COUNT(*)
FROM cortana_memory_semantic
WHERE source_type = 'insight_promotion'
  AND first_seen_at >= NOW() - INTERVAL '{int(args.days)} days'
GROUP BY fact_type
ORDER BY COUNT(*) DESC;
"""
    totals_rows = psql(totals_sql, capture=True).splitlines()
    totals: dict[str, int] = {}
    for row in totals_rows:
        if not row:
            continue
        t, c = row.split("|", 1)
        totals[t] = int(c)

    print(json.dumps({
        "ok": True,
        "mode": "stats",
        "days": args.days,
        "totals_by_type": totals,
        "series": data,
    }, indent=2))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Promote conversation insights into semantic memory")
    sub = p.add_subparsers(dest="cmd", required=True)

    p_scan = sub.add_parser("scan", help="Scan one source and promote insights")
    p_scan.add_argument("--source", choices=["session", "daily-notes"], required=True)
    p_scan.add_argument("--since-hours", type=int, default=24)
    p_scan.add_argument("--model", default=DEFAULT_MODEL)
    p_scan.add_argument("--dry-run", action="store_true")
    p_scan.set_defaults(func=cmd_scan)

    p_stats = sub.add_parser("stats", help="Show promotion counts by type over time")
    p_stats.add_argument("--days", type=int, default=30)
    p_stats.set_defaults(func=cmd_stats)

    return p


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
