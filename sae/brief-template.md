# SAE Brief Template

Reusable template for any brief that pulls from the Situational Awareness Engine.

## Standard Preamble (copy into any brief cron)

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

# 1. Pull full sitrep (all domains)
SITREP=$(psql cortana -t -A -c "SELECT json_object_agg(domain || '.' || key, value) FROM cortana_sitrep_latest;")

# 2. Check freshness
SITREP_AGE=$(psql cortana -t -A -c "SELECT EXTRACT(EPOCH FROM (NOW() - MAX(timestamp)))/3600 FROM cortana_sitrep;")

# 3. Pull unacted insights
INSIGHTS=$(psql cortana -t -A -c "SELECT json_agg(t) FROM (SELECT id, insight_type, domains, title, description, priority, action_suggested FROM cortana_insights WHERE acted_on = FALSE AND timestamp > NOW() - INTERVAL '4 hours' ORDER BY priority ASC) t;")
```

## Domain-Specific Pull (use when you only need one domain)

```bash
# Single domain
VALUE=$(psql cortana -t -A -c "SELECT value FROM cortana_sitrep_latest WHERE domain = '<domain>' AND key = '<key>';")

# Domain-filtered insights
DOMAIN_INSIGHTS=$(psql cortana -t -A -c "SELECT json_agg(t) FROM (SELECT id, title, description, action_suggested FROM cortana_insights WHERE acted_on = FALSE AND '<domain>' = ANY(domains) ORDER BY priority ASC) t;")
```

## Available Domains & Keys

| Domain | Keys | Source |
|--------|------|--------|
| calendar | events_48h, next_event | Google Calendar via gog |
| email | unread_summary | Gmail via gog |
| weather | today, tomorrow | Web search |
| health | whoop_recovery, whoop_sleep, tonal_health | Whoop/Tonal APIs |
| finance | portfolio_snapshot, stock_* | stock-analysis skill |
| tasks | pending | cortana_tasks table |
| patterns | recent_7d | cortana_patterns table |
| watchlist | active_items | cortana_watchlist table |
| system | recent_errors | cortana_events table |

## Freshness Fallback Pattern

Every brief MUST include this logic:

```
If sitrep data for <domain> is missing or stale (>4 hours):
  → Fall back to direct data gathering for that domain
  → Note: "⚠️ Using live data (sitrep stale)"
```

## Insight Delivery Pattern

After including insights in a brief:

```bash
psql cortana -c "UPDATE cortana_insights SET acted_on = TRUE, acted_at = NOW() WHERE acted_on = FALSE AND timestamp > NOW() - INTERVAL '4 hours';"
```

Or for domain-specific:
```bash
psql cortana -c "UPDATE cortana_insights SET acted_on = TRUE, acted_at = NOW() WHERE acted_on = FALSE AND '<domain>' = ANY(domains);"
```

## Morning Brief Task Board Block (live)

Add this block to morning brief generation so task/epic progress is always visible:

```bash
EPICS=$(psql cortana -t -A -c "SELECT json_agg(t) FROM (SELECT e.title, e.deadline, COUNT(t.id) AS total_tasks, COUNT(CASE WHEN t.status='done' THEN 1 END) AS completed_tasks FROM cortana_epics e LEFT JOIN cortana_tasks t ON t.epic_id=e.id WHERE e.status='active' GROUP BY e.id, e.title, e.deadline ORDER BY e.deadline ASC NULLS LAST) t;")

STANDALONE=$(psql cortana -t -A -c "SELECT json_agg(t) FROM (SELECT title, priority, due_at, status FROM cortana_tasks WHERE epic_id IS NULL AND status IN ('pending','in_progress') ORDER BY priority ASC, due_at ASC NULLS LAST LIMIT 5) t;")

URGENT=$(psql cortana -t -A -c "SELECT json_agg(t) FROM (SELECT id, title, due_at, priority, CASE WHEN due_at < NOW() THEN 'OVERDUE' WHEN due_at < NOW() + INTERVAL '24 hours' THEN 'DUE_TODAY' ELSE 'UPCOMING' END AS urgency FROM cortana_tasks WHERE status='pending' AND due_at IS NOT NULL AND due_at <= NOW() + INTERVAL '48 hours' ORDER BY due_at ASC) t;")

READY=$(psql cortana -t -A -c "SELECT COUNT(*) FROM cortana_tasks WHERE status='pending' AND auto_executable=TRUE AND (depends_on IS NULL OR NOT EXISTS (SELECT 1 FROM cortana_tasks t2 WHERE t2.id = ANY(cortana_tasks.depends_on) AND t2.status != 'done'));")
```

If all task board result sets are empty, output: `📋 Task board clear - no pending work`.

## Not in Sitrep (must fetch fresh)

These are NOT gathered by the World State Builder:
- **News/RSS** — always fetch fresh via news-summary skill or web_search
- **API usage stats** — run `node /Users/hd/openclaw/skills/telegram-usage/handler.js`
- **Material stock news** — web_search for earnings, SEC filings, etc.
