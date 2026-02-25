# Trading Commands

Commands I recognize in our conversation for the trading advisor.

## Portfolio Commands

| Command | What I Do |
|---------|-----------|
| `/portfolio` | Show your Alpaca account + positions |
| `/market` | Check market regime (M factor) |
| `/scan` | Run quick scan for opportunities |
| `/analyze SYMBOL` | Full CANSLIM analysis on a stock |

## Trade Tracking Commands

| Command | Example | What I Do |
|---------|---------|-----------|
| `/executed` | `/executed CRWD 10 @ 382.50` | Log that you bought the stock |
| `/declined` | `/declined CRWD` | Log that you passed on my recommendation |
| `/sold` | `/sold CRWD 10 @ 410` | Log that you exited the position |
| `/trades` | `/trades` | Show all tracked trades |
| `/stats` | `/stats` | Show win rate, P&L stats |

## How Trade Tracking Works

1. I recommend a trade → automatically logged with score, reasoning, entry/stop
2. You execute or decline → tell me with `/executed` or `/declined`
3. When you exit → tell me with `/sold`
4. I calculate P&L and track performance over time

## Examples

```
/portfolio
→ Shows: $100K cash, positions, P&L

/market  
→ Shows: UPTREND_UNDER_PRESSURE, 6 distribution days, 50% position sizing

/analyze NVDA
→ Shows: C=2, A=2, N=0, L=0, Total 5/12, NO BUY (score too low)

/executed CRWD 10 @ 382.50
→ Logs: Bought 10 shares of CRWD at $382.50

/sold CRWD 10 @ 410
→ Logs: Sold 10 shares at $410, P&L +$275 (+7.2%)

/stats
→ Shows: 5 trades, 3 wins, 60% win rate, +$1,250 total P&L
```

## Service Endpoints (for reference)

- Portfolio: `curl http://localhost:3033/alpaca/portfolio`
- Trades: `curl http://localhost:3033/alpaca/trades`
- Stats: `curl http://localhost:3033/alpaca/stats`
