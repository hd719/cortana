# TOOLS.md — Spartan Fitness Endpoints

## Provider Endpoints
- `curl -s http://127.0.0.1:3033/health` — aggregate health
- `curl -s http://127.0.0.1:3033/whoop/health` — Whoop auth status
- `curl -s http://127.0.0.1:3033/whoop/data` — full Whoop data (recovery, sleep, workouts)
- `curl -s http://127.0.0.1:3033/tonal/health` — Tonal auth status
- `curl -s http://127.0.0.1:3033/tonal/data` — full Tonal data (workouts, profile, streaks)

## Fitness Data Scripts
- `npx tsx /Users/hd/Developer/cortana/tools/fitness/morning-brief-data.ts`
- `npx tsx /Users/hd/Developer/cortana/tools/fitness/evening-recap-data.ts`
- `npx tsx /Users/hd/Developer/cortana/tools/fitness/weekly-insights-data.ts`
- `npx tsx /Users/hd/Developer/cortana/tools/fitness/coach-conversation-sync.ts --days=7`

## Database
- PostgreSQL: `export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"` then `psql cortana`
- Coaching tables: `coach_conversation_log`, `coach_decision_log`, `coach_nutrition_log`, `coach_weekly_score`

## Output Paths
- Weekly output dir: `/Users/hd/Developer/cortana/memory/fitness/weekly/`
