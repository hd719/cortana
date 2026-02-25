#!/usr/bin/env python3
"""Unified market intelligence pipeline.

Modes:
  --ticker NVDA   single-ticker deep dive
  --portfolio     Alpaca portfolio sentiment scan
  --pulse         broad market pulse
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import shlex
import subprocess
import sys
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path("/Users/hd/clawd")
STOCK_ANALYSIS_DIR = ROOT / "skills" / "stock-analysis"
MARKET_STATUS_SCRIPT = ROOT / "skills" / "markets" / "check_market_status.sh"
ALPACA_PORTFOLIO_URL = "http://localhost:3033/alpaca/portfolio"

BULLISH_WORDS = {
    "bullish", "buy", "long", "calls", "breakout", "rally", "beat", "upside", "moon", "rip",
    "accumulate", "upgrade", "outperform", "strong", "squeeze", "green",
}
BEARISH_WORDS = {
    "bearish", "sell", "short", "puts", "dump", "crash", "miss", "downside", "rug", "fade",
    "downgrade", "underperform", "weak", "red", "recession", "overvalued",
}

TICKER_RE = re.compile(r"\$?[A-Z]{2,5}")


def run(cmd: list[str], timeout: int = 30, cwd: Path | None = None) -> tuple[int, str, str]:
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=str(cwd) if cwd else None)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def fetch_json(url: str, timeout: int = 15) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "market-intel/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def stock_quote(symbol: str) -> dict[str, Any]:
    cmd = [
        "uv", "run", "src/stock_analysis/main.py", "analyze", symbol.upper(), "--json",
    ]
    code, out, err = run(cmd, timeout=30, cwd=STOCK_ANALYSIS_DIR)
    if code != 0 or not out:
        raise RuntimeError(f"stock-analysis failed: {err or out}")
    data = json.loads(out)
    if data.get("error"):
        raise RuntimeError(data["error"])
    return data


def stock_fundamentals(symbol: str) -> dict[str, Any]:
    q = urllib.parse.quote(symbol.upper())
    modules = "summaryDetail,defaultKeyStatistics,financialData"
    url = f"https://query1.finance.yahoo.com/v10/finance/quoteSummary/{q}?modules={modules}"
    payload = fetch_json(url)
    result = (((payload.get("quoteSummary") or {}).get("result") or [{}])[0])

    def raw(section: str, field: str) -> Any:
        val = (result.get(section) or {}).get(field)
        if isinstance(val, dict):
            return val.get("raw", val.get("fmt"))
        return val

    return {
        "market_cap": raw("summaryDetail", "marketCap"),
        "pe": raw("summaryDetail", "trailingPE"),
        "forward_pe": raw("summaryDetail", "forwardPE"),
        "dividend_yield": raw("summaryDetail", "dividendYield"),
        "beta": raw("summaryDetail", "beta"),
        "fifty_two_week_high": raw("summaryDetail", "fiftyTwoWeekHigh"),
        "fifty_two_week_low": raw("summaryDetail", "fiftyTwoWeekLow"),
        "eps": raw("defaultKeyStatistics", "trailingEps"),
        "revenue_growth": raw("financialData", "revenueGrowth"),
        "profit_margins": raw("financialData", "profitMargins"),
        "recommendation": raw("financialData", "recommendationKey"),
    }


def parse_bird_json(raw: str) -> list[dict[str, Any]]:
    try:
        data = json.loads(raw)
    except Exception:
        return []
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        if isinstance(data.get("tweets"), list):
            return [x for x in data["tweets"] if isinstance(x, dict)]
        return [data]
    return []


def _pick(d: dict[str, Any], *paths: str) -> Any:
    for p in paths:
        cur: Any = d
        ok = True
        for key in p.split("."):
            if isinstance(cur, dict) and key in cur:
                cur = cur[key]
            else:
                ok = False
                break
        if ok and cur not in (None, ""):
            return cur
    return None


def normalize_tweet(t: dict[str, Any]) -> dict[str, Any]:
    text = _pick(t, "full_text", "text", "legacy.full_text", "legacy.text") or ""
    text = re.sub(r"\s+", " ", str(text)).strip()
    username = _pick(t, "user.screen_name", "user.username", "author.username", "legacy.user.screen_name") or "unknown"
    created = _pick(t, "created_at", "legacy.created_at") or ""
    tid = _pick(t, "id_str", "rest_id", "id")
    url = f"https://x.com/{username}/status/{tid}" if tid else ""
    return {"text": text, "username": str(username), "created_at": str(created), "url": url}


def bird_search(query: str, count: int) -> list[dict[str, Any]]:
    cmd = ["bird", "search", "--json", "-n", str(count), query]
    code, out, err = run(cmd, timeout=45)
    if code != 0:
        return []
    tweets = [normalize_tweet(x) for x in parse_bird_json(out)]
    return [t for t in tweets if t.get("text")]


def sentiment_label(text: str) -> str:
    words = set(re.findall(r"[a-zA-Z']+", text.lower()))
    bull = len(words & BULLISH_WORDS)
    bear = len(words & BEARISH_WORDS)
    if bull > bear:
        return "bullish"
    if bear > bull:
        return "bearish"
    return "neutral"


def sentiment_summary(tweets: list[dict[str, Any]]) -> dict[str, Any]:
    if not tweets:
        return {"counts": {"bullish": 0, "bearish": 0, "neutral": 0}, "bearish_pct": 0.0, "mood": "unknown"}

    labels = [sentiment_label(t["text"]) for t in tweets]
    c = Counter(labels)
    total = max(len(labels), 1)
    bearish_pct = (c.get("bearish", 0) / total) * 100

    mood = "neutral"
    if c.get("bullish", 0) / total >= 0.6:
        mood = "bullish"
    elif bearish_pct >= 60:
        mood = "bearish"

    return {
        "counts": {"bullish": c.get("bullish", 0), "bearish": c.get("bearish", 0), "neutral": c.get("neutral", 0)},
        "bearish_pct": round(bearish_pct, 1),
        "mood": mood,
    }


def fmt_num(v: Any) -> str:
    if v is None:
        return "n/a"
    if isinstance(v, (int, float)):
        if abs(v) >= 1_000_000_000:
            return f"{v/1_000_000_000:.2f}B"
        if abs(v) >= 1_000_000:
            return f"{v/1_000_000:.2f}M"
        if abs(v) >= 1_000:
            return f"{v/1_000:.2f}K"
        return f"{v:.2f}" if isinstance(v, float) else str(v)
    return str(v)


def top_ticker_mentions(tweets: list[dict[str, Any]], limit: int = 5) -> list[str]:
    bag: Counter[str] = Counter()
    for t in tweets:
        for tok in TICKER_RE.findall(t.get("text", "")):
            sym = tok.lstrip("$").upper()
            if 2 <= len(sym) <= 5:
                bag[sym] += 1
    return [k for k, _ in bag.most_common(limit)]


def mode_ticker(symbol: str) -> str:
    sym = symbol.upper()
    quote = stock_quote(sym)
    try:
        fundamentals = stock_fundamentals(sym)
    except Exception:
        fundamentals = {}

    cashtag_query = f"\\${sym}"
    sentiment_tweets = bird_search(cashtag_query, 20)
    key_account_q = f"(from:unusual_whales OR from:DeItaone) \\${sym}"
    key_mentions = bird_search(key_account_q, 20)
    sent = sentiment_summary(sentiment_tweets)

    lines = []
    lines.append(f"📊 Market Intel: {sym}")
    lines.append(f"Price: ${quote.get('price')} ({quote.get('change_percent')}%) [{quote.get('signal')}]")
    lines.append(
        "Key metrics: "
        f"MktCap {fmt_num(fundamentals.get('market_cap'))} | "
        f"P/E {fmt_num(fundamentals.get('pe'))} | "
        f"Fwd P/E {fmt_num(fundamentals.get('forward_pe'))} | "
        f"EPS {fmt_num(fundamentals.get('eps'))}"
    )
    lines.append(
        "X sentiment (20): "
        f"{sent['mood']} | bullish {sent['counts']['bullish']} / bearish {sent['counts']['bearish']} / neutral {sent['counts']['neutral']}"
    )

    if key_mentions:
        lines.append("Notable account mentions:")
        for t in key_mentions[:5]:
            snippet = t['text'][:180]
            lines.append(f"- @{t['username']}: {snippet}{'…' if len(t['text'])>180 else ''}")
    else:
        lines.append("Notable account mentions: none found (or bird auth unavailable).")

    return "\n".join(lines)


def mode_portfolio() -> str:
    data = fetch_json(ALPACA_PORTFOLIO_URL)
    positions = data.get("positions") or []

    lines = ["💼 Portfolio Sentiment Scan"]
    if not positions:
        lines.append("No open positions in Alpaca.")
        return "\n".join(lines)

    flagged = []
    for p in positions:
        symbol = str(p.get("symbol", "")).upper()
        qty = p.get("qty")
        mv = p.get("market_value")
        tweets = bird_search(f"\\${symbol}", 5)
        sent = sentiment_summary(tweets)
        if sent["bearish_pct"] > 60:
            flagged.append(symbol)
        lines.append(
            f"- {symbol}: qty {qty}, mv ${mv}, mood {sent['mood']} "
            f"(bearish {sent['bearish_pct']}%, n={sum(sent['counts'].values())})"
        )

    if flagged:
        lines.append("⚠️ Bearish risk flags (>60% bearish): " + ", ".join(flagged))
    else:
        lines.append("✅ No bearish sentiment flags above 60%.")

    return "\n".join(lines)


def market_status() -> str:
    if MARKET_STATUS_SCRIPT.exists():
        code, out, _ = run([str(MARKET_STATUS_SCRIPT)], timeout=10)
        if code == 0 and out:
            return out
    return "UNKNOWN"


def mode_pulse() -> str:
    status = market_status()
    broad = bird_search("stock market today OR SPY OR QQQ", 20)
    key = bird_search("from:DeItaone OR from:unusual_whales", 20)
    sent = sentiment_summary(broad)
    movers = top_ticker_mentions(broad + key, limit=6)

    lines = ["🌐 Market Pulse"]
    lines.append(f"Market status: {status}")
    lines.append(
        f"Market mood: {sent['mood']} (bullish {sent['counts']['bullish']}, bearish {sent['counts']['bearish']}, neutral {sent['counts']['neutral']})"
    )
    lines.append("Top movers mentioned: " + (", ".join(movers) if movers else "none"))

    lines.append("Breaking/news flow (DeItaone + unusual_whales):")
    if key:
        for t in key[:6]:
            snippet = t['text'][:180]
            lines.append(f"- @{t['username']}: {snippet}{'…' if len(t['text']) > 180 else ''}")
    else:
        lines.append("- No key-account pulls (bird auth missing or no fresh posts).")

    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Unified market intelligence pipeline")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--ticker", help="single ticker deep dive, e.g. --ticker NVDA")
    g.add_argument("--portfolio", action="store_true", help="sentiment overlay for Alpaca portfolio")
    g.add_argument("--pulse", action="store_true", help="broad market pulse")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.ticker:
            print(mode_ticker(args.ticker))
        elif args.portfolio:
            print(mode_portfolio())
        elif args.pulse:
            print(mode_pulse())
        else:
            return 2
        return 0
    except Exception as e:
        print(f"❌ market-intel failed: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
