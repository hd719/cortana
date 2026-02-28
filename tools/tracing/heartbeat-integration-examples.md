# Heartbeat Decision Tracing Integration Examples

Use this helper from heartbeat flows:

```bash
/Users/hd/openclaw/tools/log-heartbeat-decision.sh <check_name> <outcome> <reasoning> <confidence> [data_inputs_json]
```

- `check_name`: heartbeat check identifier
- `outcome`: `success` | `skipped` | `fail`
- `reasoning`: short explanation of what happened
- `confidence`: numeric value between 0 and 1 (example: `0.91`)
- `data_inputs_json` (optional): JSON object with input facts used for the decision

## Per-check examples

### 1) Email Triage
```bash
/Users/hd/openclaw/tools/log-heartbeat-decision.sh email_triage success "Processed inbox triage; created 2 tasks" 0.93 '{"unread":12,"tasks_created":2}'
```

### 2) Calendar Lookahead
```bash
/Users/hd/openclaw/tools/log-heartbeat-decision.sh calendar skipped "Checked 2h ago; skip per 6h cadence" 0.99 '{"last_checked_hours_ago":2}'
```

### 3) Portfolio Alerts
```bash
/Users/hd/openclaw/tools/log-heartbeat-decision.sh portfolio success "No positions moved beyond 3% threshold" 0.88 '{"max_move_pct":2.1,"market_hours":true}'
```

### 4) Fitness Check-in
```bash
/Users/hd/openclaw/tools/log-heartbeat-decision.sh fitness success "Whoop recovery reviewed; workout already completed" 0.9 '{"recovery":74,"workout_done":true}'
```

### 5) Weather
```bash
/Users/hd/openclaw/tools/log-heartbeat-decision.sh weather success "Morning forecast captured for Warren, NJ" 0.95 '{"high_f":42,"precip_chance":0.3}'
```

### 6) API Budget Check
```bash
/Users/hd/openclaw/tools/log-heartbeat-decision.sh budget success "Budget usage below alert threshold" 0.92 '{"pct_used":41,"month_day":12}'
```

### 7) Tech News
```bash
/Users/hd/openclaw/tools/log-heartbeat-decision.sh tech_news fail "Search endpoint timed out; retry next cycle" 0.72 '{"source":"web_search","error":"timeout"}'
```

### 8) Mission Advancement
```bash
/Users/hd/openclaw/tools/log-heartbeat-decision.sh mission_advancement success "Added one auto-executable mission task" 0.87 '{"task_id":1234,"pillar":"career"}'
```

### 9) Task Queue Execution
```bash
/Users/hd/openclaw/tools/log-heartbeat-decision.sh task_queue_execution success "Executed top ready task from queue" 0.9 '{"task_id":5678,"status":"done"}'
```

### 10) System Health
```bash
/Users/hd/openclaw/tools/log-heartbeat-decision.sh system_health success "Watchlist scanned; no auto-heal actions needed" 0.94 '{"watchlist_items":6,"auto_heals":0}'
```

## Notes
- This wrapper always logs with `trigger_type=heartbeat`.
- `action_type` is auto-derived from `check_name` into one of:
  - `email_triage`, `calendar_check`, `portfolio_check`, `fitness_check`, `weather_check`, `budget_check`, `tech_news`, `mission_task`, `task_execution`, `system_health`
- Under the hood, it calls `/Users/hd/openclaw/tools/log-decision.sh`.
