# Earnings Calendar API Research (free/affordable) — 2026-02-26

## Scope
Need: next earnings date per symbol (AAPL, NVDA, TSLA, MSFT, AMZN, BRK-B, META, GOOG), ideally with **confirmed vs estimated** distinction, via low-cost REST APIs and simple auth.

---

## Quick verdict
- **Winner: Finnhub** (best free value + clean earnings calendar endpoint + simple key auth)
- **Runner-up: Financial Modeling Prep (FMP)** (good calendar/fundamental coverage, but free tier is tight and higher tiers are pricier)

**Important reality:** none of these sources provides a perfect first-class `confirmed=true/false` field for earnings date certainty across all tickers. Most provide *scheduled date + EPS estimate/actual* and sometimes time-of-day (`bmo/amc`). You’ll likely implement a confidence layer in your app.

---

## Comparison

| Provider | Free tier / limits | NVDA next earnings endpoint example | Auth complexity | Reliability & freshness | Confirmed vs estimated support |
|---|---|---|---|---|---|
| **Finnhub** | Commonly cited free limit: ~60 req/min (community + docs references), no OAuth. | `GET https://finnhub.io/api/v1/calendar/earnings?symbol=NVDA&from=2026-01-01&to=2026-12-31&token=YOUR_KEY` | API key only | Generally strong for US large caps; calendar updated reasonably quickly around earnings season. | **Partial only**: date + estimate/actual fields, but no explicit universal `confirmed_date` boolean. |
| **Financial Modeling Prep (FMP)** | Free plan advertises **250 calls/day**; paid plans increase heavily. | `GET https://financialmodelingprep.com/api/v3/earning_calendar?symbol=NVDA&apikey=YOUR_KEY` | API key only | Good breadth for fundamentals + calendars; decent recency for major names. | **Partial only**: date + EPS estimate/actual; no canonical confirmed-vs-estimated date flag. |
| **Alpha Vantage** | Free key page states **25 requests/day** (very restrictive for portfolios). | `GET https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&symbol=NVDA&horizon=3month&apikey=YOUR_KEY` | API key only | Reliable vendor, but strict free quota and some premium-gated data. | **Partial only**: calendar dates + estimate fields; no robust confirmation state. |
| **Polygon.io (Massive)** | Free tier generally very limited (commonly cited around 5 req/min historically); fundamentals/earnings depth often requires paid tier. | No clean “next earnings date” endpoint as straightforward as Finnhub/FMP for free usage; workaround via fundamentals/reference datasets in paid tiers. | API key only | Excellent infra quality on paid plans; free plan not ideal for this specific use case. | **Weak/indirect** for this use case unless paying for richer datasets. |
| **Yahoo Finance (unofficial)** | Free/no official published API SLA; subject to throttling/format changes. | `GET https://query2.finance.yahoo.com/v10/finance/quoteSummary/NVDA?modules=calendarEvents` | No OAuth; unofficial cookies/headers may be needed depending on client | Can be fresh for mega caps, but fragile (schema/rate-limit break risk). | **Partial only**: provides earnings dates/estimates, but no trustworthy explicit confirmed flag. |
| **Twelve Data** | Pricing page shows free Basic plan with **~800/day** credits. | `GET https://api.twelvedata.com/earnings_calendar?symbol=NVDA&apikey=YOUR_KEY` | API key only | Solid platform, but earnings-specific reliability varies by region/symbol and plan. | **Partial only** (typical calendar + estimate style fields). |
| **MarketBeat scraping** | No stable public API contract for this workflow; scraping only. | Scrape page like `https://www.marketbeat.com/stocks/NASDAQ/NVDA/earnings/` | No API auth, but scraping complexity high | Fragile (HTML/layout/anti-bot/legal/TOS risk). | **Inconsistent** and not machine-contract-safe. |

---

## Symbol coverage check (required list)
All API-style vendors above (Finnhub/FMP/Alpha Vantage/Twelve Data/Polygon paid) support these as US equities:
- `AAPL, NVDA, TSLA, MSFT, AMZN, META, GOOG`
- `BRK-B` may need symbol normalization per provider (`BRK.B` or `BRK-B`).

Recommendation: store a per-provider symbol map.

---

## Recommendation details

### 1) **Best option: Finnhub**
Why:
- Best free usefulness for repeated polling and portfolio-scale checks
- Clean earnings calendar REST endpoint
- Simple key auth, lightweight integration

Caveat:
- No perfect explicit confirmed/estimated date status field. Add your own confidence logic.

### 2) **Runner-up: FMP**
Why:
- Strong fundamentals + calendar ecosystem
- Easy endpoint model and straightforward auth

Caveat:
- Free tier is only 250/day; can be tight if you monitor many symbols frequently.

---

## Practical implementation pattern (recommended)
Use a **two-source blend** for robustness:
1. Primary: Finnhub earnings calendar
2. Secondary fallback/verification: FMP (or Yahoo unofficial as tertiary)

Then compute `date_confidence` yourself:
- `HIGH`: same date across 2+ sources, within 0-30 days
- `MEDIUM`: single-source date with recent update and matching quarter expectations
- `LOW`: conflicting dates or far-out placeholder dates

This gives you the “confirmed vs estimated” behavior operationally, even when providers don’t expose a clean boolean.

---

## Notes on source quality
- Pricing/limits change frequently; verify before production rollout.
- Some provider docs are JS-heavy, and free-tier limits may be easier to confirm in support/FAQ pages than static docs.
- Treat unofficial Yahoo and scraping workflows as best-effort, not SLA-grade.
