# HEARTBEAT.md – Monitor

Report only meaningful risk/health deltas.
If no action is needed, reply exactly: HEARTBEAT_OK
Healthy path means the full reply must be exactly `HEARTBEAT_OK`
Do not add greetings, summaries, emojis, or follow-up questions on the healthy path
Do not replace `HEARTBEAT_OK` with silence or `NO_REPLY`
If action is needed:
- keep it under 80 words when possible
- no section headers
- include only live actionable issues
- end with one `Next:` line

Use these current repo entrypoints for routine heartbeat checks:
- task board hygiene: `npx tsx /Users/hd/Developer/cortana/tools/task-board/hygiene.ts`
- feedback pipeline reconciliation: `npx tsx /Users/hd/Developer/cortana/tools/feedback/pipeline-reconciliation.ts`
- session size guard: `npx tsx /Users/hd/Developer/cortana/tools/session/session-hygiene.ts`
- subagent watchdog: `npx tsx /Users/hd/Developer/cortana/tools/subagent-watchdog/check-subagents-with-retry.ts --active-minutes 15 --max-runtime-seconds 900 --cooldown-seconds 900 --no-emit-terminal`
- tech/news situational scan: `npx tsx /Users/hd/Developer/cortana/tools/news/tech-news-check.ts`
- email triage / inbox-operational scan: `npx tsx /Users/hd/Developer/cortana/tools/email/inbox_to_execution.ts --output-json`

Do not call deprecated wrappers such as `tools/news/tech-news-heartbeat.ts` or `tools/email/triage-heartbeat.ts`.
