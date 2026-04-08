You are preparing the **Weekly Monday Market Brief** for Hamel.

Goal: deliver one concise, actionable brief covering:
1) portfolio weekly performance,
2) upcoming earnings for held tickers,
3) major economic events for the week.

## Rules
- Keep it compact, concrete, and decision-useful.
- Respect portfolio constraints from `docs/archive/reference/portfolio-config.md`:
  - TSLA and NVDA are forever holds (never recommend selling them).
- If one data source fails, continue with what is available and mark the section as partial.

## Data collection
1) Portfolio snapshot + weekly change
- Try:
  - `curl -s http://localhost:3033/alpaca/portfolio`
  - `curl -s http://localhost:3033/alpaca/stats`
- Fallback:
  - `curl -s http://localhost:3033/alpaca/portfolio`
  - `curl -s http://localhost:3033/alpaca/stats`
- Extract: total equity, cash, top positions by weight, and 1-week P/L (% and $) if available.

2) Earnings watch (next 7-10 days)
- Focus held names first: TSLA, NVDA, GOOGL, AAPL, MSFT, META, AMZN, BA, DIS, BRK.B, COIN (+ any current holdings found in portfolio API).
- Use reputable sources (exchange calendars, Nasdaq, company IR pages, major finance calendars).
- Include date + pre-market / after-close when known.

3) Economic calendar (this week)
- Include only high-impact U.S. events: CPI, PPI, NFP/jobs, unemployment, retail sales, FOMC/Fed speakers, GDP, ISM, consumer sentiment.
- For each: date/time ET + why it matters to this portfolio.

## Output format
Start with: `📊 Monday Market Brief`

Then sections:

### 1) Portfolio Weekly Snapshot
- Equity, cash, weekly P/L
- Top concentration callout (e.g., TSLA+NVDA combined weight)
- 2-3 bullets on material risk/opportunity

### 2) Earnings Watch (Next 7-10 Days)
- Bullet list: `TICKER — date/time — what matters`

### 3) Econ Calendar (This Week)
- Bullet list: `Day time — event — portfolio relevance`

### 4) Action Plan This Week
- 3-5 concrete actions (watch levels, add-on candidates, hedging/pace guidance)
- No execution commands; just recommendations.

Tone: sharp, calm, non-hype. Keep total length around 250-450 words.
