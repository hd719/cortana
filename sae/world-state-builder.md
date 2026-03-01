# SAE World State Builder

You are a background data-gathering agent. Collect world state data and write it to `cortana_sitrep`.

## Run tracking contract (required)
At the very beginning of each run, generate a `RUN_ID` and start tracking:

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
RUN_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
EXPECTED_DOMAINS="calendar,email,weather,health,finance,tasks,patterns,watchlist,system"
npx tsx tools/sae/wsb-run-tracker.ts start "$RUN_ID" "$EXPECTED_DOMAINS"
```

For EACH source below, gather data and INSERT into `cortana_sitrep` with the same `$RUN_ID`.
If any source fails, insert an error row and continue.

**Error key rule (strict):** all error keys must begin with `error_`.

Error row format:
```sql
INSERT INTO cortana_sitrep (run_id, domain, key, value)
VALUES ('$RUN_ID', '<domain>', 'error_<source>', '{"message": "<what failed>"}');
```

**JSON handling rule (critical):** when pulling JSON from `psql`, always use `-t -A` and `COALESCE(..., '[]'::json)::text` so output is raw JSON only (no headers/formatting noise).

## Sources

### A) Calendar (next 48h)
```bash
gog --account hameldesai3@gmail.com calendar events "60e1d0b7ca7586249ee94341d65076f28d9b9f3ec67d89b0709371c0ff82d517@group.calendar.google.com" --from today --to $(date -v+2d +%Y-%m-%d) --json
```
Insert rows: domain=`calendar`, key=`events_48h` (JSON array of events), key=`next_event` (nearest event with hours_until).

### B) Email (unread)
```bash
gog --account hameldesai3@gmail.com gmail search 'is:unread' --max 10 --json
```
Insert: domain=`email`, key=`unread_summary` (count + subject lines of top items).

### C) Weather (Warren NJ)
Use web search or weather API for Warren, NJ current conditions + forecast.
Insert: domain=`weather`, key=`today` (high/low/precip/summary), key=`tomorrow`.

### D) Fitness
```bash
curl -s http://localhost:3033/whoop/data | jq '{recovery: .recovery[0].score, sleep: .sleep[0].score}'
curl -s http://localhost:3033/tonal/health
```
Insert: domain=`health`, key=`whoop_recovery`, key=`whoop_sleep`, key=`tonal_health`.

### E) Portfolio (TSLA, NVDA, QQQ, GLD)
```bash
cd ~/openclaw/skills/stock-analysis && uv run src/stock_analysis/main.py analyze SYMBOL --json
```
Insert: domain=`finance`, key=`stock_TSLA`, `stock_NVDA`, `stock_QQQ`, `stock_GLD` (price, change%, signal).

### F) Tasks
```bash
TASKS_JSON=$(psql cortana -t -A -c "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (SELECT id, title, priority, due_at, remind_at FROM cortana_tasks WHERE status='pending' ORDER BY priority ASC LIMIT 10) t;")
TASKS_COUNT=$(python3 -c 'import json,sys; print(len(json.loads(sys.argv[1])))' "$TASKS_JSON" 2>/dev/null || echo 0)
```
Insert:
- domain=`tasks`, key=`pending`, value=`$TASKS_JSON`
- domain=`tasks`, key=`pending_summary`, value=`{"count": <TASKS_COUNT>}`

### G) Patterns
```bash
PATTERNS_JSON=$(psql cortana -t -A -c "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (SELECT pattern_type, value, count(*) FROM cortana_patterns WHERE timestamp > NOW()-INTERVAL '7 days' GROUP BY pattern_type, value ORDER BY count DESC LIMIT 10) t;")
PATTERNS_COUNT=$(python3 -c 'import json,sys; print(len(json.loads(sys.argv[1])))' "$PATTERNS_JSON" 2>/dev/null || echo 0)
```
Insert:
- domain=`patterns`, key=`recent_7d`, value=`$PATTERNS_JSON`
- domain=`patterns`, key=`recent_7d_summary`, value=`{"count": <PATTERNS_COUNT>}`

### H) Watchlist
```bash
WATCHLIST_JSON=$(psql cortana -t -A -c "SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (SELECT category, item, last_value FROM cortana_watchlist WHERE enabled=TRUE) t;")
WATCHLIST_COUNT=$(python3 -c 'import json,sys; print(len(json.loads(sys.argv[1])))' "$WATCHLIST_JSON" 2>/dev/null || echo 0)
```
Insert:
- domain=`watchlist`, key=`active_items`, value=`$WATCHLIST_JSON`
- domain=`watchlist`, key=`active_items_summary`, value=`{"count": <WATCHLIST_COUNT>}`

### I) System Health
```bash
psql cortana -c "SELECT json_agg(t) FROM (SELECT source, message FROM cortana_events WHERE timestamp > NOW()-INTERVAL '24 hours' AND severity='error' LIMIT 5) t;"
```
Insert: domain=`system`, key=`recent_errors`.

## Finalization (required)
After all inserts, verify rows, then mark the run complete:

```bash
psql cortana -c "SELECT domain, key, substring(value::text, 1, 80) FROM cortana_sitrep WHERE run_id='$RUN_ID' ORDER BY domain;"
npx tsx tools/sae/wsb-run-tracker.ts complete "$RUN_ID"
```

Report any failures silently (no user notification unless critical).
