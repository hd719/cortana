# Market Holidays - US Stock Market Calendar

Quick reference for NYSE/NASDAQ trading holidays and early closes.

## 2026 US Stock Market Holiday Schedule

**Market Closed (Full Day):**
- **January 1, 2026** (Wednesday) - New Year's Day (Observed)
- **January 19, 2026** (Monday) - Martin Luther King Jr. Day  
- **February 16, 2026** (Monday) - Presidents' Day
- **April 3, 2026** (Friday) - Good Friday
- **May 25, 2026** (Monday) - Memorial Day
- **June 19, 2026** (Friday) - Juneteenth Holiday (Observed)
- **July 3, 2026** (Friday) - Independence Day (Observed)
- **September 7, 2026** (Monday) - Labor Day
- **November 26, 2026** (Thursday) - Thanksgiving Day
- **December 25, 2026** (Friday) - Christmas Day

**Early Close (1:00 PM ET):**
- **November 27, 2026** (Friday) - Day after Thanksgiving
- **December 24, 2026** (Thursday) - Christmas Eve

## Usage

Check if today is a market holiday:
```bash
~/openclaw/skills/markets/check_market_status.sh
```

Outputs:
- `OPEN` - Normal trading hours
- `CLOSED: Holiday Name` - Market closed
- `EARLY CLOSE 1:00 PM ET: Holiday Name` - Early close day

## Integration with Morning Brief

Add this check to your morning brief routine:

```bash
# Check market status
MARKET_STATUS=$(~/openclaw/skills/markets/check_market_status.sh)
echo "📈 Market Status: $MARKET_STATUS"
```

## Notes

- Schedule verified from official NYSE/NASDAQ sources (February 2026)
- Times are Eastern Time
- Weekend market closures not listed (markets closed Saturdays/Sundays)
- Early close days: markets close at 1:00 PM ET instead of 4:00 PM ET