# TOOLS.md – Monitor lane notes

- Telegram delivery account: `monitor`
- Covenant group session key: `agent:monitor:telegram:group:-5006548746`
- Runtime cron state: `~/.openclaw/cron/jobs.json`
- Tracked cron source: `/Users/hd/Developer/cortana/config/cron/jobs.json`
- Heartbeat state: `/Users/hd/Developer/cortana/memory/heartbeat-state.json`
- Session lifecycle policy: `/Users/hd/Developer/cortana/config/session-lifecycle-policy.json`
- Session lifecycle check: `npx --yes tsx /Users/hd/Developer/cortana/tools/session/session-lifecycle-policy.ts`
- Ops routing drift check: `npx tsx /Users/hd/Developer/cortana/tools/monitoring/ops-routing-drift-check.ts --repo-root /Users/hd/Developer/cortana`
