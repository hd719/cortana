#!/bin/bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
CURRENT=$(psql cortana -t -c "SELECT value::text FROM cortana_chief_model WHERE key='cortical_loop_enabled';" | tr -d ' "')
if [ "$CURRENT" = "true" ]; then
  psql cortana -q -c "UPDATE cortana_chief_model SET value = '\"false\"', updated_at = NOW(), source = 'manual_toggle' WHERE key = 'cortical_loop_enabled';"
  echo "Cortical Loop: DISABLED"
else
  psql cortana -q -c "UPDATE cortana_chief_model SET value = '\"true\"', updated_at = NOW(), source = 'manual_toggle' WHERE key = 'cortical_loop_enabled';"
  psql cortana -q -c "UPDATE cortana_chief_model SET value = jsonb_build_object('count', 0, 'date', '$(TZ=America/New_York date +%Y-%m-%d)', 'max', (SELECT (value->>'max')::int FROM cortana_chief_model WHERE key='daily_wake_count')), updated_at = NOW() WHERE key = 'daily_wake_count';"
  echo "Cortical Loop: ENABLED"
fi
