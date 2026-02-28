#!/usr/bin/env python3
"""Precompute Oracle cache for the 6AM brief.

Runs at 5:30 AM (launchd) to prefetch likely morning asks:
- weather (Warren, NJ)
- calendar events (today)
- portfolio snapshot
- fitness recovery
- email highlights

Cache is stored at ~/openclaw/tmp/oracle-cache.json with per-source TTL.
Also exposes a lightweight read API:
  python3 precompute.py run
  python3 precompute.py read [weather|calendar|portfolio|recovery|email]
  python3 precompute.py status
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

ROOT = Path("/Users/hd/openclaw")
CACHE_PATH = ROOT / "tmp" / "oracle-cache.json"
LOG_PATH = ROOT / "tmp" / "oracle-precompute.log"
ET_TZ = "America/New_York"

DEFAULT_TTLS = {
    "weather": 3 * 60 * 60,
    "calendar": 90 * 60,
    "portfolio": 45 * 60,
    "recovery": 90 * 60,
    "email": 30 * 60,
}


@dataclass
class SourceResult:
    source: str
    ok: bool
    fetched_at: str
    expires_at: str
    ttl_seconds: int
    data: Any = None
    error: str | None = None


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.isoformat()


def run_cmd(cmd: list[str], timeout: int = 20) -> str:
    env = os.environ.copy()
    env["PATH"] = "/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/local/bin:/usr/bin:/bin"
    p = subprocess.run(cmd, text=True, capture_output=True, timeout=timeout, env=env)
    if p.returncode != 0:
        err = (p.stderr or p.stdout or "command failed").strip()
        raise RuntimeError(err)
    return p.stdout.strip()


def read_json_url(url: str, timeout: int = 10, headers: dict[str, str] | None = None) -> Any:
    req = Request(url, headers=headers or {"User-Agent": "oracle-precompute/1.0"})
    with urlopen(req, timeout=timeout) as r:  # noqa: S310 (trusted public endpoint)
        return json.loads(r.read().decode("utf-8"))


def fetch_weather() -> Any:
    # Primary: wttr.in text (fast + human-readable)
    try:
        wttr = run_cmd(["curl", "-fsSL", "https://wttr.in/Warren,NJ?format=j1"], timeout=12)
        return {"provider": "wttr.in", "payload": json.loads(wttr)}
    except Exception:
        # Fallback: Open-Meteo (documented local fallback)
        om_url = (
            "https://api.open-meteo.com/v1/forecast"
            "?latitude=40.63&longitude=-74.49"
            "&current_weather=true"
            "&temperature_unit=fahrenheit"
            "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode"
            "&timezone=America/New_York&forecast_days=2"
        )
        payload = read_json_url(om_url, timeout=12)
        return {"provider": "open-meteo", "payload": payload}


def fetch_calendar() -> Any:
    raw = run_cmd(["gog", "cal", "list", "--days", "1", "--plain"], timeout=20)
    lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
    return {"provider": "gog", "events": lines, "count": len(lines)}


def fetch_portfolio() -> Any:
    # Preferred path: Alpaca account snapshot if credentials exist.
    key = os.getenv("ALPACA_API_KEY") or os.getenv("APCA_API_KEY_ID")
    secret = os.getenv("ALPACA_API_SECRET") or os.getenv("APCA_API_SECRET_KEY")
    base = os.getenv("ALPACA_BASE_URL", "https://paper-api.alpaca.markets")

    if key and secret:
        headers = {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret}
        acct = read_json_url(f"{base.rstrip('/')}/v2/account", timeout=10, headers=headers)
        positions = read_json_url(f"{base.rstrip('/')}/v2/positions", timeout=12, headers=headers)
        return {
            "provider": "alpaca",
            "equity": acct.get("equity"),
            "cash": acct.get("cash"),
            "buying_power": acct.get("buying_power"),
            "positions_count": len(positions) if isinstance(positions, list) else 0,
            "top_positions": positions[:10] if isinstance(positions, list) else [],
        }

    # Fallback: known long-term snapshot from memory table context.
    mem = run_cmd(
        [
            "psql",
            "cortana",
            "-At",
            "-c",
            "SELECT metadata::text FROM cortana_tasks WHERE title ILIKE '%portfolio%' ORDER BY created_at DESC LIMIT 1;",
        ],
        timeout=8,
    )
    return {
        "provider": "fallback",
        "note": "Alpaca credentials not available in environment during precompute run.",
        "latest_task_metadata": mem or None,
    }


def fetch_recovery() -> Any:
    # Try local fitness service endpoints (best-effort).
    endpoints = [
        "http://localhost:3033/whoop/recovery/latest",
        "http://localhost:3033/fitness/recovery",
        "http://localhost:3033/tonal/recovery",
        "http://localhost:3033/tonal/health",
    ]
    errors = []
    for ep in endpoints:
        try:
            out = run_cmd(["curl", "-fsSL", "--max-time", "8", ep], timeout=10)
            try:
                payload = json.loads(out)
            except Exception:
                payload = {"raw": out}
            return {"provider": "local-fitness-service", "endpoint": ep, "payload": payload}
        except Exception as e:  # noqa: BLE001
            errors.append(f"{ep}: {e}")

    # Fallback: no service available; return a structured failure payload.
    return {
        "provider": "fallback",
        "note": "No local fitness endpoint responded during precompute.",
        "attempts": errors,
    }


def fetch_email() -> Any:
    # Pull lightweight unread highlights likely relevant to morning triage.
    queries = [
        "is:unread newer_than:3d -category:promotions -category:social",
        "is:unread newer_than:1d",
    ]

    last_error = None
    for q in queries:
        commands = [
            ["gog", "gmail", "search", "--query", q, "--max", "15", "--json"],
            ["gog", "gmail", "search", q, "--max", "15", "--json"],
        ]
        for cmd in commands:
            try:
                raw = run_cmd(cmd, timeout=20)
                payload = json.loads(raw) if raw else []
                if isinstance(payload, dict):
                    for key in ("messages", "results", "items", "threads"):
                        if isinstance(payload.get(key), list):
                            payload = payload[key]
                            break
                if not isinstance(payload, list):
                    payload = []
                highlights = []
                for item in payload[:10]:
                    if not isinstance(item, dict):
                        continue
                    highlights.append(
                        {
                            "id": item.get("id") or item.get("messageId"),
                            "threadId": item.get("threadId") or item.get("thread_id"),
                            "from": item.get("from") or item.get("sender"),
                            "subject": item.get("subject"),
                            "date": item.get("date") or item.get("timestamp"),
                            "snippet": item.get("snippet") or item.get("preview"),
                        }
                    )
                return {
                    "provider": "gog",
                    "query": q,
                    "count": len(highlights),
                    "highlights": highlights,
                }
            except Exception as e:  # noqa: BLE001
                last_error = str(e)

    raise RuntimeError(last_error or "failed to fetch email highlights")


def collect() -> dict[str, SourceResult]:
    handlers = {
        "weather": fetch_weather,
        "calendar": fetch_calendar,
        "portfolio": fetch_portfolio,
        "recovery": fetch_recovery,
        "email": fetch_email,
    }

    results: dict[str, SourceResult] = {}
    t0 = now_utc()
    for name, fn in handlers.items():
        ttl = DEFAULT_TTLS[name]
        fetched_at = now_utc()
        expires_at = fetched_at + timedelta(seconds=ttl)
        try:
            data = fn()
            ok = True
            err = None
        except Exception as e:  # noqa: BLE001
            data = None
            ok = False
            err = str(e)

        results[name] = SourceResult(
            source=name,
            ok=ok,
            fetched_at=iso(fetched_at),
            expires_at=iso(expires_at),
            ttl_seconds=ttl,
            data=data,
            error=err,
        )

    # Global TTL: minimum of individual expiries.
    min_expiry = min(datetime.fromisoformat(r.expires_at) for r in results.values())
    payload = {
        "generated_at": iso(t0),
        "expires_at": iso(min_expiry),
        "ttl_seconds": int((min_expiry - t0).total_seconds()),
        "sources": {k: vars(v) for k, v in results.items()},
    }
    return payload


def cache_write(payload: dict[str, Any]) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(f"[{datetime.now().isoformat()}] precompute run ok={summary_ok(payload)}\n")


def summary_ok(payload: dict[str, Any]) -> dict[str, bool]:
    out: dict[str, bool] = {}
    for name, src in payload.get("sources", {}).items():
        out[name] = bool(src.get("ok"))
    return out


def cache_read() -> dict[str, Any]:
    if not CACHE_PATH.exists():
        raise FileNotFoundError(f"cache not found: {CACHE_PATH}")
    return json.loads(CACHE_PATH.read_text(encoding="utf-8"))


def is_stale(entry: dict[str, Any]) -> bool:
    exp = entry.get("expires_at")
    if not exp:
        return True
    return datetime.fromisoformat(exp) < now_utc()


def cmd_run(_: argparse.Namespace) -> int:
    payload = collect()
    cache_write(payload)
    print(json.dumps({"cache": str(CACHE_PATH), "ok": summary_ok(payload)}, indent=2))
    return 0


def cmd_read(args: argparse.Namespace) -> int:
    cache = cache_read()
    if args.section:
        src = cache.get("sources", {}).get(args.section)
        if not src:
            raise SystemExit(f"unknown section: {args.section}")
        if is_stale(src) and not args.allow_stale:
            raise SystemExit(f"section '{args.section}' is stale (pass --allow-stale)")
        print(json.dumps(src, indent=2))
        return 0

    # full cache read
    if is_stale(cache) and not args.allow_stale:
        raise SystemExit("oracle cache is stale (pass --allow-stale)")
    print(json.dumps(cache, indent=2))
    return 0


def cmd_status(_: argparse.Namespace) -> int:
    try:
        cache = cache_read()
    except FileNotFoundError:
        print(json.dumps({"exists": False, "cache": str(CACHE_PATH)}, indent=2))
        return 1

    status = {
        "exists": True,
        "generated_at": cache.get("generated_at"),
        "expires_at": cache.get("expires_at"),
        "stale": is_stale(cache),
        "sources": {
            name: {
                "ok": bool(src.get("ok")),
                "stale": is_stale(src),
                "expires_at": src.get("expires_at"),
            }
            for name, src in cache.get("sources", {}).items()
        },
    }
    print(json.dumps(status, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Precompute Oracle cache for morning brief")
    sub = p.add_subparsers(dest="cmd", required=True)

    run = sub.add_parser("run", help="prefetch all sources and write cache")
    run.set_defaults(func=cmd_run)

    read = sub.add_parser("read", help="read cache or a section")
    read.add_argument("section", nargs="?", choices=["weather", "calendar", "portfolio", "recovery", "email"])
    read.add_argument("--allow-stale", action="store_true", help="allow stale cache reads")
    read.set_defaults(func=cmd_read)

    status = sub.add_parser("status", help="cache health summary")
    status.set_defaults(func=cmd_status)

    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
