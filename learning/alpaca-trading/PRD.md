# Alpaca Trading Agent — Product Requirements Document

**Author:** Cortana  
**Date:** February 15, 2026  
**Status:** Draft (v4 — Alpaca + Advisory Mode)  
**Owner:** Hamel Desai

---

## 1. Overview

Build an AI-powered trading **advisor** integrated with Alpaca's brokerage API. The AI has **read-only access** — it monitors the portfolio, engineers strategies, and recommends trades. **Hamel executes all trades manually.**

**Why Alpaca over Schwab:**
- Developer-first API (designed for algo trading)
- Paper trading environment uses identical API to live
- Commission-free stock trading
- Simple API key auth (no complex OAuth)
- Huge algo trading community with examples
- WebSocket streaming for real-time data

### 1.1 Core Philosophy

> "The AI is an advisor, not an executor. It builds strategies, validates them with data, and tells you what to do. You pull the trigger."

**Access Model:**
- **Current:** Read-only (portfolio data, market data)
- **Future (optional):** Write access for automated execution

**The Wrong Way:**
- AI says "buy AAPL because it looks good" → vibes-based, untestable

**The Right Way:**
- AI says "based on CANSLIM strategy, CRWD scores 10/12 and is breaking out of a base. Backtest shows this pattern returns 15% avg over 30 days. Suggested action: BUY 25 shares at $380 with stop at $350." → rules-based, validated, human-executed

### 1.2 Vision

A personal AI trading advisor that:
- Has **read-only** access to your brokerage account
- Monitors portfolio health and alerts on significant moves
- Engineers rules-based trading strategies
- Backtests strategies against historical data
- **Recommends specific trades with reasoning**
- **You execute manually** (for now)
- Tracks outcomes and refines strategies
- (Future option) Can be upgraded to automated execution

### 1.3 Success Metrics

| Metric | Target |
|--------|--------|
| Strategy win rate (backtest) | > 55% |
| Suggestion acceptance rate | Track (no target yet) |
| Accepted trade win rate | > 50% |
| Sortino ratio (tracked trades) | > 1.0 |
| Max drawdown | < 15% |

### 1.4 Account Structure

| Account | Purpose | Cortana Access |
|---------|---------|----------------|
| **Main Account** | Long-term holds (TSLA, NVDA, etc.) | None |
| **AI Account** | Strategy-driven trading | **Read-only** |

The AI Account is a separate Alpaca account dedicated to strategy execution. This provides:
- Risk isolation from main portfolio
- Clean performance tracking
- Clear attribution of AI strategy results

---

## 2. Phased Rollout

### Phase 1: Portfolio Intelligence (MVP)

**Timeline:** 1-2 days  
**Risk Level:** None (read-only)

**Features:**
- [ ] Alpaca API key integration (simple key/secret, no OAuth needed)
- [ ] Account summary (balances, buying power, margin)
- [ ] Positions with P&L, cost basis, allocation %
- [ ] Daily portfolio summary in morning brief
- [ ] Price alerts for significant moves (> 3%)
- [ ] Earnings calendar for held positions
- [ ] Sector/concentration analysis

**Alpaca API Details:**
- **Base URL (Paper):** `https://paper-api.alpaca.markets`
- **Base URL (Live):** `https://api.alpaca.markets`
- **Auth:** API Key + Secret in headers (`APCA-API-KEY-ID`, `APCA-API-SECRET-KEY`)
- **Market Data:** `https://data.alpaca.markets` (separate endpoint)
- **WebSocket:** Real-time streaming available

**Deliverables:**
- `alpaca_keys.json` in `~/Desktop/services/` (API key + secret)
- Portfolio endpoints in Go service
- Integration with existing morning brief cron

**Getting Started:**
1. Sign up at alpaca.markets
2. Go to Paper Trading → API Keys → Generate
3. Save key ID + secret to `alpaca_keys.json`
4. Start with paper trading (identical API, no risk)

---

### Phase 2: Strategy Engineering + Backtesting

**Timeline:** 2-3 weeks  
**Risk Level:** None (no real money)

This is the core differentiator. The AI doesn't suggest trades — it engineers trading systems.

#### What is Backtesting?

Testing a trading strategy against **historical data** to see how it *would have* performed in the past — before risking real money.

**Example — Without vs With Backtesting:**

Say we have a simple strategy:
> "Buy when the stock's 10-day average crosses above its 50-day average. Sell when it crosses below."

| Approach | What Happens |
|----------|--------------|
| **Without backtesting** | We guess it might work. Risk real money to find out. Could lose $10K learning it's a bad strategy. |
| **With backtesting** | Run this rule against 5 years of AAPL prices. In 10 seconds: "47 trades, 58% win rate, 23% return, -12% max drawdown." Know before risking money. |

**How the Backtesting Engine Works:**

```
┌─────────────────────────────────────────┐
│  Historical Data (5 years of prices)    │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│  Strategy Rules (buy when X, sell when Y)│
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│  Simulate every trade day-by-day        │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│  Output: Win rate, returns, drawdown    │
└─────────────────────────────────────────┘
```

**Concrete CANSLIM Example:**

Instead of guessing "do high RS Rating stocks outperform?", we:
1. Get 5 years of stock data
2. Apply CANSLIM scoring rules to each historical day
3. Simulate buying top-scored stocks
4. See exactly how it would have performed

```
📈 Backtest Results: CANSLIM Strategy
Period: Jan 2021 - Jan 2026 (5 years)

Performance:
  Total Return: 89% (vs SPY 62%)
  Annual Return: 13.6%
  Win Rate: 58%
  Max Drawdown: -18%

Verdict: 
  ✅ If backtest shows solid returns → worth trying on paper trading
  ❌ If backtest shows losses → don't trade it, refine the rules
```

**The engine is software that:**
1. Loads historical price data
2. Runs your strategy rules day-by-day
3. Tracks simulated buys/sells
4. Calculates performance metrics

**Key insight:** We're not trading yet — we're testing ideas before risking money.

#### 2.1 Strategy Builder

**Features:**
- [ ] Natural language → strategy rules conversion
- [ ] Strategy template library (see Section 3)
- [ ] Parameter extraction and validation
- [ ] Strategy versioning and comparison

**Example interaction:**
```
Hamel: "Build me a momentum strategy for large caps"

Cortana: "Here's a momentum strategy:

📊 Strategy: Large Cap Momentum v1

Universe: S&P 500 stocks
Entry Rules:
  - 30-day price ROC > 5%
  - RSI(14) between 40-70 (not overbought)
  - Above 50-day SMA
  
Exit Rules:
  - 15% trailing stop
  - RSI > 80 (take profit)
  - Falls below 50-day SMA

Position Sizing: Equal weight, max 10 positions

Want me to backtest this against 2023-2025 data?"
```

#### 2.2 Backtesting Engine

**Features:**
- [ ] Historical data integration (Alpaca or third-party)
- [ ] Walk-forward backtesting (not just in-sample)
- [ ] Key metrics calculation:
  - Total return vs benchmark (SPY)
  - Sortino ratio (downside risk-adjusted)
  - Max drawdown
  - Win rate
  - Average win/loss ratio
  - Sharpe ratio
- [ ] Trade-by-trade breakdown
- [ ] Drawdown visualization
- [ ] Multiple timeframe testing (1Y, 3Y, 5Y)

**Output format:**
```
📈 Backtest Results: Large Cap Momentum v1
Period: Jan 2023 - Jan 2026 (3 years)

Performance:
  Total Return: 47.2% (vs SPY 38.1%)
  Annual Return: 13.8%
  Sortino Ratio: 1.42
  Max Drawdown: -12.3%
  Win Rate: 58%
  
Risk Analysis:
  Worst Month: -6.2% (Aug 2024)
  Best Month: +8.1% (Nov 2024)
  Correlation to SPY: 0.72

Trade Stats:
  Total Trades: 127
  Avg Hold Time: 23 days
  Avg Win: +7.2%
  Avg Loss: -4.1%

✅ Strategy meets minimum criteria (Sortino > 1.0)
Ready for paper trading validation?
```

#### 2.3 Genetic Optimization

**Features:**
- [ ] Parameter range definition
- [ ] Fitness function (sortino ratio, not just returns)
- [ ] Population-based optimization
- [ ] Cross-validation to prevent overfitting
- [ ] Optimization report with best parameters

**Example:**
```
Cortana: "Running genetic optimization on Large Cap Momentum...

Testing 500 parameter combinations:
  - RSI range: 30-50 to 50-80
  - Trailing stop: 10-25%
  - Lookback period: 20-60 days

Best parameters found:
  - RSI entry: 35-65
  - Trailing stop: 18%
  - Lookback: 25 days
  
Improved Sortino: 1.42 → 1.67
Improved Max DD: -12.3% → -9.8%
```

---

### Phase 3: Trade Recommendations (Advisory Mode)

**Timeline:** Ongoing after Phase 2  
**Risk Level:** Low (you execute, not me)

This is the **primary operating mode**. Cortana monitors, analyzes, and recommends. Hamel executes.

#### 3.1 Trade Alerts

When a strategy generates a signal, Cortana sends a recommendation:

```
📈 TRADE SIGNAL: CANSLIM Strategy

Action: BUY
Ticker: CRWD (CrowdStrike)
Score: 10/12 CANSLIM

Reasoning:
  ✅ C: EPS +42% YoY (exceeds 25%)
  ✅ A: 5yr growth 38%
  ✅ N: Breaking out of cup-with-handle base
  ✅ S: Float 25M, accumulation A-
  ✅ L: RS Rating 94
  ✅ I: +12% institutional buying last Q
  ✅ M: Market in confirmed uptrend

Entry: $382.50 (current price at breakout pivot)
Stop Loss: $352 (-8%)
Position Size: $3,800 (10 shares @ 10% of account)

Backtest context: This setup has 62% win rate, 
avg gain +14%, avg loss -6% over 847 historical trades.

⏰ Signal valid for: Market open tomorrow
```

#### 3.2 Trade Tracking

After you execute (or decline), tell Cortana:

| Command | Action |
|---------|--------|
| `/executed CRWD 10 @ 382.50` | Log that you took the trade |
| `/declined CRWD` | Log that you passed |
| `/sold CRWD 10 @ 410` | Log exit |

Cortana tracks:
- All recommendations made
- Which ones you executed vs declined
- Outcomes of executed trades
- Running P&L and win rate

#### 3.3 Portfolio Monitoring

Daily/weekly reports:

```
📊 AI Account Weekly Summary

Portfolio Value: $38,420 (+2.3%)
Cash: $12,580

Open Positions:
  CRWD: +8.2% (entered Mon)
  NVDA: +3.1% (entered Wed)
  
Pending Signals:
  PLTR: BUY signal (score 9/12)
  
Strategy Performance (last 30 days):
  Recommendations: 12
  Executed: 8
  Win Rate: 62%
  Avg Gain: +6.2%
```

#### 3.4 Alert Types

| Alert | Trigger | Urgency |
|-------|---------|---------|
| **BUY Signal** | Strategy criteria met | Medium |
| **SELL Signal** | Exit criteria triggered | High |
| **Stop Hit** | Price at stop loss level | High |
| **Earnings Warning** | Held stock reports in <7 days | Medium |
| **Market Regime Change** | M factor shifts | High |

---

### Phase 4: FUTURE — Automated Execution (Optional)

**Timeline:** Only if/when we want it  
**Risk Level:** Higher (AI executes)  
**Status:** NOT IMPLEMENTED — requires explicit decision to enable

This phase is **optional** and only built if we decide the advisory model isn't enough.

#### Requirements to Enable

Before considering automation:
- [ ] 90+ days of advisory mode
- [ ] Recommendation acceptance rate > 70%
- [ ] Executed trades win rate > 50%
- [ ] Explicit decision to enable
- [ ] Separate API credentials with write access

#### If Enabled (Future)

**Features:**
- [ ] Automated order execution via Alpaca API
- [ ] Position sizing based on strategy rules
- [ ] Automatic stop loss orders
- [ ] Rebalancing on schedule

**Guardrails (if we ever enable):**

```yaml
position_limits:
  max_single_position: 10%
  max_positions: 8
  max_sector_exposure: 30%

loss_limits:
  daily_loss_limit: 2%
  weekly_loss_limit: 5%
  total_loss_limit: 15%       # Kill switch if down 15%

kill_switches:
  - /trading stop              # Immediate halt
  - /trading pause             # No new orders
  - Auto-halt on API errors
  - Auto-halt on loss limits
```

**Protected Holdings (always):**
- **TSLA** — never auto-sell
- **NVDA** — never auto-sell

---

> ⚠️ **Current Mode: ADVISORY ONLY**  
> Cortana has read-only access. All trades are executed by Hamel manually.  
> Automation is a future option, not the current plan.

---

## 3. Strategy Templates

Pre-built strategy templates the AI can customize:

### 3.1 Momentum
```
Universe: S&P 500
Signal: Top N stocks by X-day price ROC
Filter: RSI not overbought, above SMA
Exit: Trailing stop or RSI overbought
```

### 3.2 Mean Reversion
```
Universe: Large caps with high liquidity
Signal: RSI oversold (< 30) + price > 200 SMA (uptrend)
Entry: Buy on oversold bounce
Exit: RSI neutral (50) or stop loss
```

### 3.3 Quality + Momentum
```
Universe: All US stocks
Filter 1: Profitable (positive earnings)
Filter 2: Low debt (debt/equity < 0.5)
Filter 3: Top quartile ROE
Rank: By 6-month momentum
Select: Top 15
Rebalance: Monthly
```

### 3.4 Earnings Momentum
```
Universe: Stocks reporting earnings this week
Signal: Positive earnings surprise > 5%
Entry: Buy on earnings beat
Exit: 10-day hold or trailing stop
```

### 3.5 Sector Rotation
```
Universe: Sector ETFs (XLK, XLF, XLE, etc.)
Signal: Relative strength vs SPY
Entry: Top 3 sectors by 30-day RS
Exit: Rotate when RS ranking changes
Rebalance: Weekly
```

### 3.6 CANSLIM (William O'Neil Methodology)

CANSLIM is a growth stock investing strategy developed by William O'Neil, founder of Investor's Business Daily. It's a rules-based system that scores stocks across 7 fundamental and technical factors, plus market regime awareness.

**Why CANSLIM fits our approach:**
- Systematic and rules-based (not vibes)
- Combines fundamentals + technicals + market timing
- Historically validated methodology
- Backtestable criteria

#### The 7 CANSLIM Factors

| Factor | Name | Criteria | Scoring |
|--------|------|----------|---------|
| **C** | Current Earnings | Quarterly EPS growth > 25% YoY | 0-2 pts |
| **A** | Annual Earnings | 5-year annual EPS growth > 25% | 0-2 pts |
| **N** | New Product/High | New products, management, or 52-week high | 0-2 pts |
| **S** | Supply & Demand | Low float + high volume on up days | 0-2 pts |
| **L** | Leader | RS Rating > 80 (top 20% of market) | 0-2 pts |
| **I** | Institutional | Increasing institutional ownership | 0-2 pts |
| **M** | Market Direction | Market in confirmed uptrend | Gate (see below) |

**Total Score: 0-12 points** (higher = stronger candidate)

#### Factor Details

**C — Current Quarterly Earnings**
```
Criteria:
  - EPS growth > 25% vs same quarter last year
  - Revenue growth > 20% (confirms earnings quality)
  - Accelerating growth preferred (this Q > last Q)

Scoring:
  - 2 pts: EPS growth > 50% + accelerating
  - 1 pt:  EPS growth 25-50%
  - 0 pts: EPS growth < 25%
```

**A — Annual Earnings Growth**
```
Criteria:
  - 5-year EPS growth rate > 25%
  - ROE > 17%
  - Consistent growth (no negative years)

Scoring:
  - 2 pts: 5yr growth > 40% + ROE > 25%
  - 1 pt:  5yr growth 25-40%
  - 0 pts: 5yr growth < 25%
```

**N — New Products, Management, or Highs**
```
Criteria:
  - Stock at or near 52-week high
  - New product launches or catalysts
  - Recent management changes (positive)
  - Breaking out of proper base pattern

Scoring:
  - 2 pts: At 52-week high + recent catalyst
  - 1 pt:  Within 5% of 52-week high
  - 0 pts: > 5% below high
```

**S — Supply and Demand**
```
Criteria:
  - Shares outstanding < 50M (tighter float = bigger moves)
  - Volume on up days > volume on down days
  - Accumulation/Distribution rating (more buying than selling)

Scoring:
  - 2 pts: Float < 25M + strong accumulation
  - 1 pt:  Float 25-50M or moderate accumulation
  - 0 pts: Float > 50M + distribution
```

**L — Leader or Laggard**
```
Criteria:
  - Relative Strength (RS) Rating > 80
  - Stock outperforming 80%+ of all stocks
  - Industry group in top 40% of 197 groups

Scoring:
  - 2 pts: RS > 90 + industry group top 20%
  - 1 pt:  RS 80-90
  - 0 pts: RS < 80 (laggard — avoid)
```

**I — Institutional Sponsorship**
```
Criteria:
  - Owned by quality institutions (mutual funds, etc.)
  - Number of institutional owners increasing
  - Not over-owned (< 60% institutional)

Scoring:
  - 2 pts: Increasing ownership + quality sponsors
  - 1 pt:  Stable institutional ownership
  - 0 pts: Decreasing ownership (selling)
```

**M — Market Direction (GATE)**
```
This is a GATE, not a score. If market is in correction, 
we don't buy anything regardless of individual stock scores.

Market Regimes:
  - CONFIRMED UPTREND: Full position sizing allowed
  - RALLY ATTEMPT: Reduced position sizing (50%)
  - UNDER PRESSURE: No new buys, hold existing
  - CORRECTION: No new buys, tighten stops

Signals:
  - Follow-through day (FTD): Day 4+ of rally with >1.5% gain on higher volume
  - Distribution day: Down >0.2% on higher volume
  - 4-5 distribution days in 25 days = correction warning
```

#### CANSLIM Strategy Implementation

```yaml
strategy: CANSLIM Growth
version: 1.0

universe:
  base: US stocks
  filters:
    - market_cap > $1B              # Mid to large cap
    - avg_volume > 400K             # Liquid
    - price > $15                   # No penny stocks

scoring:
  c_current_earnings:
    weight: 1
    criteria:
      - eps_growth_yoy > 0.25
      - revenue_growth_yoy > 0.20
  a_annual_earnings:
    weight: 1
    criteria:
      - eps_growth_5yr > 0.25
      - roe > 0.17
  n_new_high:
    weight: 1
    criteria:
      - price_vs_52w_high > 0.95    # Within 5% of high
  s_supply_demand:
    weight: 1
    criteria:
      - shares_outstanding < 50M
      - accumulation_rating >= 'B'
  l_leader:
    weight: 1.5                     # Leadership is critical
    criteria:
      - rs_rating > 80
      - industry_group_rank < 80    # Top 40%
  i_institutional:
    weight: 1
    criteria:
      - institutional_ownership_change > 0
      - institutional_owners_count > 10

market_regime_gate:
  confirmed_uptrend: 
    position_size: 100%
    action: buy
  rally_attempt:
    position_size: 50%
    action: buy_cautiously
  under_pressure:
    position_size: 0%
    action: hold_only
  correction:
    position_size: 0%
    action: tighten_stops

entry_rules:
  - min_score >= 8                  # Need 8+ out of 12
  - market_regime in [confirmed_uptrend, rally_attempt]
  - breaking_out_of_base = true     # Technical breakout
  - volume > 1.5x average           # Volume confirmation

exit_rules:
  - trailing_stop: 8%               # Sell if drops 8% from high
  - rs_rating < 70                  # No longer a leader
  - market_regime = correction      # Tighten to 3-5% stop
  - profit_target: 20-25%           # Take some profits

position_sizing:
  method: equal_weight
  max_positions: 8
  max_single_position: 12.5%
  
rebalance: weekly                   # Review scores weekly
```

#### Using CANSLIM in Practice

**Step 1: Check Market Regime (M)**
```
Before looking at ANY individual stocks, determine market direction:
- Count distribution days in last 25 sessions
- Look for follow-through days after corrections
- If M = Correction or Under Pressure → STOP, don't buy
```

**Step 2: Screen Universe**
```
Filter to stocks that pass minimum criteria:
- RS Rating > 80
- EPS growth > 25%
- Near 52-week high
- Adequate volume
```

**Step 3: Score Candidates**
```
For each passing stock, calculate CANSLIM score (0-12)
Rank by score, focus on top 10-20 candidates
```

**Step 4: Wait for Breakout**
```
Don't chase! Wait for:
- Price breaking out of consolidation base
- Volume 50%+ above average on breakout day
- Market regime is favorable
```

**Step 5: Execute with Risk Management**
```
- Buy at breakout point (pivot)
- Set stop loss 7-8% below entry
- Position size based on market regime
- Never average down
```

#### Data Sources for CANSLIM

| Data Point | Source |
|------------|--------|
| EPS/Revenue Growth | Alpaca API, Yahoo Finance, or Alpha Vantage |
| RS Rating | Calculate from price data or IBD (paid) |
| Institutional Ownership | Alpaca API, Finviz, or SEC 13F filings |
| Industry Group Ranking | Calculate or IBD (paid) |
| Base Patterns | Technical analysis on price data |
| Distribution Days | Calculate from index price + volume |

#### Why Build Our Own vs IBD?

IBD (Investor's Business Daily) provides CANSLIM data but:
- Costs $35-50/month
- No API access (screen scraping required)
- Can't backtest their data

**Our approach:**
- Calculate factors from raw market data
- Full backtesting capability
- Customizable scoring weights
- Free (aside from market data costs)

---

## 4. Technical Architecture

### 4.1 System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Cortana (Main)                          │
│  - Strategy engineering conversations                       │
│  - Backtest result interpretation                          │
│  - Paper trading monitoring                                │
│  - Live trading commands                                   │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│              Strategy Engine (Python)                       │
│  - Strategy builder (NL → rules)                           │
│  - Backtesting framework                                   │
│  - Genetic optimizer                                       │
│  - Paper trading simulator                                 │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│              Trading Service (Go)                           │
│  - Alpaca API client                                       │
│  - Order execution                                         │
│  - Position management                                     │
│  - Risk enforcement                                        │
└─────────────────┬───────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│                   Alpaca API                                │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Data Requirements

| Data | Source | Use |
|------|--------|-----|
| Historical prices | Alpaca API or Yahoo Finance | Backtesting |
| Fundamentals | Alpaca API or financial APIs | Quality filters |
| Real-time quotes | Alpaca API | Live execution |
| Earnings calendar | Third-party API | Earnings strategies |
| Sector classifications | Static mapping | Sector rotation |

### 4.3 Storage

| Data | Location |
|------|----------|
| Auth tokens | `~/Desktop/services/alpaca_tokens.json` |
| Strategies | `~/openclaw/config/trading/strategies/` |
| Backtest results | `~/openclaw/memory/trading/backtests/` |
| Paper trades | `cortana_events` (PostgreSQL) |
| Live trades | `cortana_events` (PostgreSQL) |
| Performance logs | `~/openclaw/memory/trading/performance/` |

---

## 5. Backtesting Framework

### 5.1 Requirements

- **Walk-forward testing:** Train on 2020-2023, test on 2024-2025
- **Transaction costs:** Include $0 commissions but model slippage
- **Survivorship bias:** Use point-in-time constituents where possible
- **Realistic fills:** Assume some slippage on entries/exits

### 5.2 Libraries (Python)

Options:
- **Backtrader** — mature, feature-rich
- **Zipline** — Quantopian's engine (now open source)
- **VectorBT** — fast, pandas-based
- **Custom** — build minimal engine for our needs

Recommendation: Start with **VectorBT** for speed, migrate to custom if needed.

### 5.3 Metrics Calculated

| Metric | Description | Target |
|--------|-------------|--------|
| Total Return | Cumulative P&L | > SPY |
| CAGR | Annualized return | > 10% |
| Sortino Ratio | Return / downside deviation | > 1.0 |
| Sharpe Ratio | Return / total volatility | > 0.8 |
| Max Drawdown | Worst peak-to-trough | < 20% |
| Win Rate | % of profitable trades | > 50% |
| Profit Factor | Gross profit / gross loss | > 1.5 |
| Avg Trade | Mean P&L per trade | > 1% |

---

## 6. Safety & Compliance

### 6.1 Human-Only Actions
- Enabling live trading for a strategy
- Changing risk limits
- Adding/removing protected holdings
- Withdrawing funds

### 6.2 Audit Trail
- Every strategy version saved with timestamp
- Every backtest logged with parameters and results
- Every paper trade recorded
- Every live trade with rationale and outcome
- Weekly performance summary

### 6.3 Regulatory Awareness
- Pattern Day Trader rules ($25k minimum for >4 day trades/week)
- Wash sale tracking
- No trading on material non-public information

---

## 7. Open Questions

1. **Initial capital for live trading?** (Start small, scale up)
2. **Risk tolerance?** Conservative (sortino > 1.5) or moderate (sortino > 1.0)?
3. **Preferred strategy types?** Momentum, value, quality, or mix?
4. **Rebalancing frequency?** Daily, weekly, monthly?
5. **Benchmark?** SPY, QQQ, or total market?
6. **Paper trading duration?** 30 days minimum, but longer?
7. **Historical data source?** Alpaca API sufficient or need premium data?

---

## 8. Implementation Roadmap

### Phase 1: Portfolio Intelligence (Week 1)
- [ ] Alpaca developer account + OAuth
- [ ] Portfolio endpoints (balances, positions)
- [ ] Morning brief integration
- [ ] Price alerts

### Phase 2: Strategy Engine (Weeks 2-4)
- [ ] VectorBT setup + historical data
- [ ] Strategy template implementation
- [ ] Backtesting framework
- [ ] Genetic optimizer
- [ ] First strategy: Simple momentum

### Phase 3: Paper Trading (Week 5 + 30 days)
- [ ] Paper trading simulator
- [ ] Daily P&L tracking
- [ ] Performance dashboard
- [ ] Graduation criteria check

### Phase 4: Live Deployment (After validation)
- [ ] Order execution module
- [ ] Risk management enforcement
- [ ] Kill switches
- [ ] First live strategy (small allocation)

---

## 9. References

- [Alpaca Markets](https://alpaca.markets)
- [Alpaca API Documentation](https://docs.alpaca.markets)
- [Alpaca Go SDK](https://github.com/alpacahq/alpaca-trade-api-go)
- [Alpaca Python SDK](https://github.com/alpacahq/alpaca-trade-api-python)
- [NexusTrade Article on AI Trading](https://nexustrade.io/blog/too-many-idiots-are-using-openclaw-to-trade-heres-how-to-trade-with-ai-the-right-way-20260203)
- [OpenAlgo + OpenClaw Integration](https://blog.openalgo.in/automating-trading-with-openalgo-and-openclaw-de55cc2b2d63)
- [VectorBT Documentation](https://vectorbt.dev/)
- [Pattern Day Trader Rules](https://www.finra.org/investors/learn-to-invest/advanced-investing/day-trading-margin-requirements-know-rules)

---

*Last updated: Feb 15, 2026 (v4 — Alpaca + Advisory Mode)*
