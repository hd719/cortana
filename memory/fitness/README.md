# Fitness Tracking

This directory stores Hamel's daily fitness data from Whoop and Tonal.

## Structure
- `YYYY-MM-DD.json` - Daily fitness snapshots (morning + evening data)
- `weekly/` - Weekly summary reports

## Data Sources
- **Whoop**: Sleep, recovery, strain, HRV, workouts
- **Tonal**: Strength scores, workout details, volume, exercises

## Cron Schedule (ET)
- 7:00am - Morning brief (sleep/recovery + workout if done)
- 8:30pm - Evening recap (full day summary)
- Sunday 8pm - Weekly insights

## Service Endpoints
- `http://localhost:3033/whoop/data` - Whoop API (auto-refreshes tokens)
- `http://localhost:3033/tonal/data` - Tonal API (cached workout history)
