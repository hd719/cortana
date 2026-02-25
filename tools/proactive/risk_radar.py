#!/usr/bin/env python3
"""Cross-Signal Risk Radar (#103).

Fuses:
- Whoop recovery from localhost:3033
- Calendar load from gog
- Alpaca stats from localhost:3033/alpaca/stats

Outputs JSON designed for morning brief integration.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import urllib.request
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from statistics import mean
from typing import Any
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")


@dataclass
class WindowRisk:
    start: str
    end: str
    label: str
    score: float
    confidence: float
    factors: dict[str, Any]
    mitigations: list[str]


def http_json(url: str, timeout: int = 7) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "risk-radar/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def parse_dt(v: str | None) -> datetime | None:
    if not v:
        return None
    try:
        if v.endswith("Z"):
            return datetime.fromisoformat(v.replace("Z", "+00:00")).astimezone(ET)
        dt = datetime.fromisoformat(v)
        return dt if dt.tzinfo else dt.replace(tzinfo=ET)
    except Exception:
        return None


def gog_events(hours: int) -> list[dict[str, Any]]:
    end = (datetime.now(timezone.utc).astimezone(ET) + timedelta(hours=hours)).date().isoformat()
    cmd = [
        "gog", "calendar", "events", "primary", "--from", "today", "--to", end, "--json"
    ]
    p = subprocess.run(cmd, text=True, capture_output=True)
    if p.returncode != 0 or not p.stdout.strip():
        return []
    try:
        data = json.loads(p.stdout)
        return data if isinstance(data, list) else (data.get("events") or [])
    except Exception:
        return []


def whoop_recovery() -> dict[str, Any]:
    candidates = [
        "http://localhost:3033/whoop/recovery",
        "http://localhost:3033/whoop/latest",
        "http://localhost:3033/whoop",
        "http://localhost:3033/recovery",
        "http://localhost:3033",
    ]
    for url in candidates:
        try:
            js = http_json(url)
            if isinstance(js, dict):
                return js
        except Exception:
            continue
    return {}


def alpaca_stats() -> dict[str, Any]:
    try:
        js = http_json("http://localhost:3033/alpaca/stats")
        return js if isinstance(js, dict) else {}
    except Exception:
        return {}


def normalize_recovery(payload: dict[str, Any]) -> float | None:
    keys = ["recovery", "recovery_score", "score", "whoop_recovery"]
    for k in keys:
        if k in payload:
            try:
                val = float(payload[k])
                return val * 100 if val <= 1 else val
            except Exception:
                pass
    nested = payload.get("latest") if isinstance(payload.get("latest"), dict) else None
    if nested:
        return normalize_recovery(nested)
    return None


def normalize_volatility(payload: dict[str, Any]) -> float:
    # Prefer explicit volatility fields; fallback to drawdown/variance proxies.
    for k in ("market_volatility", "volatility", "vix", "vol_score"):
        if k in payload:
            try:
                val = float(payload[k])
                return val if val <= 100 else 100.0
            except Exception:
                pass
    if "daily_pnl_pct" in payload:
        try:
            return min(abs(float(payload["daily_pnl_pct"])) * 4, 100.0)
        except Exception:
            pass
    return 50.0


def calendar_load(events: list[dict[str, Any]], horizon_h: int) -> dict[str, Any]:
    now = datetime.now(timezone.utc).astimezone(ET)
    cutoff = now + timedelta(hours=horizon_h)
    parsed: list[tuple[datetime, datetime, str]] = []
    for ev in events:
        s = (ev.get("start") or {}) if isinstance(ev.get("start"), dict) else {"dateTime": ev.get("start")}
        e = (ev.get("end") or {}) if isinstance(ev.get("end"), dict) else {"dateTime": ev.get("end")}
        st = parse_dt(s.get("dateTime") or s.get("date"))
        en = parse_dt(e.get("dateTime") or e.get("date")) or (st + timedelta(hours=1) if st else None)
        if not st or not en:
            continue
        if st < now or st > cutoff:
            continue
        parsed.append((st, en, str(ev.get("summary") or "Untitled")))

    total_minutes = sum(max(0, int((en - st).total_seconds() / 60)) for st, en, _ in parsed)
    switch_penalty = max(0, len(parsed) - 2) * 10
    heavy_titles = sum(1 for _, _, t in parsed if any(k in t.lower() for k in ["interview", "review", "demo", "deadline", "client", "presentation"]))
    load_score = min((total_minutes / (horizon_h * 60)) * 100 + switch_penalty + heavy_titles * 6, 100)

    return {
        "events_count": len(parsed),
        "total_minutes": total_minutes,
        "high_cognitive_events": heavy_titles,
        "load_score": round(load_score, 2),
        "events": [{"start": st.isoformat(), "end": en.isoformat(), "title": t} for st, en, t in parsed],
    }


def mitigations(rscore: float, cscore: float, vscore: float) -> list[str]:
    out: list[str] = []
    if rscore < 45 and cscore > 55:
        out.append("Protect a 30–45m prep block before first high-cognitive meeting.")
    if rscore < 50 and vscore > 60:
        out.append("Delay discretionary trades until after first 90 minutes of market open.")
    if rscore < 40:
        out.append("Set caffeine cutoff by 2pm ET and enforce early wind-down tonight.")
    if cscore > 70:
        out.append("Convert at least one non-critical meeting to async update.")
    if vscore > 70:
        out.append("Reduce order size by 25–40% and require 2:1 reward/risk minimum.")
    return out or ["No major interventions required; keep standard risk controls."]


def compute_windows(horizon_h: int, rscore: float, cal: dict[str, Any], vol: float) -> list[WindowRisk]:
    now = datetime.now(timezone.utc).astimezone(ET)
    windows: list[WindowRisk] = []
    cal_events = cal.get("events") or []

    if cal_events:
        for ev in cal_events[:8]:
            st = parse_dt(ev.get("start"))
            en = parse_dt(ev.get("end"))
            if not st or not en:
                continue
            event_load = 70 if any(k in str(ev.get("title", "")).lower() for k in ["review", "client", "deadline", "presentation"]) else 50
            risk = min(0.45 * (100 - rscore) + 0.30 * event_load + 0.25 * vol, 100)
            conf = min(0.55 + (0.15 if rscore < 50 else 0) + (0.10 if vol > 60 else 0), 0.92)
            windows.append(WindowRisk(
                start=st.isoformat(),
                end=en.isoformat(),
                label=f"{ev.get('title', 'Calendar window')}",
                score=round(risk, 2),
                confidence=round(conf, 2),
                factors={"recovery_score": rscore, "event_load": event_load, "market_volatility": vol},
                mitigations=mitigations(rscore, event_load, vol),
            ))
    else:
        end = now + timedelta(hours=min(4, horizon_h))
        risk = min(0.60 * (100 - rscore) + 0.40 * vol, 100)
        windows.append(WindowRisk(
            start=now.isoformat(),
            end=end.isoformat(),
            label="General trading/decision window",
            score=round(risk, 2),
            confidence=0.64,
            factors={"recovery_score": rscore, "calendar_load": cal.get("load_score", 0), "market_volatility": vol},
            mitigations=mitigations(rscore, cal.get("load_score", 0), vol),
        ))

    windows.sort(key=lambda w: w.score, reverse=True)
    return windows


def main() -> int:
    ap = argparse.ArgumentParser(description="Cross-signal risk radar for morning brief integration")
    ap.add_argument("--horizon-hours", type=int, default=16, help="How far ahead to scan for risk windows")
    ap.add_argument("--json", action="store_true", help="Emit JSON (default true)")
    args = ap.parse_args()

    whoop = whoop_recovery()
    recovery = normalize_recovery(whoop)
    if recovery is None:
        recovery = 55.0

    calendar = calendar_load(gog_events(args.horizon_hours), args.horizon_hours)
    stats = alpaca_stats()
    vol = normalize_volatility(stats)

    combined = min(0.40 * (100 - recovery) + 0.35 * calendar["load_score"] + 0.25 * vol, 100)
    confidence_parts = [0.6]
    if whoop:
        confidence_parts.append(0.15)
    if calendar.get("events_count", 0) > 0:
        confidence_parts.append(0.15)
    if stats:
        confidence_parts.append(0.10)
    confidence = round(min(sum(confidence_parts), 0.95), 2)

    risk_windows = compute_windows(args.horizon_hours, recovery, calendar, vol)
    top = risk_windows[0] if risk_windows else None

    result = {
        "generated_at": datetime.now(timezone.utc).astimezone(ET).isoformat(),
        "horizon_hours": args.horizon_hours,
        "inputs": {
            "whoop_available": bool(whoop),
            "calendar_events": calendar.get("events_count", 0),
            "alpaca_stats_available": bool(stats),
        },
        "scores": {
            "recovery_score": round(recovery, 2),
            "calendar_load_score": calendar.get("load_score", 0),
            "market_volatility_score": round(vol, 2),
            "combined_risk_score": round(combined, 2),
            "confidence": confidence,
        },
        "risk_windows": [asdict(w) for w in risk_windows],
        "high_risk_detected": bool(top and top.score >= 65),
        "priority_mitigations": (top.mitigations[:3] if top else []),
        "morning_brief": {
            "headline": (
                "High-friction day: protect decision quality windows."
                if combined >= 65 else "Risk posture stable: execute plan with normal controls."
            ),
            "one_liner": f"Recovery {recovery:.0f}, Calendar load {calendar.get('load_score', 0):.0f}, Volatility {vol:.0f}.",
        },
    }

    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
