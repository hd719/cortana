# TOOLS.md — Spartan Fitness Endpoints

- `curl -s http://127.0.0.1:3033/health` — aggregate health
- `curl -s http://127.0.0.1:3033/whoop/health` — Whoop auth status
- `curl -s http://127.0.0.1:3033/whoop/data` — full Whoop data (recovery, sleep, workouts)
- `curl -s http://127.0.0.1:3033/tonal/health` — Tonal auth status
- `curl -s http://127.0.0.1:3033/tonal/data` — full Tonal data (workouts, profile, streaks)
- PostgreSQL: `export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"` then `psql cortana`
- Weekly output dir: `/Users/hd/Developer/cortana/memory/fitness/weekly/`
