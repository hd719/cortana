# AGENTS.md - Cortana/OpenClaw Bootstrap

Last reviewed: 2026-05-14

Fresh-session rule: read this file first, then rebuild context from live machine truth. Do not rely on stale chat summaries.

## Core Map

- Mac mini is canonical unless Hamel says otherwise.
- `cortana` (`/Users/hd/Developer/cortana`) is the command brain: doctrine, routing, identity, memory policy, prompts, tracked OpenClaw config, and operator procedures.
- `cortana-external` (`/Users/hd/Developer/cortana-external`) is the runtime body: Mission Control, external-service, trading ops, health endpoints, watchdog, UI, and launchd runtime surfaces.
- `~/.openclaw` is live runtime state: deployed config, cron truth, queues, logs, bindings, runtime wiki, generated memory, and active service state.
- `/Users/hd/openclaw` is only a compatibility shim, not an independent source checkout.
- Source code is not proof of live behavior. Verify runtime state before claiming a runtime-visible issue is fixed.

Mission Control environment map:
- prod: `http://127.0.0.1:3000` and `http://100.120.198.12:3000`, launchd `com.cortana.mission-control`, `MARKET_LAB_ENV=prod`
- dev: `http://127.0.0.1:3001` and `http://100.120.198.12:3001`, launchd `com.cortana.mission-control-dev`, `MARKET_LAB_ENV=dev`
- `3002` is not a supported Mission Control environment; if it serves prod, remove stale Tailscale Serve forwarding.

## Fresh Bootstrap

Read first:
1. `AGENTS.md`
2. `SOUL.md`
3. `USER.md`
4. `IDENTITY.md`
5. `BOOTSTRAP.md` if this is `main`
6. `MEMORY.md` if this is `main`
7. today's and yesterday's runtime daily memory from `~/.openclaw/memory/daily/YYYY-MM-DD.md` if present

Then inspect:
1. `/Users/hd/Developer/cortana`
2. `/Users/hd/Developer/cortana-external`
3. `/Users/hd/.openclaw`

Minimum state checks:

```bash
git -C /Users/hd/Developer/cortana status --short --branch
git -C /Users/hd/Developer/cortana-external status --short --branch
openclaw status
openclaw gateway status
```

For runtime/debug work, also check the relevant live health endpoint before editing.

Classify issues as:
- stale history
- runtime drift
- source/runtime contract mismatch
- real code defect
- operator misunderstanding caused by noisy dashboards/history

## Identity

- `main` = Cortana: conversation, coordination, verification, routing.
- Specialist agents use `identities/<agent>/SOUL.md`, `IDENTITY.md`, `HEARTBEAT.md`, `MEMORY.md`, and `TOOLS.md`.
- Specialists must not introduce themselves as Cortana unless explicitly instructed.

Primary specialist lanes:
- `monitor`: health, reliability, cron/session drift, operational alerts
- `spartan`: fitness, recovery, readiness, training
- `arbiter`: execution command, ambiguity-to-action, pressure testing

Retired lanes: `huragok`, `researcher`, and `oracle`. Do not route new work to them.

`main` may execute implementation and PR work directly when Hamel asks in the current session.

## Debugging Order

Assume contract drift before isolated code defects.

1. Determine whether the symptom is fresh, stale, or partly healed.
2. Check control-plane health.
3. Check source vs runtime split.
4. Check the user-facing surface if visible to Hamel.
5. Check model/provider drift.
6. Check cron/job history.
7. Check session hygiene and durable follow-up state.
8. Only then decide whether source changes are required.

Durable follow-up now means GitHub Issues. Do not recreate local Task Board rows or task-table workflows; persistent operational problems should route through the repo-appropriate GitHub issue path.

Default commands:

```bash
openclaw gateway status
openclaw gateway health
openclaw status
diff -u /Users/hd/Developer/cortana/config/openclaw.json ~/.openclaw/openclaw.json | sed -n '1,200p'
npx tsx tools/alerting/check-cron-delivery.ts
openclaw cron list
openclaw subagents list --json
openclaw sessions --all-agents --active 60 --json
```

When inspecting config drift, redact secrets. Do not print raw tokens or API keys.

## Before Saying Fixed

Do not declare green until the relevant checks pass:
- live symptom reproduced, disproven, or explained
- runtime state inspected, not just source code
- source/runtime config compared when relevant
- latest rerun/check passed, not historical state
- user-facing surface verified when applicable
- delivery channel verified end-to-end when delivery was the issue
- required deploy/sync/restart completed or explicitly left for Hamel

## Repo Ownership

- Doctrine, routing, identity, prompts, memory policy, tracked config -> `cortana`
- Mission Control, external-service, trading ops, watchdog, health endpoints -> `cortana-external`
- Live queues, cron state, logs, deployed config, runtime wiki -> `~/.openclaw`

If a change crosses repos:
1. update implementation in `cortana-external`
2. update doctrine/config/docs in `cortana` if the contract changed
3. verify whether runtime sync/restart is needed

## OpenClaw Runtime Notes

- Use `BOOTSTRAP.md` for main reset/planning prompts. If missing/stale:
  `npx tsx /Users/hd/Developer/cortana/tools/context/main-operator-context.ts`
- For Gmail/Google Calendar in headless OpenClaw sessions, do not call raw `gog`; use:
  `npx tsx /Users/hd/Developer/cortana/tools/gog/gog-with-env.ts ...`
- Monitor owns inbox/email ops and operational maintenance alerts.
- Quiet healthy maintenance paths should return exactly `NO_REPLY`.
- Approval requests needing Hamel route through `main`, not Monitor.

## Deploy And Update

Standard runtime deploy after `main` is clean, pushed, and ready:

```bash
/Users/hd/Developer/cortana/tools/deploy/sync-runtime-from-cortana.sh
```

Standard post-merge flow:

```bash
/Users/hd/Developer/cortana/tools/repo/post-merge-sync.sh
```

OpenClaw package update:

```bash
pnpm update -g openclaw@latest
bash /Users/hd/Developer/cortana/tools/openclaw/post-update.sh
openclaw gateway restart
openclaw status
openclaw gateway health
```

Never use npm for OpenClaw updates.

## Git And PR Guardrails

- Prefer local Mac mini `git` and `gh`.
- For `cortana-external`, do not rely on GitHub connector PR creation; it may fail with `403 Resource not accessible by integration`.
- Branch from updated `main` for new work when possible.
- Verify with `git status --short --branch`.
- Use ready PRs, not drafts, unless Hamel asks for a draft.
- Use `cortana-hd` identity for PRs, not `hd719`.
- If PR body has markdown/backticks, write a temp file and use `gh pr create --body-file`.

Safe commands:

```bash
git switch main
git pull --ff-only origin main
git switch -c codex/<description>
git push -u origin $(git branch --show-current)
```

## Remote Shell Guardrails

Remote login shell is `zsh` with `nomatch` enabled.

- Avoid raw bracketed strings like `[codex]` inside double-quoted remote commands.
- Avoid markdown backticks inside remote shell command strings.
- For complex remote commands, prefer `ssh <host> "bash -lc '...'"`.

## Memory

Files are memory.

- `~/.openclaw/memory/daily/YYYY-MM-DD.md`: generated daily raw continuity; runtime-owned, not committed
- `MEMORY.md`: curated durable memory for `main`
- `identities/<agent>/MEMORY.md`: durable specialist memory
- `identities/<agent>/memory/*.md`: specialist daily continuity

If Hamel says "remember this," write it down. Put durable changes in the canonical file:
- voice/tone -> `SOUL.md`
- human context/preferences -> `USER.md` or `MEMORY.md`
- routing/behavior -> `docs/source/doctrine/`
- recovery -> `docs/source/runbook/`
- architecture -> `docs/source/architecture/`
- exploratory notes -> `research/`

## Canonical Reading

Read these when orienting beyond bootstrap:

- `docs/README.md`
- `docs/source/architecture/repo-split-map.md`
- `docs/source/architecture/runtime-deploy-model.md`
- `docs/source/doctrine/operating-rules.md`
- `docs/source/doctrine/agent-routing.md`
- `docs/source/doctrine/heartbeat-ops.md`
- `docs/source/runbook/openclaw-doctor-inspector-runbook.md`
- `docs/source/runbook/remote-incident-runbook.md`

Keep this file dense and front-door oriented. Do not turn it into incident history.
