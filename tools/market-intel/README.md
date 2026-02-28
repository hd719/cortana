# market-intel

Unified market intelligence pipeline combining:
- `bird` (X/Twitter sentiment and key account flow)
- `stock-analysis` (quote pull)
- `markets` skill (market open/close status)
- Alpaca local endpoints for portfolio overlay

## Location
- Script: `~/openclaw/tools/market-intel/market-intel.sh`
- Python engine: `~/openclaw/tools/market-intel/market-intel.py`

## Modes

### 1) Single ticker deep dive
```bash
~/openclaw/tools/market-intel/market-intel.sh --ticker NVDA
```
Output includes:
- Quote + daily move signal
- Key fundamentals (market cap, P/E, forward P/E, EPS)
- X sentiment scan from latest 20 cashtag tweets
- Notable mentions from `@unusual_whales` and `@DeItaone`

### 2) Portfolio sentiment scan
```bash
~/openclaw/tools/market-intel/market-intel.sh --portfolio
```
- Pulls Alpaca positions from `http://localhost:3033/alpaca/portfolio`
- Scans 5 X tweets per held ticker
- Flags symbols with `>60%` bearish sentiment

### 3) Market pulse
```bash
~/openclaw/tools/market-intel/market-intel.sh --pulse
```
- Market status from `~/openclaw/skills/markets/check_market_status.sh`
- Broad X sentiment scan (`stock market today`, `SPY`, `QQQ`)
- Latest flow from `@DeItaone` + `@unusual_whales`
- Top cashtags mentioned

## Notes
- Cashtag queries are escaped as `\$TICKER` so shell expansion does not break searches.
- If bird auth/cookies are unavailable, script still runs and reports missing social data gracefully.
- Output is plain text and Telegram-paste friendly.

## Quick test
```bash
~/openclaw/tools/market-intel/market-intel.sh --ticker AAPL
~/openclaw/tools/market-intel/market-intel.sh --portfolio
~/openclaw/tools/market-intel/market-intel.sh --pulse
```
