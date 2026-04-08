# Cron Reliability Hardening (2026-03-03)

This update bundles low-risk reliability improvements across cron scheduling and delivery.

## Included changes

1. **Stock-analysis command standardization**
   - Active cron prompts now use:
     - `npx tsx src/stock_analysis/main.ts analyze <TICKER> --json`
   - Removed legacy command drift in active cron paths.

2. **Delivery mode normalization**
   - Jobs that explicitly instruct `message` tool now use `delivery.mode: "none"`.
   - Removed redundant prompt-level delivery text where it conflicted with delivery mode behavior.
   - Goal: no mixed manual+announce ambiguity.

3. **Collect → summarize split for heavy jobs**
   - Added pre-collection jobs:
     - `📈 Stock Market Brief (collect)` → `/tmp/cron-stock-market-brief.json`
     - `🌙 Fitness Evening Recap (collect)` → `/tmp/cron-fitness-evening-recap.json`
   - Existing brief/recap jobs now prefer artifact-first summarization with fallback inline collection.

4. **Daily cron SLO monitor**
   - Added `tools/monitoring/cron-slo-monitor.ts`
   - New daily cron only alerts when thresholds exceed; otherwise outputs `NO_REPLY`.

5. **Runtime-vs-repo drift monitor**
   - Added `tools/monitoring/runtime-repo-drift-monitor.ts`
   - Read-only git-aware comparison for source repo vs runtime checkout health.
   - Alerts only on detected drift; `NO_REPLY` when healthy.

## Operational notes

- Monitors are read-only and non-destructive.
- No direct edits to `~/.openclaw` runtime files were made.
- To apply repo cron changes to runtime, deploy from source repo into the runtime checkout and sync runtime state from tracked config.
