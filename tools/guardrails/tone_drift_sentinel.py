#!/usr/bin/env python3
"""
Tone Drift Sentinel

Purpose:
- Score candidate replies against Cortana tone rules from SOUL.md/MEMORY.md
- Detect banned patterns (heart emojis, filler openings, robotic/transactional phrasing)
- Emit machine-readable JSON decisions to stdout for event logging pipelines

Usage examples:
  python3 tools/guardrails/tone_drift_sentinel.py --text "Use this plan. It cuts risk and buys us time."
  python3 tools/guardrails/tone_drift_sentinel.py --file /tmp/reply.txt --pretty
  python3 tools/guardrails/tone_drift_sentinel.py --run-fixtures
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

FIXTURES_PATH = Path(__file__).with_name("tone_drift_fixtures.json")

HEART_EMOJI_RE = re.compile(
    r"[\u2764\u2665\U0001F90D-\U0001F90F\U0001F493-\U0001F49F\U0001F5A4\U0001FA75\U0001FA76]"
)

FILLER_OPENINGS = [
    r"^\s*great question[\s,!.]*",
    r"^\s*happy to help[\s,!.]*",
    r"^\s*absolutely[\s,!.]*",
    r"^\s*certainly[\s,!.]*",
    r"^\s*thanks for asking[\s,!.]*",
]

ROBOTIC_PATTERNS = [
    r"\bas an ai\b",
    r"\bi cannot\b",
    r"\bi am unable to\b",
    r"\bplease let me know if you have any further questions\b",
    r"\bin conclusion\b",
    r"\bhere(?:'s| is) a (?:summary|breakdown)\b",
    r"\bfirst,\s+second,\s+third\b",
]

WARMTH_MARKERS = {
    "you",
    "we",
    "us",
    "let's",
    "nice",
    "solid",
    "good",
    "proud",
    "got this",
    "on it",
}

WIT_MARKERS = {
    "plot twist",
    "clean kill",
    "spicy",
    "wild",
    "brutal",
    "ship it",
    "hot mess",
    "weird",
    "nope",
}

PERSONALITY_MARKERS = {
    "recommend",
    "do this",
    "skip",
    "instead",
    "chief",
    "on it",
    "course correction",
    "this breaks",
}

VAGUE_OPENINGS = [
    r"^\s*hello[\s,!.]*",
    r"^\s*hi there[\s,!.]*",
]


@dataclass
class Flag:
    code: str
    severity: float
    message: str


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def _contains_any(text: str, patterns: list[str]) -> bool:
    return any(re.search(p, text, re.IGNORECASE) for p in patterns)


def score_reply(text: str) -> dict[str, Any]:
    normalized = _normalize(text)
    flags: list[Flag] = []
    score = 1.0

    def penalize(code: str, severity: float, message: str) -> None:
        nonlocal score
        flags.append(Flag(code=code, severity=severity, message=message))
        score -= severity

    if not normalized:
        penalize("empty_reply", 0.9, "Reply is empty.")

    if HEART_EMOJI_RE.search(text):
        penalize("banned_heart_emoji", 0.6, "Heart emoji detected (policy ban).")

    if _contains_any(normalized, FILLER_OPENINGS):
        penalize("filler_opening", 0.25, "Reply opens with filler phrase.")

    if _contains_any(normalized, VAGUE_OPENINGS):
        penalize("weak_opening", 0.1, "Opening is generic instead of answer-first.")

    if _contains_any(normalized, ROBOTIC_PATTERNS):
        penalize("robotic_phrase", 0.35, "Robotic/transactional phrase detected.")

    if len(normalized.split()) > 120:
        penalize("too_verbose_default", 0.15, "Reply is verbose; default style should be brief.")

    if "?" in normalized[:90]:
        penalize("question_first", 0.1, "Reply likely opens with a question, not an answer.")

    warmth_hits = sum(1 for marker in WARMTH_MARKERS if marker in normalized)
    wit_hits = sum(1 for marker in WIT_MARKERS if marker in normalized)
    personality_hits = sum(1 for marker in PERSONALITY_MARKERS if marker in normalized)

    warmth_score = min(1.0, warmth_hits / 2)
    wit_score = min(1.0, wit_hits / 1)
    personality_score = min(1.0, personality_hits / 2)

    if warmth_score < 0.2:
        penalize("low_warmth", 0.12, "Low warmth/presence signal.")
    if wit_score < 0.1:
        penalize("low_wit", 0.08, "No wit/playful signal detected.")
    if personality_score < 0.2:
        penalize("low_personality", 0.12, "Weak recommendation/personality signature.")

    score = max(0.0, min(1.0, score))

    return {
        "score": round(score, 4),
        "dimensions": {
            "warmth": round(warmth_score, 4),
            "wit": round(wit_score, 4),
            "personality_presence": round(personality_score, 4),
        },
        "flags": [flag.__dict__ for flag in flags],
        "reply_length": len(text),
        "word_count": len(normalized.split()) if normalized else 0,
        "pass": score >= 0.7 and not any(f.code == "banned_heart_emoji" for f in flags),
    }


def emit(event: str, payload: dict[str, Any], pretty: bool = False) -> None:
    out = {"event": event, **payload}
    if pretty:
        print(json.dumps(out, indent=2, ensure_ascii=False))
    else:
        print(json.dumps(out, ensure_ascii=False))


def run_fixtures(pretty: bool = False) -> int:
    fixtures = json.loads(FIXTURES_PATH.read_text())
    passed = 0
    total = 0

    for group_name, tests in fixtures.items():
        for test in tests:
            total += 1
            result = score_reply(test["text"])

            expected_min = test.get("expected_min_score", 0.0)
            expected_max = test.get("expected_max_score", 1.0)
            expected_flags = set(test.get("expected_flags", []))
            actual_flags = {f["code"] for f in result["flags"]}

            ok = expected_min <= result["score"] <= expected_max and expected_flags.issubset(actual_flags)
            if ok:
                passed += 1

            emit(
                "tone_fixture_result",
                {
                    "group": group_name,
                    "name": test["name"],
                    "ok": ok,
                    "expected_min_score": expected_min,
                    "expected_max_score": expected_max,
                    "actual_score": result["score"],
                    "expected_flags": sorted(expected_flags),
                    "actual_flags": sorted(actual_flags),
                },
                pretty=pretty,
            )

    emit("tone_fixture_summary", {"passed": passed, "total": total, "success": passed == total}, pretty=pretty)
    return 0 if passed == total else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Score reply text for tone drift against Cortana guardrails.")
    input_group = parser.add_mutually_exclusive_group(required=False)
    input_group.add_argument("--text", help="Candidate reply text")
    input_group.add_argument("--file", type=Path, help="Path to file containing candidate reply")
    parser.add_argument("--run-fixtures", action="store_true", help="Run regression fixtures")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if args.run_fixtures:
        return run_fixtures(pretty=args.pretty)

    if not args.text and not args.file:
        print("Provide --text or --file (or --run-fixtures).", file=sys.stderr)
        return 2

    text = args.text or args.file.read_text()
    result = score_reply(text)
    emit("tone_drift_decision", result, pretty=args.pretty)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
