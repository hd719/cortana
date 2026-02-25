#!/usr/bin/env python3
"""Trade Guardrail Engine v2 (#106).

Evaluates a candidate trade against strategy, concentration, and readiness constraints.
"""

from __future__ import annotations

import argparse
import json
import urllib.request
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")


@dataclass
class CheckResult:
    name: str
    passed: bool
    score: float
    detail: str
    hard_stop: bool = False


def http_json(url: str, timeout: int = 7) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "trade-guardrails/2.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def load_json_blob(raw: str | None, path: str | None, fallback: dict[str, Any] | None = None) -> dict[str, Any]:
    if raw:
        return json.loads(raw)
    if path:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return fallback or {}


def whoop_readiness() -> float:
    for u in ["http://localhost:3033/whoop/recovery", "http://localhost:3033/whoop/latest", "http://localhost:3033"]:
        try:
            js = http_json(u)
            if isinstance(js, dict):
                for k in ("recovery", "recovery_score", "score", "whoop_recovery"):
                    if k in js:
                        val = float(js[k])
                        return val * 100 if val <= 1 else val
                latest = js.get("latest")
                if isinstance(latest, dict):
                    for k in ("recovery", "recovery_score", "score"):
                        if k in latest:
                            val = float(latest[k])
                            return val * 100 if val <= 1 else val
        except Exception:
            continue
    return 55.0


def portfolio_data() -> dict[str, Any]:
    try:
        js = http_json("http://localhost:3033/alpaca/portfolio")
        return js if isinstance(js, dict) else {}
    except Exception:
        return {}


def position_concentration(portfolio: dict[str, Any], symbol: str, proposed_notional: float) -> tuple[float, float, bool]:
    positions = portfolio.get("positions") if isinstance(portfolio.get("positions"), list) else []
    equity = float(portfolio.get("equity") or portfolio.get("portfolio_value") or portfolio.get("net_liquidation") or 0.0)
    if equity <= 0:
        mv = [abs(float(p.get("market_value") or 0.0)) for p in positions]
        equity = sum(mv) if mv else 0.0

    if equity <= 0:
        return 0.0, 0.0, False

    current = 0.0
    max_existing = 0.0
    for p in positions:
        mv = abs(float(p.get("market_value") or 0.0))
        max_existing = max(max_existing, mv / equity)
        if str(p.get("symbol", "")).upper() == symbol.upper():
            current = mv

    post_weight = (current + proposed_notional) / equity
    return max_existing, post_weight, True


def risk_reward_check(setup: dict[str, Any]) -> CheckResult:
    entry = float(setup.get("entry") or 0.0)
    stop = float(setup.get("stop") or 0.0)
    target = float(setup.get("target") or 0.0)
    if not all([entry, stop, target]):
        return CheckResult("risk_reward", False, 0.0, "Missing entry/stop/target", hard_stop=True)
    risk = abs(entry - stop)
    reward = abs(target - entry)
    if risk <= 0:
        return CheckResult("risk_reward", False, 0.0, "Invalid stop distance", hard_stop=True)
    rr = reward / risk
    return CheckResult(
        "risk_reward",
        rr >= 2.0,
        min(rr / 3.0, 1.0),
        f"R/R={rr:.2f} ({'meets' if rr >= 2 else 'below'} 2.0 threshold)",
        hard_stop=rr < 1.5,
    )


def canslim_check(setup: dict[str, Any]) -> CheckResult:
    # Accept either explicit score or individual signals from backtester.
    if "canslim_score" in setup:
        score = float(setup.get("canslim_score") or 0)
    else:
        keys = ["current_quarter_eps", "annual_eps_growth", "new_high", "supply_demand", "leader", "institutional", "market_uptrend"]
        flags = [1.0 if bool(setup.get(k)) else 0.0 for k in keys]
        score = 100.0 * (sum(flags) / len(flags)) if flags else 0.0
    passed = score >= 70
    return CheckResult("canslim_quality", passed, score / 100.0, f"CANSLIM quality {score:.0f}/100", hard_stop=score < 50)


def regime_fit_check(setup: dict[str, Any]) -> CheckResult:
    regime = str(setup.get("market_regime") or "unknown").lower()
    style = str(setup.get("setup_style") or "breakout").lower()
    ok = True
    if regime in {"risk_off", "bear", "high_vol"} and style in {"breakout", "momentum"}:
        ok = False
    score = 0.8 if ok else 0.2
    return CheckResult("market_regime_fit", ok, score, f"Regime={regime}, style={style}")


def chasing_check(setup: dict[str, Any]) -> CheckResult:
    entry = float(setup.get("entry") or 0.0)
    pivot = float(setup.get("pivot") or entry)
    ext = ((entry - pivot) / pivot) * 100 if pivot > 0 else 0.0
    passed = ext <= 3.0
    return CheckResult(
        "no_chasing",
        passed,
        1.0 if passed else max(0.0, 1.0 - (ext - 3) / 5),
        f"Entry is {ext:.2f}% above pivot",
        hard_stop=ext > 5.0,
    )


def readiness_check(recovery: float) -> CheckResult:
    passed = recovery >= 45
    return CheckResult(
        "readiness_window",
        passed,
        min(recovery / 100.0, 1.0),
        f"Whoop recovery={recovery:.0f}",
        hard_stop=recovery < 35,
    )


def concentration_check(max_existing: float, post_weight: float, cap: float, known: bool) -> CheckResult:
    if not known:
        return CheckResult(
            "concentration_cap",
            True,
            0.5,
            "Portfolio equity unavailable; concentration check downgraded.",
            hard_stop=False,
        )
    passed = post_weight <= cap
    detail = f"Post-trade weight={post_weight:.1%}, cap={cap:.1%}, current max holding={max_existing:.1%}"
    return CheckResult(
        "concentration_cap",
        passed,
        max(0.0, 1.0 - max(0.0, post_weight - cap) * 8),
        detail,
        hard_stop=post_weight > (cap + 0.05),
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Trade Guardrail Engine v2")
    ap.add_argument("--setup-json", help="Inline JSON for proposed trade setup")
    ap.add_argument("--setup-file", help="Path to JSON file for proposed trade setup")
    ap.add_argument("--symbol", default="", help="Ticker if not in setup JSON")
    ap.add_argument("--notional", type=float, default=0.0, help="Proposed trade notional ($)")
    ap.add_argument("--concentration-cap", type=float, default=0.25, help="Max single-position weight")
    args = ap.parse_args()

    setup = load_json_blob(args.setup_json, args.setup_file, fallback={})
    symbol = str(setup.get("symbol") or args.symbol).upper()
    notional = float(setup.get("notional") or args.notional)

    portfolio = portfolio_data()
    recovery = whoop_readiness()

    max_existing, post_weight, concentration_known = position_concentration(portfolio, symbol, notional)

    checks = [
        canslim_check(setup),
        regime_fit_check(setup),
        risk_reward_check(setup),
        chasing_check(setup),
        readiness_check(recovery),
        concentration_check(max_existing, post_weight, args.concentration_cap, concentration_known),
    ]

    hard_stops = [c for c in checks if c.hard_stop and not c.passed]
    passed = all(c.passed for c in checks) and not hard_stops
    quality = round(sum(c.score for c in checks) / len(checks), 3) if checks else 0.0

    verdict = {
        "generated_at": datetime.now(timezone.utc).astimezone(ET).isoformat(),
        "symbol": symbol,
        "proposed_notional": notional,
        "verdict": "PASS" if passed else "FAIL",
        "quality_score": quality,
        "rationale": [c.detail for c in checks if not c.passed][:4] or ["All guardrails satisfied."],
        "hard_stops": [c.name for c in hard_stops],
        "checks": [asdict(c) for c in checks],
        "context": {
            "whoop_recovery": recovery,
            "portfolio_concentration_post_trade": post_weight,
            "concentration_cap": args.concentration_cap,
        },
    }

    print(json.dumps(verdict, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
