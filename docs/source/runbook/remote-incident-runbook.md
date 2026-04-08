# Remote Incident Runbook (Away From Machine)

This is the operator runbook for vacation/weekend incidents when direct desktop access is limited.

## Goal
- Restore core lanes first: gateway, Telegram delivery, critical cron reminders.
- Prefer bounded fixes already in automation before manual intervention.
- Escalate quickly when a flow needs human auth/permission.

## Triage Order (strict)
1. **Control plane**  
   Run `openclaw gateway status` and `openclaw status`.  
   If unhealthy, run `openclaw doctor --fix`.
2. **Boot validation**  
   Check `/Users/hd/Developer/cortana/tmp/boot-validate-system.stdout.log` and `.stderr.log`.  
   Confirm `validate-system.ts` is executing cleanly.
3. **Delivery path**  
   Run `npx tsx tools/alerting/check-cron-delivery.ts`.  
   Any fresh failure means Monitor-owned escalation is required.
4. **Critical lanes**  
   Inspect `~/.openclaw/cron/jobs.json` for family-critical jobs (`config/autonomy-lanes.json`).  
   Prioritize calendar/reminder lanes.
5. **Browser/CDP lane**  
   Run `npx tsx tools/monitoring/browser-cdp-watchdog.ts`.  
   It allows one restart path, then escalates.

## Human-Required Failures
- Apple Reminders privacy/TCC permissions
- OAuth re-consent flows (Gog/Google/OpenAI Codex auth)
- Browser login/session renewal

Do not loop retries for these. Alert once with the exact manual step needed.

## Exit Criteria
- `openclaw status` healthy
- `check-cron-delivery.ts` passes
- no unresolved family-critical cron failures
- no repeated `control_plane` escalations from browser watchdog
