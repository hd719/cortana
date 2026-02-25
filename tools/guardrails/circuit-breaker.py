#!/usr/bin/env python3
"""LLM provider circuit breaker with simple failover recommendation.

Features:
- Sliding window (last 50 requests) per provider
- Open on >=20% non-retryable error rate
- Retryable: 429, 500, 502, 503, 529
- Fatal: 401, 403 (flags provider for human page)
- Recovery: after cooldown, allow ~1% probe traffic
- Close only after 50 consecutive successes in half-open
- Tier rule: never downgrade from Tier 1 to Tier 2 in recommendations
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

STATE_PATH = Path("/Users/hd/clawd/memory/circuit-breaker-state.json")
WINDOW_SIZE = 50
TRIP_THRESHOLD = 0.20
DEFAULT_COOLDOWN_SEC = 60
RECOVERY_PROBE_PCT = 0.01
SUCCESS_TO_CLOSE = 50

RETRYABLE_CODES = {429, 500, 502, 503, 529}
FATAL_CODES = {401, 403}

TIER_MAP = {
    "opus": 1,
    "codex": 1,
    "sonnet": 2,
    "4o-mini": 2,
}
DEFAULT_ORDER = ["opus", "codex", "sonnet", "4o-mini"]


def now_ts() -> float:
    return time.time()


def iso(ts: float | None = None) -> str:
    dt = datetime.fromtimestamp(ts or now_ts(), tz=timezone.utc)
    return dt.isoformat()


def load_state() -> dict[str, Any]:
    if not STATE_PATH.exists():
        return {
            "version": 1,
            "updated_at": iso(),
            "config": {
                "window_size": WINDOW_SIZE,
                "trip_threshold": TRIP_THRESHOLD,
                "cooldown_sec": DEFAULT_COOLDOWN_SEC,
                "recovery_probe_pct": RECOVERY_PROBE_PCT,
                "success_to_close": SUCCESS_TO_CLOSE,
            },
            "providers": {},
        }
    try:
        data = json.loads(STATE_PATH.read_text())
        if not isinstance(data, dict):
            raise ValueError("invalid state")
        data.setdefault("config", {})
        data["config"].setdefault("window_size", WINDOW_SIZE)
        data["config"].setdefault("trip_threshold", TRIP_THRESHOLD)
        data["config"].setdefault("cooldown_sec", DEFAULT_COOLDOWN_SEC)
        data["config"].setdefault("recovery_probe_pct", RECOVERY_PROBE_PCT)
        data["config"].setdefault("success_to_close", SUCCESS_TO_CLOSE)
        data.setdefault("providers", {})
        return data
    except Exception:
        return {
            "version": 1,
            "updated_at": iso(),
            "config": {
                "window_size": WINDOW_SIZE,
                "trip_threshold": TRIP_THRESHOLD,
                "cooldown_sec": DEFAULT_COOLDOWN_SEC,
                "recovery_probe_pct": RECOVERY_PROBE_PCT,
                "success_to_close": SUCCESS_TO_CLOSE,
            },
            "providers": {},
        }


def save_state(state: dict[str, Any]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    state["updated_at"] = iso()
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True))
    os.replace(tmp, STATE_PATH)


def classify(status_code: int) -> str:
    if 200 <= status_code < 400:
        return "success"
    if status_code in FATAL_CODES:
        return "fatal"
    if status_code in RETRYABLE_CODES:
        return "retryable"
    if status_code >= 400:
        return "non_retryable"
    return "non_retryable"


def provider_state(state: dict[str, Any], provider: str) -> dict[str, Any]:
    providers = state["providers"]
    if provider not in providers:
        providers[provider] = {
            "provider": provider,
            "tier": TIER_MAP.get(provider, 2),
            "circuit": "closed",  # closed|open|half_open
            "opened_at": None,
            "half_open_since": None,
            "window": [],
            "metrics": {
                "total": 0,
                "retryable": 0,
                "non_retryable": 0,
                "fatal": 0,
                "success": 0,
                "non_retryable_rate": 0.0,
            },
            "consecutive_successes": 0,
            "needs_human_page": False,
            "last_error_code": None,
            "updated_at": iso(),
        }
    return providers[provider]


def recompute_metrics(p: dict[str, Any]) -> None:
    window = p.get("window", [])[-WINDOW_SIZE:]
    p["window"] = window
    total = len(window)
    retryable = sum(1 for x in window if x["kind"] == "retryable")
    non_retryable = sum(1 for x in window if x["kind"] in {"non_retryable", "fatal"})
    fatal = sum(1 for x in window if x["kind"] == "fatal")
    success = sum(1 for x in window if x["kind"] == "success")

    p["metrics"] = {
        "total": total,
        "retryable": retryable,
        "non_retryable": non_retryable,
        "fatal": fatal,
        "success": success,
        "non_retryable_rate": (non_retryable / total) if total else 0.0,
    }


def maybe_transition_for_time(p: dict[str, Any], cooldown_sec: int) -> None:
    if p["circuit"] != "open" or not p.get("opened_at"):
        return
    if now_ts() - float(p["opened_at"]) >= cooldown_sec:
        p["circuit"] = "half_open"
        p["half_open_since"] = now_ts()
        p["consecutive_successes"] = 0


def record_request(state: dict[str, Any], provider: str, status_code: int) -> dict[str, Any]:
    p = provider_state(state, provider)
    cfg = state["config"]
    cooldown_sec = int(cfg.get("cooldown_sec", DEFAULT_COOLDOWN_SEC))
    trip_threshold = float(cfg.get("trip_threshold", TRIP_THRESHOLD))
    success_to_close = int(cfg.get("success_to_close", SUCCESS_TO_CLOSE))

    maybe_transition_for_time(p, cooldown_sec)

    kind = classify(status_code)
    if kind == "fatal":
        p["needs_human_page"] = True
        p["last_error_code"] = status_code

    p["window"].append({
        "ts": now_ts(),
        "status_code": status_code,
        "kind": kind,
    })
    recompute_metrics(p)

    if p["circuit"] == "closed":
        if p["metrics"]["non_retryable_rate"] >= trip_threshold and p["metrics"]["total"] >= 5:
            p["circuit"] = "open"
            p["opened_at"] = now_ts()
            p["half_open_since"] = None
            p["consecutive_successes"] = 0
    elif p["circuit"] == "open":
        maybe_transition_for_time(p, cooldown_sec)
    elif p["circuit"] == "half_open":
        if kind == "success":
            p["consecutive_successes"] += 1
            if p["consecutive_successes"] >= success_to_close:
                p["circuit"] = "closed"
                p["opened_at"] = None
                p["half_open_since"] = None
                p["consecutive_successes"] = 0
                p["needs_human_page"] = False
        else:
            p["circuit"] = "open"
            p["opened_at"] = now_ts()
            p["half_open_since"] = None
            p["consecutive_successes"] = 0

    p["updated_at"] = iso()
    return p


def probe_allowed(provider: str, pct: float) -> bool:
    # Stable-ish 1% gate per second/provider.
    seed = f"{provider}:{int(time.time())}"
    h = hashlib.sha256(seed.encode()).hexdigest()
    bucket = int(h[:8], 16) / 0xFFFFFFFF
    return bucket < pct


def recommendation(state: dict[str, Any]) -> dict[str, Any]:
    cfg = state.get("config", {})
    cooldown_sec = int(cfg.get("cooldown_sec", DEFAULT_COOLDOWN_SEC))
    probe_pct = float(cfg.get("recovery_probe_pct", RECOVERY_PROBE_PCT))

    # Keep provider states time-fresh.
    for name in list(state.get("providers", {}).keys()):
        maybe_transition_for_time(state["providers"][name], cooldown_sec)

    # Never downgrade: only consider Tier 1 providers.
    tier1 = [p for p in DEFAULT_ORDER if TIER_MAP.get(p, 2) == 1]
    candidates = []
    for name in tier1:
        p = provider_state(state, name)
        c = p.get("circuit", "closed")
        if c == "closed":
            candidates.append((name, 0, p))
        elif c == "half_open" and probe_allowed(name, probe_pct):
            candidates.append((name, 1, p))

    if candidates:
        candidates.sort(key=lambda x: (x[1], -x[2].get("metrics", {}).get("success", 0), x[0]))
        chosen = candidates[0][0]
        return {
            "recommended_provider": chosen,
            "tier": 1,
            "reason": "tier1_available",
            "tier2_blocked_by_policy": True,
        }

    return {
        "recommended_provider": None,
        "tier": 1,
        "reason": "all_tier1_open_or_probe_not_allowed",
        "tier2_blocked_by_policy": True,
    }


def cmd_record(args: argparse.Namespace) -> int:
    state = load_state()
    if args.cooldown is not None:
        state["config"]["cooldown_sec"] = int(args.cooldown)

    provider = args.provider.strip()
    status_code = int(args.status_code)
    p = record_request(state, provider, status_code)
    rec = recommendation(state)
    save_state(state)

    out = {
        "provider": provider,
        "status_code": status_code,
        "classification": classify(status_code),
        "circuit": p["circuit"],
        "consecutive_successes": p["consecutive_successes"],
        "metrics": p["metrics"],
        "needs_human_page": p["needs_human_page"],
        "recommendation": rec,
    }
    print(json.dumps(out, indent=2))

    if status_code in FATAL_CODES:
        print(
            f"FATAL_AUTH_ERROR provider={provider} code={status_code} -> page human immediately",
            file=sys.stderr,
        )
    return 0


def cmd_status(_: argparse.Namespace) -> int:
    state = load_state()
    rec = recommendation(state)
    providers = state.get("providers", {})
    ordered = sorted(providers.keys(), key=lambda n: (TIER_MAP.get(n, 99), n))
    payload = {
        "state_path": str(STATE_PATH),
        "updated_at": state.get("updated_at"),
        "config": state.get("config", {}),
        "providers": [{"name": n, **providers[n]} for n in ordered],
        "recommendation": rec,
    }
    print(json.dumps(payload, indent=2))
    return 0


def cmd_recommend(_: argparse.Namespace) -> int:
    state = load_state()
    rec = recommendation(state)
    save_state(state)
    print(json.dumps(rec, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="LLM circuit breaker")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--record", nargs=2, metavar=("PROVIDER", "STATUS_CODE"), help="record request result")
    g.add_argument("--status", action="store_true", help="show circuit states")
    g.add_argument("--recommend", action="store_true", help="get current recommended provider")
    p.add_argument("--cooldown", type=int, default=None, help="override cooldown seconds for this run")
    return p


def main() -> int:
    args = build_parser().parse_args()
    if args.record:
        args.provider = args.record[0]
        args.status_code = int(args.record[1])
        return cmd_record(args)
    if args.status:
        return cmd_status(args)
    return cmd_recommend(args)


if __name__ == "__main__":
    raise SystemExit(main())
