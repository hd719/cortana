#!/usr/bin/env python3
"""Semantic Compression Engine: Daily Memory Distillation with Fidelity Checks.

Reads recent episodic memories, clusters related entries, generates compressed
summaries (facts/decisions/action items), computes fidelity scores, and writes
results to cortana_memory_semantic.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql"
DB = "cortana"
WORKSPACE = Path("/Users/hd/openclaw")

GENERIC_TAGS = {
    "memory",
    "daily_memory",
    "heartbeat_ingest",
    "note",
    "notes",
    "log",
    "general",
}
STOPWORDS = {
    "the",
    "and",
    "for",
    "that",
    "with",
    "from",
    "this",
    "have",
    "will",
    "were",
    "been",
    "about",
    "into",
    "when",
    "what",
    "where",
    "your",
    "their",
    "them",
    "then",
    "than",
    "just",
    "also",
    "more",
    "very",
    "only",
    "over",
    "under",
    "need",
    "next",
}


@dataclass
class EpisodicEntry:
    id: int
    happened_at: str
    summary: str
    details: str
    tags: list[str]
    participants: list[str]

    @property
    def text(self) -> str:
        return "\n".join([self.summary or "", self.details or ""]).strip()


@dataclass
class Cluster:
    id: int
    entries: list[EpisodicEntry] = field(default_factory=list)
    feature_counts: Counter = field(default_factory=Counter)

    @property
    def feature_set(self) -> set[str]:
        return set(self.feature_counts.keys())


def q(value: Any) -> str:
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def psql(sql: str, capture: bool = False) -> str:
    proc = subprocess.run(
        [PSQL, DB, "-q", "-v", "ON_ERROR_STOP=1", "-At", "-F", "\t", "-c", sql],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "psql command failed")
    if not capture:
        return ""
    return (proc.stdout or "").strip()


def fp(*parts: str) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update((p or "").encode("utf-8"))
        h.update(b"|")
    return h.hexdigest()[:40]


def ensure_fidelity_column() -> None:
    sql = """
    ALTER TABLE cortana_memory_semantic
    ADD COLUMN IF NOT EXISTS fidelity_score numeric(5,4);

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'cortana_memory_semantic_fidelity_score_check'
      ) THEN
        ALTER TABLE cortana_memory_semantic
        ADD CONSTRAINT cortana_memory_semantic_fidelity_score_check
        CHECK (fidelity_score IS NULL OR (fidelity_score >= 0 AND fidelity_score <= 1));
      END IF;
    END $$;
    """
    psql(sql)


def parse_array(raw: str) -> list[str]:
    if not raw:
        return []
    return [x for x in raw.split(",") if x]


def fetch_recent_episodic(since_hours: int) -> list[EpisodicEntry]:
    sql = f"""
    SELECT
      id,
      happened_at::text,
      COALESCE(summary, ''),
      COALESCE(details, ''),
      COALESCE(array_to_string(tags, ','), ''),
      COALESCE(array_to_string(participants, ','), '')
    FROM cortana_memory_episodic
    WHERE active = TRUE
      AND happened_at >= NOW() - INTERVAL '{since_hours} hours'
    ORDER BY happened_at ASC;
    """
    out = psql(sql, capture=True)
    rows: list[EpisodicEntry] = []
    for line in out.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) != 6:
            continue
        rows.append(
            EpisodicEntry(
                id=int(parts[0]),
                happened_at=parts[1],
                summary=parts[2],
                details=parts[3],
                tags=parse_array(parts[4]),
                participants=parse_array(parts[5]),
            )
        )
    return rows


def tokenize(text: str) -> list[str]:
    words = re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}", text.lower())
    return [w for w in words if w not in STOPWORDS]


def extract_features(entry: EpisodicEntry) -> set[str]:
    tags = {t.strip().lower() for t in entry.tags if t and t.strip()}
    tags = {t for t in tags if t not in GENERIC_TAGS}

    toks = tokenize(entry.summary + "\n" + entry.details)
    common = {w for w, _ in Counter(toks).most_common(8)}
    return tags.union(common)


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def cluster_entries(entries: list[EpisodicEntry], threshold: float = 0.25) -> list[Cluster]:
    clusters: list[Cluster] = []
    for entry in entries:
        features = extract_features(entry)
        best_idx = -1
        best_score = 0.0
        for i, c in enumerate(clusters):
            score = jaccard(features, c.feature_set)
            if score > best_score:
                best_score = score
                best_idx = i

        if best_idx >= 0 and best_score >= threshold:
            target = clusters[best_idx]
        else:
            target = Cluster(id=len(clusters) + 1)
            clusters.append(target)

        target.entries.append(entry)
        for f in features:
            target.feature_counts[f] += 1
    return clusters


def normalize_line(line: str) -> str:
    line = re.sub(r"\s+", " ", line).strip(" -•\t")
    return line


def pick_items(lines: list[str], patterns: list[str], limit: int = 6) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in lines:
        l = normalize_line(raw)
        if not l:
            continue
        if any(re.search(p, l, flags=re.IGNORECASE) for p in patterns):
            key = l.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(l)
            if len(out) >= limit:
                break
    return out


def extract_entities(text: str) -> set[str]:
    entities: set[str] = set()
    # Capitalized words / names / products.
    for m in re.findall(r"\b[A-Z][a-zA-Z0-9_+-]{2,}\b", text):
        entities.add(m.lower())
    # IDs and ticket/task references.
    for m in re.findall(r"\b(?:task|issue|pr|ticket)[\s:#-]*\d+\b", text, flags=re.IGNORECASE):
        entities.add(m.lower().replace(" ", ""))
    # Dates/numbers with units.
    for m in re.findall(r"\b\d+(?:\.\d+)?(?:%|h|hr|hrs|am|pm|days?|weeks?)\b", text, flags=re.IGNORECASE):
        entities.add(m.lower())
    return entities


def build_compression(cluster: Cluster) -> dict[str, Any]:
    all_lines: list[str] = []
    combined_text_parts: list[str] = []

    for e in cluster.entries:
        combined = e.text
        combined_text_parts.append(combined)
        parts = re.split(r"[\n\.]+", combined)
        all_lines.extend([p for p in parts if p and p.strip()])

    facts = pick_items(
        all_lines,
        patterns=[r"\b(is|are|was|were|has|have|had|updated|completed|deployed|fixed)\b", r"\b\d"],
        limit=7,
    )
    decisions = pick_items(
        all_lines,
        patterns=[r"\b(decid|chose|choice|plan|will|should|recommend|approved)\b"],
        limit=5,
    )
    actions = pick_items(
        all_lines,
        patterns=[r"\b(todo|action|follow up|next step|need to|pending|blocker|deadline)\b"],
        limit=6,
    )

    top_topics = [k for k, _ in cluster.feature_counts.most_common(4)]
    topic_label = ", ".join(top_topics) if top_topics else f"cluster-{cluster.id}"

    body_lines = [f"Topic: {topic_label}"]
    if facts:
        body_lines.append("Key facts:")
        body_lines.extend([f"- {x}" for x in facts])
    if decisions:
        body_lines.append("Decisions:")
        body_lines.extend([f"- {x}" for x in decisions])
    if actions:
        body_lines.append("Action items:")
        body_lines.extend([f"- {x}" for x in actions])

    if not facts and not decisions and not actions:
        fallback = [normalize_line(x) for x in all_lines[:8] if normalize_line(x)]
        if fallback:
            body_lines.append("Summary:")
            body_lines.extend([f"- {x}" for x in fallback])

    compressed_text = "\n".join(body_lines).strip()
    source_text = "\n".join(combined_text_parts)

    source_entities = extract_entities(source_text)
    compressed_entities = extract_entities(compressed_text)
    overlap = source_entities & compressed_entities

    if source_entities:
        fidelity = len(overlap) / len(source_entities)
    else:
        fidelity = 1.0 if compressed_text else 0.0

    # Penalize if we had explicit actions/decisions in source but missed all.
    src_has_decisions = bool(re.search(r"\b(decid|chose|approved|plan)\b", source_text, flags=re.IGNORECASE))
    src_has_actions = bool(re.search(r"\b(todo|follow up|next step|need to|pending|blocker)\b", source_text, flags=re.IGNORECASE))
    if src_has_decisions and not decisions:
        fidelity *= 0.9
    if src_has_actions and not actions:
        fidelity *= 0.9

    fidelity = max(0.0, min(1.0, round(fidelity, 4)))

    return {
        "topic": topic_label,
        "text": compressed_text,
        "facts": facts,
        "decisions": decisions,
        "actions": actions,
        "fidelity": fidelity,
        "source_entities": sorted(source_entities),
        "compressed_entities": sorted(compressed_entities),
        "entity_overlap": sorted(overlap),
    }


def insert_semantic(
    compression: dict[str, Any],
    cluster: Cluster,
    since_hours: int,
    dry_run: bool,
) -> bool:
    entry_ids = [e.id for e in cluster.entries]
    subject = f"memory_cluster:{cluster.id}"
    predicate = "daily_distillation"
    object_value = compression["text"]
    source_ref = f"episodic:{min(entry_ids)}-{max(entry_ids)}:h{since_hours}"
    fingerprint = fp(subject, predicate, object_value, source_ref)

    metadata = {
        "engine": "semantic-compression-v1",
        "entry_ids": entry_ids,
        "entry_count": len(entry_ids),
        "topic": compression["topic"],
        "facts": compression["facts"],
        "decisions": compression["decisions"],
        "actions": compression["actions"],
        "source_entities": compression["source_entities"],
        "compressed_entities": compression["compressed_entities"],
        "entity_overlap": compression["entity_overlap"],
    }

    confidence = max(0.50, min(0.98, 0.55 + compression["fidelity"] * 0.4))

    sql = f"""
    INSERT INTO cortana_memory_semantic
      (fact_type, subject, predicate, object_value, confidence, trust, stability,
       first_seen_at, last_seen_at, source_type, source_ref, fingerprint, metadata, fidelity_score)
    VALUES
      ('fact', {q(subject)}, {q(predicate)}, {q(object_value)},
       {confidence:.4f}, 0.850, 0.600, NOW(), NOW(),
       'semantic_compression', {q(source_ref)}, {q(fingerprint)}, {q(json.dumps(metadata))}::jsonb,
       {compression['fidelity']:.4f})
    ON CONFLICT (fact_type, subject, predicate, object_value)
    DO UPDATE SET
      last_seen_at = NOW(),
      source_type = EXCLUDED.source_type,
      source_ref = EXCLUDED.source_ref,
      fingerprint = EXCLUDED.fingerprint,
      metadata = EXCLUDED.metadata,
      confidence = EXCLUDED.confidence,
      fidelity_score = EXCLUDED.fidelity_score,
      active = TRUE;
    """

    if dry_run:
        return True
    psql(sql)
    return True


def main() -> None:
    ap = argparse.ArgumentParser(description="Compress recent episodic memories into semantic memory.")
    ap.add_argument("--since-hours", type=int, default=36, help="Lookback window in hours (recommended 24-48).")
    ap.add_argument("--dry-run", action="store_true", help="Analyze without writing to DB.")
    ap.add_argument("--min-cluster-size", type=int, default=1, help="Skip clusters smaller than this size.")
    args = ap.parse_args()

    since_hours = max(1, min(168, args.since_hours))

    ensure_fidelity_column()
    rows = fetch_recent_episodic(since_hours)
    if not rows:
        print(json.dumps({"ok": True, "message": "No episodic memories in lookback window.", "since_hours": since_hours}))
        return

    clusters = cluster_entries(rows)
    written = 0
    outputs: list[dict[str, Any]] = []

    for c in clusters:
        if len(c.entries) < args.min_cluster_size:
            continue
        comp = build_compression(c)
        insert_semantic(comp, c, since_hours=since_hours, dry_run=args.dry_run)
        written += 1
        outputs.append(
            {
                "cluster_id": c.id,
                "entry_ids": [e.id for e in c.entries],
                "entry_count": len(c.entries),
                "topic": comp["topic"],
                "fidelity": comp["fidelity"],
            }
        )

    out = {
        "ok": True,
        "dry_run": args.dry_run,
        "since_hours": since_hours,
        "episodic_entries": len(rows),
        "clusters_total": len(clusters),
        "clusters_written": written,
        "results": outputs,
    }
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
