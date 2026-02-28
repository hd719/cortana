# earnings

Automated earnings checker + calendar event creator for current holdings.

Data source priority:
1. Local Alpaca service endpoint (`/alpaca/earnings`) using Alpaca news context + Yahoo calendar date
2. Finnhub (if API key exists)
3. FMP (if API key exists)
4. Yahoo direct fallback

## Scripts

- `check-earnings.sh` → outputs JSON:
  `[{symbol, earnings_date, days_until, confirmed}]`
- `create-calendar-events.sh` → creates calendar events (within 48h)

## Setup

1. Copy `.env.example` to `.env`
2. Add `FINNHUB_API_KEY` (recommended)
3. Optional fallback: `FMP_API_KEY`

```bash
cd ~/openclaw/tools/earnings
cp .env.example .env
# edit .env with your key(s)
```

## Usage

```bash
~/openclaw/tools/earnings/check-earnings.sh
~/openclaw/tools/earnings/create-calendar-events.sh
# or pipe explicit JSON
~/openclaw/tools/earnings/check-earnings.sh | ~/openclaw/tools/earnings/create-calendar-events.sh
```

## Notes

- `BRK-B` is normalized to `BRK.B` for provider calls.
- Cache TTL is 12 hours (`tools/earnings/cache/earnings-cache.json`).
- Calendar reminders are fixed to **T-60m** and **T-10m**.
