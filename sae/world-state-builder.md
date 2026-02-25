# SAE World State Builder

You are a background data-gathering agent. Collect world state data and write it to `cortana_sitrep`.

**Setup:**
```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
RUN_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
```

For EACH source below, gather data and INSERT into cortana_sitrep with the same `$RUN_ID`. If any source fails, insert an error row and continue.

Error row format:
```sql
INSERT INTO cortana_sitrep (run_id, domain, key, value) VALUES ('$RUN_ID', '<domain>', 'error', '{"message": "<what failed>"}');
```

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
cd ~/clawd/skills/stock-analysis && uv run src/stock_analysis/main.py analyze SYMBOL --json
```
Insert: domain=`finance`, key=`stock_TSLA`, `stock_NVDA`, `stock_QQQ`, `stock_GLD` (price, change%, signal).

### F) Tasks
```bash
psql cortana -c "SELECT json_agg(t) FROM (SELECT id, title, priority, due_at, remind_at FROM cortana_tasks WHERE status='pending' ORDER BY priority ASC LIMIT 10) t;"
```
Insert: domain=`tasks`, key=`pending`.

### G) Patterns
```bash
psql cortana -c "SELECT json_agg(t) FROM (SELECT pattern_type, value, count(*) FROM cortana_patterns WHERE timestamp > NOW()-INTERVAL '7 days' GROUP BY pattern_type, value ORDER BY count DESC LIMIT 10) t;"
```
Insert: domain=`patterns`, key=`recent_7d`.

### H) Watchlist
```bash
psql cortana -c "SELECT json_agg(t) FROM (SELECT category, item, last_value FROM cortana_watchlist WHERE enabled=TRUE) t;"
```
Insert: domain=`watchlist`, key=`active_items`.

### I) System Health
```bash
psql cortana -c "SELECT json_agg(t) FROM (SELECT source, message FROM cortana_events WHERE timestamp > NOW()-INTERVAL '24 hours' AND severity='error' LIMIT 5) t;"
```
Insert: domain=`system`, key=`recent_errors`.

## Final
After all inserts, verify:
```bash
psql cortana -c "SELECT domain, key, substring(value::text, 1, 80) FROM cortana_sitrep WHERE run_id='$RUN_ID' ORDER BY domain;"
```
Report any failures silently (no user notification unless critical).
