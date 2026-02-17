-- Seed playbooks for Immune System

INSERT INTO cortana_immune_playbooks (name, threat_signature, description, actions, tier) VALUES
('tonal_token_reset', 'auth_failure:tonal:token_expired', 'Reset Tonal auth token when expired',
 '[{"type": "shell", "command": "rm -f ~/.tonal/token.json"}, {"type": "shell", "command": "brew services restart fitness-service 2>/dev/null || true"}]', 1),

('session_cleanup', 'resource:session_files:bloated', 'Delete OpenClaw session files over 400KB',
 '[{"type": "shell", "command": "find ~/.openclaw/sessions -name \"*.json\" -size +400k -delete 2>/dev/null || true"}]', 1),

('fitness_service_restart', 'api_error:fitness_service:unresponsive', 'Restart fitness service when port 8080 is unresponsive',
 '[{"type": "shell", "command": "brew services restart fitness-service 2>/dev/null || true"}]', 1),

('browser_restart', 'api_error:browser:unresponsive', 'Restart OpenClaw browser when port 18800 is unresponsive',
 '[{"type": "shell", "command": "openclaw browser restart 2>/dev/null || true"}]', 1),

('cron_unstick', 'cron_failure:*:consecutive_3plus', 'Investigate and alert on crons failing 3+ times',
 '[{"type": "log", "message": "Cron stuck — check for zombie process and restart"}]', 2),

('budget_throttle', 'budget_burn:*:spike', 'Trigger throttle escalation on budget burn spike',
 '[{"type": "log", "message": "Budget burn spike detected — escalating throttle tier"}]', 2),

('tool_cascade', 'cascade:tools:3plus_down', 'Quarantine non-essential crons when 3+ tools are down',
 '[{"type": "log", "message": "Tool cascade — quarantining non-essential components"}]', 3),

('runaway_cron', 'token_runaway:cron:10x_normal', 'Suspend cron burning 10× normal tokens',
 '[{"type": "log", "message": "Runaway cron detected — suspending"}]', 3),

('auth_cascade', 'auth_failure:*:3plus_1h', 'Quarantine services with cascading auth failures',
 '[{"type": "log", "message": "Auth cascade — quarantining affected services"}]', 3)

ON CONFLICT (name) DO NOTHING;
