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

## Not in Sitrep (must fetch fresh)

These are NOT gathered by the World State Builder:
- **News/RSS** — always fetch fresh via news-summary skill or web_search
- **API usage stats** — run `node /Users/hd/clawd/skills/telegram-usage/handler.js`
- **Material stock news** — web_search for earnings, SEC filings, etc.
