-- Seed decision traces from recent events + synthetic timeline activity.
-- Usage:
--   export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
--   psql cortana -f /Users/hd/clawd/tools/tracing/seed-decision-traces.sql

BEGIN;

-- 1) Real traces from cortana_events (last 7 days)
INSERT INTO cortana_decision_traces (
  trace_id,
  event_id,
  trigger_type,
  action_type,
  action_name,
  reasoning,
  confidence,
  outcome,
  data_inputs,
  metadata,
  created_at,
  completed_at
)
SELECT
  gen_random_uuid()::text AS trace_id,
  e.id AS event_id,
  CASE
    WHEN e.event_type = 'manual_heartbeat' THEN 'heartbeat'
    WHEN e.event_type = 'auto_heal' THEN 'auto_heal'
    WHEN e.event_type = 'watchdog' THEN 'watchdog'
    WHEN e.event_type IN ('health_check', 'memory_health', 'proprioception_check', 'tonal_health_check', 'behavioral_check') THEN 'self_check'
    WHEN e.event_type IN ('cron_health', 'session_cleanup') THEN 'cron'
    WHEN e.event_type IN ('cost_anomaly', 'service_down', 'auth_error') THEN 'watchdog'
    WHEN e.event_type = 'cortical_wake' THEN 'proactive'
    ELSE 'self_check'
  END AS trigger_type,
  CASE
    WHEN e.event_type = 'auto_heal' THEN 'self_heal'
    WHEN e.event_type = 'manual_heartbeat' THEN 'task_execution'
    WHEN e.event_type = 'watchdog' THEN 'system_check'
    WHEN e.event_type = 'health_check' THEN 'system_check'
    WHEN e.event_type = 'memory_health' THEN 'reflection'
    WHEN e.event_type = 'proprioception_check' THEN 'budget_check'
    WHEN e.event_type = 'tonal_health_check' THEN 'fitness_check'
    WHEN e.event_type = 'behavioral_check' THEN 'reflection'
    WHEN e.event_type = 'cron_health' THEN 'task_execution'
    WHEN e.event_type = 'session_cleanup' THEN 'self_heal'
    WHEN e.event_type = 'cost_anomaly' THEN 'budget_check'
    WHEN e.event_type = 'auth_error' THEN 'system_check'
    WHEN e.event_type = 'service_down' THEN 'system_check'
    WHEN e.event_type = 'bug_fix' THEN 'task_execution'
    WHEN e.event_type = 'cortical_wake' THEN 'reflection'
    ELSE 'system_check'
  END AS action_type,
  COALESCE(NULLIF(e.source, ''), e.event_type, 'event_handler') AS action_name,
  e.message AS reasoning,
  CASE
    WHEN lower(COALESCE(e.severity, '')) = 'info' THEN 0.9000
    WHEN lower(COALESCE(e.severity, '')) = 'warning' THEN 0.7000
    WHEN lower(COALESCE(e.severity, '')) = 'error' THEN 0.5000
    WHEN lower(COALESCE(e.severity, '')) = 'critical' THEN 0.4000
    ELSE 0.6000
  END AS confidence,
  CASE
    WHEN lower(COALESCE(e.severity, '')) IN ('error', 'critical') THEN 'fail'
    WHEN lower(COALESCE(e.severity, '')) = 'warning' THEN 'unknown'
    ELSE 'success'
  END AS outcome,
  jsonb_build_object(
    'event_type', e.event_type,
    'event_source', e.source,
    'event_severity', e.severity
  ) AS data_inputs,
  jsonb_build_object(
    'seed_source', 'cortana_events',
    'seed_script', 'tools/tracing/seed-decision-traces.sql'
  ) AS metadata,
  e.timestamp AS created_at,
  CASE
    WHEN lower(COALESCE(e.severity, '')) IN ('error', 'critical', 'warning') THEN NULL
    ELSE e.timestamp + INTERVAL '3 seconds'
  END AS completed_at
FROM cortana_events e
WHERE e.timestamp >= NOW() - INTERVAL '7 days'
  AND NOT EXISTS (
    SELECT 1 FROM cortana_decision_traces dt WHERE dt.event_id = e.id
  );

-- 2) Synthetic but realistic traces (last 48 hours)
INSERT INTO cortana_decision_traces (
  trace_id,
  trigger_type,
  action_type,
  action_name,
  reasoning,
  confidence,
  outcome,
  data_inputs,
  metadata,
  created_at,
  completed_at
)
SELECT
  gen_random_uuid()::text,
  s.trigger_type,
  s.action_type,
  s.action_name,
  s.reasoning,
  s.confidence,
  s.outcome,
  s.data_inputs,
  jsonb_build_object(
    'seed_source', 'synthetic_timeline',
    'seed_script', 'tools/tracing/seed-decision-traces.sql'
  ),
  s.created_at,
  CASE WHEN s.outcome IN ('success', 'fail', 'skipped') THEN s.created_at + INTERVAL '5 seconds' ELSE NULL END
FROM (
  VALUES
    ('heartbeat','email_triage','gmail-triage','Checked email inbox — 3 unread, none urgent',0.9500,'success','{"inbox_unread":3,"urgent":0}'::jsonb, NOW() - INTERVAL '47 hours 10 minutes'),
    ('user_request','spawn_agent','huragok-research','Spawned Huragok for deep research on policy edge-cases',0.9900,'success','{"agent":"huragok","topic":"policy edge-cases"}'::jsonb, NOW() - INTERVAL '44 hours 40 minutes'),
    ('auto_heal','self_heal','session-cleanup','Auto-deleted bloated session file (482KB)',0.9200,'success','{"file_size_kb":482,"path":"~/.openclaw/sessions/tmp-482kb.json"}'::jsonb, NOW() - INTERVAL '43 hours 20 minutes'),
    ('heartbeat','portfolio_check','market-watch','Skipped portfolio check — market closed',0.8500,'skipped','{"market":"NYSE","status":"closed"}'::jsonb, NOW() - INTERVAL '40 hours 5 minutes'),
    ('cron','task_execution','morning-brief','Morning brief delivered',0.9500,'success','{"channel":"telegram","schedule":"06:00 ET"}'::jsonb, NOW() - INTERVAL '35 hours 55 minutes'),
    ('heartbeat','weather_check','warren-weather','Weather check: clear skies Warren NJ',0.9000,'success','{"location":"Warren, NJ","condition":"clear"}'::jsonb, NOW() - INTERVAL '33 hours 42 minutes'),
    ('proactive','fitness_check','whoop-recovery-review','REM sleep low — flagged for Chief',0.8800,'success','{"rem_minutes":62,"baseline_min":90}'::jsonb, NOW() - INTERVAL '31 hours 15 minutes'),
    ('watchdog','system_check','gateway-watchdog','OpenClaw gateway latency spike detected and normalized',0.8100,'success','{"latency_ms":780,"post_recovery_ms":110}'::jsonb, NOW() - INTERVAL '29 hours 48 minutes'),
    ('self_check','budget_check','token-budget-guard','Budget burn rate elevated — enabled throttle tier 1',0.8600,'success','{"burn_rate":"high","tier":1}'::jsonb, NOW() - INTERVAL '26 hours 30 minutes'),
    ('user_request','task_execution','issue-sync','Converted meeting notes into 4 structured tasks',0.9400,'success','{"tasks_created":4,"source":"meeting notes"}'::jsonb, NOW() - INTERVAL '23 hours 18 minutes'),
    ('cron','calendar_check','next-24h-calendar','Checked next 24h calendar — no conflicts',0.9300,'success','{"events_next_24h":2,"conflicts":0}'::jsonb, NOW() - INTERVAL '21 hours 2 minutes'),
    ('watchdog','system_check','db-watchdog','PostgreSQL restart required after lock timeout',0.7300,'fail','{"lock_timeout":true,"restart_attempted":false}'::jsonb, NOW() - INTERVAL '18 hours 14 minutes'),
    ('heartbeat','portfolio_check','pre-market-scan','Pre-market portfolio scan complete',0.8900,'success','{"positions_reviewed":12,"alerts":1}'::jsonb, NOW() - INTERVAL '15 hours 27 minutes'),
    ('auto_heal','self_heal','session-prune','Pruned stale session cache and restored heartbeat cadence',0.9100,'success','{"stale_files":6}'::jsonb, NOW() - INTERVAL '12 hours 44 minutes'),
    ('proactive','reflection','pattern-detection','Detected late-night work streak — suggested wind-down routine',0.8400,'success','{"late_night_streak_days":3}'::jsonb, NOW() - INTERVAL '10 hours 9 minutes'),
    ('self_check','system_check','toolchain-self-test','Toolchain self-check passed (gog, calendar, weather)',0.9200,'success','{"checks":["gog","calendar","weather"]}'::jsonb, NOW() - INTERVAL '7 hours 36 minutes'),
    ('heartbeat','calendar_check','schedule-scan','Upcoming event in 90 minutes — prep reminder queued',0.9000,'success','{"next_event_in_min":90}'::jsonb, NOW() - INTERVAL '4 hours 20 minutes'),
    ('cron','task_execution','evening-summary','Evening summary skipped due to quiet channel window',0.8000,'skipped','{"quiet_hours":true}'::jsonb, NOW() - INTERVAL '2 hours 6 minutes'),
    ('user_request','spawn_agent','deep-dive-agent','Spawned sub-agent for multi-repo CI triage',0.9700,'success','{"repos":3,"priority":"high"}'::jsonb, NOW() - INTERVAL '55 minutes')
) AS s(trigger_type, action_type, action_name, reasoning, confidence, outcome, data_inputs, created_at)
WHERE NOT EXISTS (
  SELECT 1
  FROM cortana_decision_traces dt
  WHERE dt.metadata->>'seed_source' = 'synthetic_timeline'
    AND dt.action_name = s.action_name
    AND dt.reasoning = s.reasoning
    AND dt.created_at BETWEEN s.created_at - INTERVAL '15 minutes' AND s.created_at + INTERVAL '15 minutes'
);

COMMIT;

-- Verification view requested by task
SELECT COUNT(*) AS trace_count, trigger_type, action_type
FROM cortana_decision_traces
GROUP BY trigger_type, action_type
ORDER BY trigger_type, action_type;
