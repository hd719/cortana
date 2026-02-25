#!/usr/bin/env python3
import argparse
import json
import sys
import urllib.request
import urllib.error


def _fetch_quote_yahoo(symbol: str) -> dict:
    url = f"https://query1.finance.yahoo.com/v7/finance/quote?symbols={symbol}"
    with urllib.request.urlopen(url, timeout=15) as resp:
        payload = json.loads(resp.read().decode("utf-8"))

    result = (payload.get("quoteResponse", {}) or {}).get("result", [])
    if not result:
        raise RuntimeError(f"No quote data for {symbol}")

    q = result[0]
    price = q.get("regularMarketPrice")
    change_pct = q.get("regularMarketChangePercent")
    if price is None:
        raise RuntimeError(f"Missing regularMarketPrice for {symbol}")

    signal = "neutral"
    if isinstance(change_pct, (int, float)):
        if change_pct >= 1.5:
            signal = "bullish"
        elif change_pct <= -1.5:
            signal = "bearish"

    return {
        "symbol": symbol.upper(),
        "price": price,
        "change_percent": round(change_pct, 3) if isinstance(change_pct, (int, float)) else None,
        "signal": signal,
        "currency": q.get("currency"),
        "as_of": q.get("regularMarketTime"),
        "source": "yahoo",
    }


def _fetch_quote_stooq(symbol: str) -> dict:
    # Stooq format for US tickers: <symbol>.us
    stooq_symbol = f"{symbol.lower()}.us"
    url = f"https://stooq.com/q/l/?s={stooq_symbol}&i=d"
    with urllib.request.urlopen(url, timeout=15) as resp:
        csv_text = resp.read().decode("utf-8", errors="replace").strip()

    lines = [l for l in csv_text.splitlines() if l.strip()]
    if not lines:
        raise RuntimeError(f"No stooq data for {symbol}")

    # Stooq commonly returns a single data row without header:
    # SYMBOL,DATE,TIME,OPEN,HIGH,LOW,CLOSE,VOLUME,
    row = [c.strip() for c in lines[0].split(",")]
    if len(row) < 7:
        raise RuntimeError(f"Malformed stooq row for {symbol}")

    close = row[6]
    if not close or close in {"N/D", "-"}:
        raise RuntimeError(f"Invalid stooq close for {symbol}")

    return {
        "symbol": symbol.upper(),
        "price": float(close),
        "change_percent": None,
        "signal": "neutral",
        "currency": "USD",
        "as_of": row[1],
        "source": "stooq",
    }


def fetch_quote(symbol: str) -> dict:
    try:
        return _fetch_quote_yahoo(symbol)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, RuntimeError):
        return _fetch_quote_stooq(symbol)


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_analyze = sub.add_parser("analyze")
    p_analyze.add_argument("symbol")
    p_analyze.add_argument("--json", action="store_true", dest="as_json")

    args = parser.parse_args()

    if args.cmd == "analyze":
        try:
            data = fetch_quote(args.symbol)
            if args.as_json:
                print(json.dumps(data, separators=(",", ":")))
            else:
                print(data)
            return 0
        except Exception as e:
            err = {"error": str(e), "symbol": args.symbol.upper()}
            print(json.dumps(err, separators=(",", ":")))
            return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
