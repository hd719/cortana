#!/usr/bin/env python3
"""Cluster repeated corrections and propose stronger rules.

- Reads correction rows from cortana_feedback
- Embeds with OpenAI text-embedding-3-small
- Clusters by cosine similarity
- Emits proposals when cluster size >= min-cluster
- Optionally logs proposals back into cortana_feedback
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
import urllib.request
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DB = "cortana"
DB_PATH = "/opt/homebrew/opt/postgresql@17/bin"

TARGET_FILES = {
    "preference": "MEMORY.md",
    "fact": "MEMORY.md",
    "tone": "SOUL.md",
    "behavior": "AGENTS.md",
    "correction": "AGENTS.md",
}

STOPWORDS = {
    "the", "and", "for", "with", "that", "this", "from", "into", "when", "where", "have", "has", "had",
    "was", "were", "are", "is", "be", "been", "being", "you", "your", "our", "not", "but", "can", "could",
    "should", "would", "will", "don", "did", "didnt", "dont", "about", "after", "before", "then", "than",
    "they", "them", "their", "always", "never", "must", "need", "using", "use", "used", "just", "more", "less",
}


@dataclass
class FeedbackRow:
    id: int
    feedback_type: str
    context: str
    lesson: str
    timestamp: str


@dataclass
class Proposal:
    cluster_size: int
    target_file: str
    proposed_rule: str
    supporting_feedback_ids: list[int]
    feedback_types: list[str]
    confidence: float


def _run_psql(sql: str) -> str:
    env = os.environ.copy()
    env["PATH"] = f"{DB_PATH}:{env.get('PATH', '')}"
    cmd = ["psql", DB, "-q", "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql]
    proc = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "psql failed")
    return proc.stdout.strip()


def _sql_escape(s: str) -> str:
    return s.replace("'", "''")


def _fetch_feedback(window_days: int | None = None) -> list[FeedbackRow]:
    where = "WHERE LOWER(feedback_type) = 'correction'"
    if window_days:
        where += f" AND timestamp > NOW() - INTERVAL '{int(window_days)} days'"

    raw = _run_psql(
        "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM ("
        "SELECT id, COALESCE(feedback_type,'') AS feedback_type, COALESCE(context,'') AS context, "
        "COALESCE(lesson,'') AS lesson, timestamp::text AS timestamp "
        f"FROM cortana_feedback {where} ORDER BY timestamp DESC"
        ") t;"
    )
    items = json.loads(raw or "[]")

    # Fallback: if there are no explicit correction rows, use all feedback rows.
    if not items:
        raw = _run_psql(
            "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM ("
            "SELECT id, COALESCE(feedback_type,'') AS feedback_type, COALESCE(context,'') AS context, "
            "COALESCE(lesson,'') AS lesson, timestamp::text AS timestamp "
            "FROM cortana_feedback ORDER BY timestamp DESC"
            ") t;"
        )
        items = json.loads(raw or "[]")

    rows = [
        FeedbackRow(
            id=int(i["id"]),
            feedback_type=(i.get("feedback_type") or "correction").lower(),
            context=i.get("context") or "",
            lesson=i.get("lesson") or "",
            timestamp=i.get("timestamp") or "",
        )
        for i in items
    ]
    return rows


def _load_openai_key() -> str:
    cfg_path = Path.home() / ".openclaw" / "openclaw.json"
    cfg = json.loads(cfg_path.read_text())
    key = cfg.get("models", {}).get("providers", {}).get("openai", {}).get("apiKey", "")
    if not key:
        raise RuntimeError(f"OpenAI apiKey missing in {cfg_path}")
    return key


def _embed_batch(texts: list[str], api_key: str) -> list[list[float]]:
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
    with urllib.request.urlopen(req, timeout=90) as resp:
        body = json.loads(resp.read().decode())
    data = body.get("data") or []
    if len(data) != len(texts):
        raise RuntimeError(f"embedding size mismatch: expected {len(texts)}, got {len(data)}")
    return [d["embedding"] for d in sorted(data, key=lambda x: x["index"])]


def _embed_all(texts: list[str], api_key: str, batch_size: int = 100) -> list[list[float]]:
    out: list[list[float]] = []
    for i in range(0, len(texts), batch_size):
        out.extend(_embed_batch(texts[i : i + batch_size], api_key))
    return out


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _cluster_indices(embeddings: list[list[float]], threshold: float) -> list[list[int]]:
    n = len(embeddings)
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for i in range(n):
        for j in range(i + 1, n):
            if _cosine(embeddings[i], embeddings[j]) >= threshold:
                union(i, j)

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return sorted(groups.values(), key=len, reverse=True)


def _keywords(rows: list[FeedbackRow]) -> list[str]:
    text = " ".join([f"{r.context} {r.lesson}" for r in rows]).lower()
    toks = re.findall(r"[a-z][a-z0-9_-]{2,}", text)
    counts = Counter(t for t in toks if t not in STOPWORDS)
    return [w for w, _ in counts.most_common(6)]


def _target_file(rows: list[FeedbackRow]) -> str:
    kind = Counter(r.feedback_type for r in rows).most_common(1)[0][0]
    return TARGET_FILES.get(kind, "AGENTS.md")


def _rule_text(rows: list[FeedbackRow]) -> str:
    lessons = [re.sub(r"\s+", " ", r.lesson.strip()) for r in rows if r.lesson.strip()]
    if lessons:
        common = Counter(lessons).most_common(1)[0][0]
        if len(common) > 180:
            common = common[:177] + "..."
        return f"Strengthen this rule: {common}"

    kws = _keywords(rows)
    if kws:
        return "Strengthen policy around repeated issue pattern: " + ", ".join(kws[:5])
    return "Strengthen policy around repeated correction pattern in recent feedback."


def _proposal_confidence(rows: list[FeedbackRow], embeddings: list[list[float]], idxs: list[int]) -> float:
    if len(idxs) <= 1:
        return 0.0
    sims: list[float] = []
    for i in range(len(idxs)):
        for j in range(i + 1, len(idxs)):
            sims.append(_cosine(embeddings[idxs[i]], embeddings[idxs[j]]))
    avg = sum(sims) / max(1, len(sims))
    size_bonus = min(0.2, 0.03 * len(idxs))
    return round(min(0.99, avg + size_bonus), 3)


def _build_proposals(rows: list[FeedbackRow], embeddings: list[list[float]], similarity_threshold: float, min_cluster: int) -> list[Proposal]:
    clusters = _cluster_indices(embeddings, similarity_threshold)
    proposals: list[Proposal] = []

    for idxs in clusters:
        if len(idxs) < min_cluster:
            continue
        cluster_rows = [rows[i] for i in idxs]
        target = _target_file(cluster_rows)
        rule = _rule_text(cluster_rows)
        conf = _proposal_confidence(rows, embeddings, idxs)
        proposals.append(
            Proposal(
                cluster_size=len(idxs),
                target_file=target,
                proposed_rule=rule,
                supporting_feedback_ids=[r.id for r in cluster_rows],
                feedback_types=sorted(set(r.feedback_type for r in cluster_rows)),
                confidence=conf,
            )
        )

    return sorted(proposals, key=lambda p: (p.cluster_size, p.confidence), reverse=True)


def _log_proposals(proposals: list[Proposal]) -> None:
    for p in proposals:
        context = json.dumps(
            {
                "source": "correction-strengthener",
                "cluster_size": p.cluster_size,
                "target_file": p.target_file,
                "supporting_feedback_ids": p.supporting_feedback_ids,
                "confidence": p.confidence,
            }
        )
        lesson = p.proposed_rule
        _run_psql(
            "INSERT INTO cortana_feedback (feedback_type, context, lesson, applied) VALUES "
            f"('correction', '{_sql_escape(context)}', '{_sql_escape(lesson)}', FALSE);"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="Auto-propose rule strengthening from repeated corrections.")
    parser.add_argument("--similarity-threshold", type=float, default=0.82)
    parser.add_argument("--min-cluster", type=int, default=3)
    parser.add_argument("--window-days", type=int, default=None)
    parser.add_argument("--log-to-db", action="store_true", help="Write proposals back to cortana_feedback")
    parser.add_argument("--json", action="store_true", help="Output JSON")
    args = parser.parse_args()

    rows = _fetch_feedback(window_days=args.window_days)
    if not rows:
        print("No feedback rows found.")
        return 0

    texts = [f"{r.feedback_type}\n{r.context}\n{r.lesson}".strip() for r in rows]
    api_key = _load_openai_key()
    embeddings = _embed_all(texts, api_key)

    proposals = _build_proposals(
        rows,
        embeddings,
        similarity_threshold=args.similarity_threshold,
        min_cluster=args.min_cluster,
    )

    if args.log_to_db and proposals:
        _log_proposals(proposals)

    output = {
        "rows_analyzed": len(rows),
        "similarity_threshold": args.similarity_threshold,
        "min_cluster": args.min_cluster,
        "proposals_found": len(proposals),
        "proposals": [
            {
                "cluster_size": p.cluster_size,
                "target_file": p.target_file,
                "proposed_rule": p.proposed_rule,
                "supporting_feedback_ids": p.supporting_feedback_ids,
                "feedback_types": p.feedback_types,
                "confidence": p.confidence,
            }
            for p in proposals
        ],
    }

    if args.json:
        print(json.dumps(output, indent=2))
    else:
        print(f"rows_analyzed={output['rows_analyzed']} proposals_found={output['proposals_found']}")
        for p in output["proposals"]:
            print(
                f"- target={p['target_file']} cluster={p['cluster_size']} conf={p['confidence']:.3f} ids={p['supporting_feedback_ids']}\n"
                f"  rule: {p['proposed_rule']}"
            )

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1)
