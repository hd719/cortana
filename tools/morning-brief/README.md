# Morning Brief Orchestration (Phase 2)

## Script
- `tools/morning-brief/orchestrate-brief.ts`
- Purpose: fan out specialist requests, gather weather/calendar, compose one unified brief, send to Hamel Telegram (`8171372724`).

## Cron job to update (documented only)
Current morning brief cron still points to the deterministic command-brief pipeline.

- Config file: `config/cron/jobs.json`
- Job name: `☀️ Morning brief (Hamel)`
- Job id: `489b1e20-1bb0-48e6-a388-c3cc1743a324`
- Current payload message references the deployed runtime path: `/Users/hd/openclaw/tools/briefing/run-daily-command-brief.sh`

To move to Phase 2 orchestration, this is the job whose payload should be updated later to run:
- Source file in this repo: `tools/morning-brief/orchestrate-brief.ts`
- Deployed runtime path while `~/openclaw` remains active: `/Users/hd/openclaw/tools/morning-brief/orchestrate-brief.ts`

Per request, cron config was not modified in this change.
