---
name: fitness-coach
description: >
  Analyze Whoop recovery/sleep/strain and Tonal strength data. Coach-style insights, not data dumps.
  USE WHEN: Recovery scores, sleep analysis, workout planning, strain optimization, strength progression, HRV trends, fitness briefings.
  DON'T USE: General health questions (use web_search), nutrition/diet tracking, medical advice, non-Whoop/Tonal fitness devices.
metadata: {"clawdbot":{"emoji":"🏋️","requires":{"bins":["curl"]}}}
---

# Fitness Coach

Coach-style fitness insights from Whoop + Tonal data. Analysis and actionable advice, not raw data tables.

## When NOT to Use This Skill

❌ "What should I eat today?" → Nutrition tracking not implemented yet
❌ "Is my heart rate normal?" → Not medical advice, consult a doctor
❌ "Sync my Garmin/Fitbit" → Only Whoop + Tonal supported
❌ "What exercises should I do for back pain?" → Use web_search or consult PT

## Data Endpoints

**Always check health first before fetching data:**

```bash
# Check if Tonal auth is valid
curl -s http://localhost:3033/tonal/health | jq -r '.status'
# Returns: "healthy" or "unhealthy"

# Whoop data (30 days cached)
curl -s http://localhost:3033/whoop/data

# Tonal data (workouts + strength scores)
curl -s http://localhost:3033/tonal/data
```

**If Tonal unhealthy:** The TypeScript service self-heals 401/403 once. Only use the manual reset flow if it stays unhealthy:
```bash
# Manual Tonal auth reset
rm -f ~/Developer/cortana-external/tonal_tokens.json
launchctl kickstart -k gui/$(id -u)/com.cortana.fitness-service
sleep 5

# Retry health check
curl -s http://localhost:3033/tonal/health | jq -r '.status'
```
If still unhealthy after self-heal: skip Tonal data gracefully, report Whoop-only insights, and alert user that manual intervention may be needed.

## Output Style

**DO:**
- Lead with the insight, not the number
- "Your recovery tanked because..." not "Recovery: 45%"
- Actionable recommendations
- Compare to personal baselines
- Max 300 words for daily briefings

**DON'T:**
- Data tables or raw JSON
- Generic fitness advice
- Overwhelming detail
- Medical diagnoses

## Hamel's Context

- **Weight:** 140 lbs
- **Current program:** 12 Weeks to Jacked (Tonal) — Week 8 of 12
- **Cardio:** Peloton treadmill
- **Sleep target:** Bed 9-9:30pm, wake 4:30-4:45am ET
- **Key insight:** Alcohol = red recovery days. Dry January = zero reds.
- **REM sleep:** Chronically low — watch for patterns

## Analysis Templates

### Morning Brief (Daily)
```
Fetch Whoop data. Provide:
1. Recovery score + one-line interpretation
2. Sleep quality verdict (duration, efficiency, REM/deep)
3. Today's training recommendation based on recovery
4. One specific thing to watch today

Keep under 150 words. Coach tone, not report tone.
```

### Evening Recap (Daily, if workout)
```
Fetch Whoop + Tonal data. Provide:
1. Strain earned today vs optimal for recovery
2. Workout summary (what muscle groups, volume)
3. Sleep recommendation for recovery
4. Any PRs or notable lifts

Keep under 200 words.
```

### Weekly Deep Dive (Sunday)
```
Fetch both endpoints. Analyze:
1. Week's wins (PRs, consistency, recovery trends)
2. Week's watch-outs (strain spikes, sleep debt, skipped days)
3. HRV trend (up/down/stable vs baseline)
4. Program progress (X of 12 weeks, on track?)
5. One focus for next week

Keep under 300 words. Celebrate progress, flag concerns.
```

## Specialist Analyses (Spawn as Sub-Agent)

For deep dives, spawn a sub-agent with these prompts:

### Sleep-Recovery Correlation
```
Analyze sleep-recovery correlation over 30 days.
- Which sleep metrics predict green recovery?
- Optimal sleep duration for green recovery
- Deep sleep / REM thresholds
- Time-to-bed patterns

Output: ~/Developer/cortana/memory/fitness/analysis/sleep-recovery-correlation.md
```

### Strength Progression
```
Analyze strength progression through Tonal program.
- Volume trends week over week
- 1RM estimates progression
- Which muscle groups showing most gains
- Compare early weeks to recent

Output: ~/Developer/cortana/memory/fitness/analysis/strength-progression.md
```

### Optimal Strain Analysis
```
Analyze strain vs next-day recovery relationship.
- Strain levels that lead to green vs yellow vs red
- Personal strain ceiling
- Cumulative strain patterns
- Recovery time after different strain levels

Output: ~/Developer/cortana/memory/fitness/analysis/optimal-strain.md
```

### HRV Trend Analysis
```
Deep dive into HRV patterns.
- 7/14/30-day averages
- Day-of-week patterns
- Correlation with sleep, strain
- Personal baseline and ranges
- Warning signs

Output: ~/Developer/cortana/memory/fitness/analysis/hrv-trends.md
```

## Cron Jobs (Reference)

These are already set up:
- **7:00am ET** — Morning Brief
- **8:30pm ET** — Evening Recap
- **Sunday 8pm ET** — Weekly Insights

## Service Details

**Repo:** `~/Developer/cortana-external/`
**App:** `~/Developer/cortana-external/apps/external-service/`
**Package:** `@cortana/external-service`

**Endpoints:**
- `http://localhost:3033/whoop/data` — All Whoop data (30 days cached)
- `http://localhost:3033/tonal/data` — All Tonal workouts + strength scores
- `http://localhost:3033/tonal/health` — Auth health check
- `http://localhost:3033/auth/url` — Whoop OAuth URL (re-auth if needed)

**Rate Limits:**
- Whoop: 100/min, 10k/day (each `/whoop/data` call uses ~6 API requests)
- Tonal: No documented limits, service has 500ms delay between requests

**Token Files:**
- Whoop: `~/Developer/cortana-external/whoop_tokens.json` (auto-refreshes)
- Tonal: `~/Developer/cortana-external/tonal_tokens.json` (auto-refreshes)

**Data Files:**
- Daily snapshots: `~/Developer/cortana/memory/fitness/YYYY-MM-DD.json`
- Weekly summaries: `~/Developer/cortana/memory/fitness/weekly/`

**Tonal Program API (direct, if needed):**
```bash
# Get program details
curl -H "Authorization: Bearer $TONAL_TOKEN" \
  "https://api.tonal.com/v6/programs/7d4d1d3d-9da9-4722-9e8c-fb65e45845a8"
```
- Program ID: `7d4d1d3d-9da9-4722-9e8c-fb65e45845a8` (12 Weeks to Jacked)
- Enrollment ID: `1040607b-9195-4a43-ba84-8bab1b4ba277`

## Troubleshooting

**Tonal auth fails:**
⚠️ **Self-healing is automatic in the TypeScript service.** On 401/403 it deletes the token file, re-authenticates, and retries once before the agent needs to step in.

Manual fix (if auto-heal fails):
```bash
# Delete tokens to force re-auth
rm ~/Developer/cortana-external/tonal_tokens.json
# Restart service
launchctl kickstart -k gui/$(id -u)/com.cortana.fitness-service
```

**Whoop data stale:**
Tokens auto-refresh. If issues, check `~/Developer/cortana-external/whoop_tokens.json`.

**Service not running:**
```bash
curl -s http://localhost:3033/tonal/health >/dev/null || launchctl kickstart -k gui/$(id -u)/com.cortana.fitness-service
```

**TypeScript service debugging:**
```bash
tail -50 /tmp/fitness-service.log
tail -50 /tmp/fitness-service-error.log

cd ~/Developer/cortana-external
pnpm --filter @cortana/external-service dev
pnpm --filter @cortana/external-service test
pnpm --filter @cortana/external-service typecheck
```
