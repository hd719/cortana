# Tools

## Decision Trace Logging (`log-decision.sh`)

Use this helper to log Cortana decision traces into PostgreSQL (`cortana_decision_traces`).

### Script

`/Users/hd/openclaw/tools/log-decision.sh`

### Usage

```bash
./log-decision.sh <trigger_type> <action_type> <action_name> <outcome> [reasoning] [confidence] [event_id] [task_id] [data_inputs_json]
```

### Required args

1. `trigger_type` (examples: `heartbeat`, `user_request`, `auto_heal`, `cron`, `watchdog`, `self_check`, `proactive`)
2. `action_type` (examples: `task_execution`, `system_check`, `budget_check`, `email_triage`, `calendar_check`, `weather_check`, `portfolio_check`, `fitness_check`, `reflection`, `spawn_agent`, `self_heal`)
3. `action_name` (short name for the decision)
4. `outcome` (`success`, `fail`, `skipped`, `unknown`)

### Optional args

5. `reasoning` (text)
6. `confidence` (numeric, e.g. `0.95`)
7. `event_id` (linked `cortana_events.id`)
8. `task_id` (linked task id)
9. `data_inputs_json` (JSON blob; defaults to `{}`)

### Example

```bash
/Users/hd/openclaw/tools/log-decision.sh \
  heartbeat email_triage "gmail-triage" success \
  "Checked email inbox — 3 unread, none urgent" \
  0.95 "" "" '{"inbox_unread":3,"urgent":0}'
```

### Behavior

- Generates and stores a UUID `trace_id`
- Inserts one row in `cortana_decision_traces`
- Prints the `trace_id` to stdout
- Handles missing optional params gracefully
