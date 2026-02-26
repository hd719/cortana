# earnings-alert

Earnings calendar alerting for held positions.

## Files
- `earnings-alert.sh` — cron-friendly alert engine (JSON output)
- `earnings-calendar.json` — local symbol → next earnings date map (`YYYY-MM-DD`)
- `earnings-check.sh` / `earnings-check.py` — legacy checker utilities (kept intact)

## Data source for positions
- Alpaca local API: `http://localhost:3033/alpaca/portfolio`
  - Symbols are read from `.positions[].symbol`
  - If no positions are returned, the script falls back to symbols present in `earnings-calendar.json`

## Alert logic implemented
For each symbol in scope:
- **t-24h** (earnings date is tomorrow):
  - `Heads up — {SYMBOL} reports earnings tomorrow after close`
- **today** (earnings date is today):
  - flags earnings day
- **t-1h** (earnings date is today and runtime hour is 3 PM ET):
  - `Final reminder — {SYMBOL} earnings dropping after close today`

## Output contract
The script prints JSON only:

```json
{
  "alerts": [
    {
      "symbol": "NVDA",
      "alert_type": "t-24h",
      "earnings_date": "2026-03-05",
      "message": "Heads up — NVDA reports earnings tomorrow after close"
    }
  ]
}
```

## Usage
```bash
~/clawd/tools/earnings-alert/earnings-alert.sh
```

## Notes
- `earnings-calendar.json` is intentionally local/manual for now (seeded baseline).
- Update dates periodically as companies publish/adjust earnings schedules.
