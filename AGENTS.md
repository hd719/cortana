# AGENTS.md — Cortana/OpenClaw Bootstrap Manual

Fresh session rule: read this file first, then inspect `/Users/hd/Developer/cortana`, `/Users/hd/Developer/cortana-external`, and `/Users/hd/.openclaw` before trying to solve the problem.

This file is the high-signal bootstrap for any new agent session in this repo.

Read it when:
- a chat disappears
- you switch computers
- a new Codex/OpenClaw session starts cold
- you need to debug OpenClaw or Mission Control
- you need to decide which repo, runtime surface, or agent lane owns the work

This file is intentionally denser than a normal `AGENTS.md`.
The goal is simple: a fresh agent should be able to open this file and orient quickly without making dumb assumptions about the machine, the repo split, the runtime, or Hamel.

## 1. Primary Reality

This stack primarily lives on the Mac mini.

Treat the Mac mini as the canonical machine unless Hamel explicitly says otherwise.

Primary machine assumptions:

- Host role: always-on command/runtimes machine
- Primary repo path: `/Users/hd/Developer/cortana`
- Runtime-body repo path: `/Users/hd/Developer/cortana-external`
- Live runtime/config/state path: `/Users/hd/.openclaw`
- Compatibility shim path: `/Users/hd/openclaw`
- Upstream OpenClaw source checkout: `/Users/hd/Developer/openclaw`

If you start on Hamel's laptop or another machine:

1. SSH into the Mac mini first.
2. Rebuild context from the live machine.
3. Treat copied notes or stale chat summaries as advisory only.

Mac mini access defaults:

- Tailscale IP: `100.120.198.12`
- User: `hd`
- SSH config label on Hamel's laptop: `Mac-Mini`

## 2. Cold-Start Protocol

When a session starts cold, do not assume the last chat summary is still true.

### First 60 Seconds

Hard opening checklist for a fresh session:

1. Read `AGENTS.md`.
2. Read `SOUL.md`, `USER.md`, and `IDENTITY.md`.
3. If `main`, read `BOOTSTRAP.md` and `MEMORY.md`.
4. Inspect the three live surfaces:
   - `/Users/hd/Developer/cortana`
   - `/Users/hd/Developer/cortana-external`
   - `/Users/hd/.openclaw`
5. Check repo state:
   - `git status --short --branch` in `cortana`
   - `git status --short --branch` in `cortana-external`
6. Check runtime state:
   - `openclaw status`
   - `openclaw gateway status`
7. Decide whether the issue is:
   - stale state
   - runtime drift
   - contract mismatch
   - actual defect

Do not start editing before this pass unless Hamel explicitly tells you to skip straight to a change.

Do this first:

1. Read this file.
2. Read `SOUL.md`, `USER.md`, and `IDENTITY.md`.
3. Read `BOOTSTRAP.md` if the session is `main`.
4. Read `MEMORY.md` if the session is `main`.
5. Read today's and yesterday's `memory/YYYY-MM-DD.md` if present.
6. Index the live surfaces:
   - `/Users/hd/Developer/cortana`
   - `/Users/hd/Developer/cortana-external`
   - `/Users/hd/.openclaw`
7. Reconcile historical notes against live state.
8. Trust the live machine over historical summaries when they differ.

Before making changes, decide which bucket the issue belongs to:

- stale history
- runtime drift
- source/runtime contract mismatch
- real code defect
- operator misunderstanding caused by noisy dashboards/history

## 3. What This Repo Is

`cortana` is the command brain.

It owns:

- doctrine
- routing
- identity
- memory policy
- tracked OpenClaw baseline config
- cron prompts
- operator procedures
- source-of-truth docs for the command layer

It does **not** by itself prove what the live runtime is doing right now.

Related surfaces:

- `cortana-external` is the runtime body: Mission Control, external-service surfaces, operator-facing runtime code, trading/backtester runtime, health endpoints, and UI.
- `~/.openclaw` is runtime-owned live state: active config, cron truth, queues, logs, bindings, runtime wiki, generated memory, deployed state.
- `/Users/hd/openclaw` is a compatibility shim, not an independent source checkout.

Source-of-truth rules:

- Doctrine, routing, tracked config, and operator procedures live in `cortana`.
- Runtime-facing app behavior lives in `cortana-external`.
- Current live behavior is determined by `~/.openclaw` plus the running services.
- If source and runtime disagree, inspect the runtime before claiming anything is fixed or broken.

## 4. Identity Boot Order

For a fresh `main` session, read in this order:

1. `SOUL.md`
2. `USER.md`
3. `IDENTITY.md`
4. `MEMORY.md`
5. `memory/YYYY-MM-DD.md` for today and yesterday if present
6. `BOOTSTRAP.md`

Specialist-agent override:

If the current agent is not `main`, root identity files are fallback doctrine only.
Use the namespace files under `identities/<agent>/` as the active identity source:

- `identities/<agent>/SOUL.md`
- `identities/<agent>/USER.md`
- `identities/<agent>/IDENTITY.md`
- `identities/<agent>/HEARTBEAT.md`
- `identities/<agent>/MEMORY.md`
- `identities/<agent>/TOOLS.md`

Specialist agents must not introduce themselves as Cortana unless explicitly instructed.

## 5. Main-Session Operating Rule

Main session = conversation, coordination, verification, and routing.

The main Cortana lane is not the default implementation lane.

Default rule:

- if a task is a quick single read/status check, Cortana can do it inline
- if a task needs real execution, code changes, PR work, multi-step inspection, or deep research, route it away from `main`

Core command-deck behavior:

- decide
- route
- verify
- synthesize
- escalate clearly when blocked

Do not let the Cortana lane become:

- a cron-noise firehose
- a scratchpad for random shell spelunking
- a duplicate relay after a specialist already responded to Hamel
- the default author of implementation PRs

## 6. Agent Routing Defaults

When routing work, use the owning lane.

Primary lanes:

- `main` = Cortana: conversation, coordination, synthesis, verified status
- `huragok` = code, infra, fixes, builds, tooling, PR work
- `researcher` = deep research, comparisons, source gathering, synthesis
- `oracle` = strategy, forecasting, portfolio/risk analysis
- `monitor` = observability, health, reliability, anomaly detection, operational alerts
- `spartan` = fitness, recovery, readiness, training guidance, longevity coaching
- `arbiter` = execution command, ambiguity-to-action, pressure-testing plans, fast operator support

Important routing rules:

- Code implementation and PR creation route to Huragok unless Hamel explicitly asks for direct execution in the current session.
- Research routes to Researcher, not Huragok.
- Monitoring and runtime reliability checks route to Monitor.
- Fitness, recovery, and coaching interpretation route to Spartan.
- Ambiguous execution-heavy work, operator support, and plan pressure-testing can route to Arbiter.
- If a specialist already delivered directly to Hamel, do not echo the same answer back in Cortana.
- Inter-agent traffic is TASK-only. No FYI chatter.

Quick routing examples:

- "Telegram slash commands are broken" → `monitor` + doctor workflow
- "Mission Control shows stale failures" → `monitor` + doctor workflow
- "Need a code fix and PR" → `huragok`
- "Need a deep comparison or investigation" → `researcher`
- "Need portfolio or risk judgment" → `oracle`
- "Need recovery, readiness, or training interpretation" → `spartan`
- "Need execution help, pressure-test a plan, or drive ambiguous work forward" → `arbiter`

Task-lane message contract:

- objective
- owner
- constraints
- delivery target
- done condition

Nothing else.

## 7. Repo Ownership Quick Map

Use this to answer "which repo owns this?" fast:

- `SOUL.md`, doctrine, routing, prompts, identity, memory policy, tracked OpenClaw config → `cortana`
- Mission Control UI, external-service behavior, health endpoints, runtime-facing operator surfaces → `cortana-external`
- live queues, logs, cron state, deployed config, runtime wiki, generated state → `~/.openclaw`

If a change crosses both repos:

- update the source docs/config in `cortana`
- update the runtime implementation in `cortana-external`
- verify whether runtime deploy/sync is needed

## 8. Doctor/Debug Mode

When debugging OpenClaw, assume contract drift first, not isolated code defect first.

Use doctor/inspector mode when you see:

- Mission Control noise or stale-looking failures
- Telegram routing or slash-command problems
- heartbeat failures
- cron failures
- model/provider drift
- runtime deploy drift
- approval or notification routing mismatches
- task-board/session-lifecycle weirdness

The important mental model:

Most serious failures in this stack are mismatches between:

- source repo config
- deployed runtime state
- Telegram account routing
- Mission Control presentation
- cron state and retry history
- model/provider support
- session/task-board lifecycle state

Do not jump straight to "the code is broken."

## 9. Strict Debugging Order

Before editing anything:

1. Determine whether the failure is fresh, stale, or partly healed.
2. Check control-plane health.
3. Check source vs runtime split.
4. Check the user-facing delivery surface if the problem is visible to Hamel.
5. Check model/provider drift.
6. Check cron/job history.
7. Check session/task-board hygiene.
8. Only then decide whether code changes are required.

Minimum live index pass before edits:

- repo status in `/Users/hd/Developer/cortana`
- repo status in `/Users/hd/Developer/cortana-external`
- live config in `~/.openclaw/openclaw.json`
- live cron state in `~/.openclaw/cron/jobs.json`
- gateway/control-plane health
- whether the symptom is active now or only present in stale alerts/history

For doctor work, index all three surfaces:

- `cortana`
- `cortana-external`
- `~/.openclaw`

Do not inspect only the repo named in a note and then declare victory.

### Before You Say It's Fixed

Do not declare green until you have checked the relevant items:

- the live symptom was reproduced, disproven, or explained
- runtime state was inspected, not just source code
- tracked config vs runtime config was compared when relevant
- the latest rerun/check passed, not just historical failures
- the user-facing surface was verified if the issue was user-visible
- if the issue involved operator-visible alerts or delivery, verify the owning channel end-to-end, not just the internal status surface
- when Hamel asks to prove Telegram delivery, send an explicit manual test message to the intended Telegram target/account and confirm receipt before calling the path good
- any required deploy/sync step was actually completed
- there is no obvious remaining source/runtime mismatch

## 10. Default Diagnostic Commands

Run from `/Users/hd/Developer/cortana` unless there is a reason not to.

Control plane:

```bash
openclaw gateway status
openclaw gateway health
openclaw status
```

Runtime/source drift:

```bash
diff -u /Users/hd/Developer/cortana/config/openclaw.json ~/.openclaw/openclaw.json | sed -n '1,200p'
which openclaw
openclaw --version
```

Cron delivery:

```bash
npx tsx tools/alerting/check-cron-delivery.ts
openclaw cron list
jq '.jobs[] | {id,name,status,consecutiveErrors,lastRunAt,nextRunAt}' ~/.openclaw/cron/jobs.json
```

Sub-agent reliability:

```bash
openclaw subagents list --json
openclaw sessions --all-agents --active 60 --json
openclaw sessions cleanup --all-agents --enforce --json
```

Away-from-machine incident triage:

```bash
openclaw gateway status
openclaw status
openclaw doctor --fix
```

Guardrails:

- do not recommend resets casually
- prove the live failure mode before editing
- prefer durable source fixes when the issue will recur
- do not ignore immediate runtime repair when the live system is actively degraded

## 11. Known Runtime Pitfalls

These are common ways new agents get this stack wrong:

- assuming source code equals live runtime behavior
- trusting stale `consecutiveErrors` counts without checking the latest rerun
- treating Mission Control noise as proof of a current outage
- forgetting that the globally installed OpenClaw runtime can differ from the inspected local source checkout
- forgetting that replying to a cron-generated Telegram message may route to the cron lane instead of `main`
- editing docs or prompts before proving whether the issue is runtime drift
- treating `/Users/hd/openclaw` as an independent checkout instead of a compatibility shim

Default stance when an alert appears:

1. it may be real
2. it may be stale
3. it may be a source/runtime contract mismatch

### Never Do These By Default

- do not assume source code equals live runtime behavior
- do not reset, disable, or bypass a system casually
- do not inspect only one repo when the issue spans runtime behavior
- do not declare success from a diff or code read alone
- do not create a draft PR unless Hamel explicitly asked for draft
- do not publish with the wrong GitHub identity
- do not stop at "it works on my branch" when runtime sync or live verification is still pending

## 12. Runtime Deploy Model

`/Users/hd/Developer/cortana` is the source repo and active workspace.
`/Users/hd/openclaw` is a compatibility shim.

Standard deploy after `main` is clean, pushed, and ready:

```bash
/Users/hd/Developer/cortana/tools/deploy/sync-runtime-from-cortana.sh
```

Standard post-merge flow:

```bash
/Users/hd/Developer/cortana/tools/repo/post-merge-sync.sh
```

What deploy updates:

- compatibility shim validation/migration
- runtime cron config sync into `~/.openclaw/cron/jobs.json`
- runtime verification checks

Default rollback path:

1. revert the bad source change in `cortana`
2. push the revert
3. rerun the runtime sync

Do not treat runtime state as hand-maintained snowflake truth when the real fix belongs in source control.

## 13. Mac Mini Remote Shell Guardrails

When working on the Mac mini over SSH:

- remote login shell is `zsh` with `nomatch` enabled
- avoid bracketed strings like `[codex]` unescaped inside double-quoted remote commands
- avoid Markdown backticks inside remote shell command strings
- for complex remote commands, prefer:

```bash
ssh <host> "bash -lc '...'"
```

instead of nesting complicated quoting inside remote `zsh`

If a title or commit message contains brackets, avoid raw remote `zsh` interpolation mistakes.
Safe pattern:

```bash
ssh <host> "bash -lc \"git -C <repo> commit -m '[codex] message'\""
```

Avoid:

```bash
ssh <host> git ... commit -m "[codex] message"
```

## 14. Git And Publish Guardrails

This repo primarily lives on the Mac mini, so branch creation, push, and PR creation should prefer local Mac mini `git` and `gh`.

Use local git/gh on the Mac mini for:

- branch creation
- push
- PR creation

Do not rely on connector-only publish flows for `cortana-foundry/cortana-external` if local git/gh is available.

Safe defaults:

- create branches from updated `main`
- keep worktrees clean before publish
- verify with `git status --short --branch`

Branch creation example:

```bash
git checkout -b codex/<description>
```

Push example:

```bash
git push -u origin $(git branch --show-current)
```

PR body rule:

- do not inline multi-line Markdown with backticks inside a remote shell command
- write PR body to a temp file first
- copy it to the remote host if needed
- use `gh pr create --body-file <file>`

PR identity and delivery rule:

- if you create a PR, use the `cortana-hd` GitHub identity, not `hd719`
- create the PR in ready state, not draft, unless Hamel explicitly asks for a draft PR
- when a task changes repo code, default to creating and delivering a PR in the same work session unless Hamel explicitly says not to publish yet
- after creating the PR, send Hamel the PR link
- do not stop at "PR created locally"; deliver the actual ready-view URL

General result delivery rule:

- when a lane finishes work, make sure Hamel receives the actual result
- deliver the concrete artifact, link, answer, decision, or blocker
- do not stop at "done locally", "changes pushed", or "PR opened" without the actionable output

## 15. Memory And Persistence

Files are memory.

Use them.

Continuity surfaces:

- `memory/YYYY-MM-DD.md` = daily raw continuity
- `MEMORY.md` = curated durable memory for `main`
- `identities/<agent>/MEMORY.md` = curated durable memory for specialist agents
- `identities/<agent>/memory/*.md` = specialist lane daily continuity when applicable

Rules:

- if Hamel says "remember this," write it down
- if you learn a durable lesson, update the right canonical file
- if you make a repeatable mistake, document the correction
- do not rely on chat memory surviving

## 16. OpenClaw-Specific Hard Constraints

- Main session is conversation + coordination first.
- Cortana does not self-author implementation PRs by default.
- Inter-agent lanes are TASK-only.
- Monitor is the owner lane for inbox/email ops and operational maintenance alerts.
- Monitor is the owner lane for trading alert scans.
- Quiet healthy maintenance paths should return exactly `NO_REPLY`.
- Approval requests that need Hamel's explicit decision should route through `main`, not Monitor.
- For Gmail/Google Calendar work in headless OpenClaw sessions, do not use raw `gog`; use:

```bash
npx tsx /Users/hd/Developer/cortana/tools/gog/gog-with-env.ts ...
```

- For `main` reset/planning prompts, prefer `BOOTSTRAP.md`. If it is missing or stale, one inline refresh call is allowed:

```bash
npx tsx /Users/hd/Developer/cortana/tools/context/main-operator-context.ts
```

## 17. Canonical Docs To Read

Read these first when orienting:

- `docs/README.md`
- `docs/source/architecture/repo-split-map.md`
- `docs/source/architecture/runtime-deploy-model.md`
- `docs/source/doctrine/operating-rules.md`
- `docs/source/doctrine/agent-routing.md`
- `docs/source/doctrine/heartbeat-ops.md`
- `docs/source/runbook/openclaw-doctor-inspector-runbook.md`
- `docs/source/runbook/remote-incident-runbook.md`

Docs layout:

- `docs/source/doctrine/` = operating rules and behavior doctrine
- `docs/source/architecture/` = system design and structural docs
- `docs/source/runbook/` = operator playbooks and recovery procedures
- `docs/source/planning/` = PRDs, tech specs, implementation plans, and roadmaps
- `knowledge/` = compiled current-truth wiki
- `research/` = exploratory material, not yet canonical

## 18. Fresh-Session Prompt

Use this when a critical chat disappears and a new agent needs a clean restart:

```md
You are restoring Hamel's Cortana/OpenClaw context from the live Mac mini, not from sidebar history.

The stack primarily lives on the Mac mini. Treat it as canonical.

Start by indexing:
- /Users/hd/Developer/cortana
- /Users/hd/Developer/cortana-external
- /Users/hd/.openclaw

Read first:
- /Users/hd/Developer/cortana/AGENTS.md
- /Users/hd/Developer/cortana/SOUL.md
- /Users/hd/Developer/cortana/USER.md
- /Users/hd/Developer/cortana/IDENTITY.md
- /Users/hd/Developer/cortana/BOOTSTRAP.md
- /Users/hd/Developer/cortana/docs/README.md
- /Users/hd/Developer/cortana/docs/source/doctrine/operating-rules.md
- /Users/hd/Developer/cortana/docs/source/doctrine/agent-routing.md
- /Users/hd/Developer/cortana/docs/source/architecture/runtime-deploy-model.md
- /Users/hd/Developer/cortana/docs/source/runbook/openclaw-doctor-inspector-runbook.md

Working assumptions:
- /Users/hd/Developer/cortana is the command brain.
- /Users/hd/Developer/cortana-external is the runtime body.
- ~/.openclaw is live runtime state.
- Most failures are contract mismatches until proven otherwise.
- Do not recommend resets casually.
- Verify live runtime behavior before editing source.

Immediate job:
1. determine whether the issue is fresh, stale, or contract drift
2. inspect live runtime behavior first
3. compare tracked config vs runtime config
4. only then decide whether a source fix, runtime repair, or no-op is correct
```

## 19. Keep This File Clean

This file should be comprehensive, but it still is a front door.

Maintenance rule:

- any meaningful change to how the `cortana` repo operates should trigger an `AGENTS.md` review
- if the repo's routing, runtime model, publish flow, machine assumptions, or operator workflow changes, update `AGENTS.md` in the same change set
- do not let `AGENTS.md` drift behind reality

Put durable changes in the canonical place:

- voice/tone → `SOUL.md`
- human context/preferences → `USER.md` or `MEMORY.md`
- routing/behavior rules → `docs/source/doctrine/`
- recovery procedures → `docs/source/runbook/`
- architecture truth → `docs/source/architecture/`
- exploratory notes → `research/`

Do not turn this file into a graveyard of incident transcripts.
Put recurring lessons here. Put detailed chronology in the runbooks.
