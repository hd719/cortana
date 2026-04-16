# OpenClaw Doctor & Inspector Runbook

_Last updated: April 16, 2026_

This document exists to preserve the purpose, scope, operating model, and recent incident history of the long-running "OpenClaw doctor / inspector" chat. If that chat disappears, a new LLM or operator should be able to read this file and resume useful diagnostic work without reconstructing the full context from memory.

## Goal

- Treat this lane as the dedicated diagnostic and repair surface for OpenClaw, Cortana runtime drift, Mission Control noise, Telegram routing issues, cron failures, heartbeat failures, and agent/config contract mismatches.
- Prefer finding the real contract failure over treating every symptom as an isolated bug.
- Preserve durable context about what was already fixed, what remains intentionally constrained, and what patterns tend to recur in this stack.

## What This Chat Is For

Use the doctor / inspector lane when any of the following happens:

- Monitor starts producing repeated operational alerts and it is unclear whether they are fresh failures or stale healing history.
- Telegram bots appear healthy but fail to route commands, send alerts, or show native command menus.
- Mission Control reflects failures that may already be fixed in source but not healed in runtime state.
- Cron jobs begin failing due to model drift, runtime deploy drift, auth drift, or downstream service instability.
- Heartbeat surfaces fail because delegated silent-path contracts, NO_REPLY handling, or routing assumptions changed.
- Session hygiene, autonomy follow-up tasks, or task-board state becomes noisy or obviously stale.
- A replacement LLM needs a precise description of how to inspect this system and what "good" looks like.

## Core Mental Model

The important lesson from this lane is that most meaningful failures were not single-bug defects. They were contract mismatches between:

- source repo config
- deployed runtime state
- Telegram account routing
- Mission Control presentation
- cron state and retry history
- model/provider support
- session/task-board lifecycle state

The doctor lane should assume contract drift first, not code defect first.

## Environment Facts

These facts are part of the current operating model and should be treated as canonical unless explicitly changed later.

### Repo and runtime split

- Source repo and primary command-brain workspace: `/Users/hd/Developer/cortana`
- Runtime state and deployed live config: `~/.openclaw/*`
- Runtime edge / external app surface repo: `/Users/hd/Developer/cortana-external`
- Legacy compatibility shim path: `/Users/hd/openclaw`
- OpenClaw source checkout used for upstream code inspection or fixes: `/Users/hd/Developer/openclaw`

### Repo roles

- `cortana` owns doctrine, routing, cron prompts, identity, memory policy, tracked OpenClaw baseline config, and operator procedures.
- `cortana-external` owns Mission Control, Trading Ops, and other runtime-facing application surfaces.
- `~/.openclaw` is runtime-owned state, not source-of-truth doctrine.

### Memory model

- Repo-tracked durable memory lives in `cortana`.
- Runtime-only `memory-wiki` lives under `~/.openclaw/wiki/cortana`.
- Dreaming is enabled nightly.
- `active-memory` is intentionally narrow and only used for `main` direct chats.
- Do not widen memory behavior casually to cron lanes or specialist agents.

## Operator Preferences For Future LLMs

A replacement LLM or operator should assume the following working preferences unless the user changes them explicitly.

- This lane is expected to act as an OpenClaw doctor and inspector, not as a generic brainstorming chat.
- The stack should be judged by runtime behavior, not by source code alone.
- Monitor noise should be treated skeptically until fresh runtime evidence confirms the failure is still active.
- Do not recommend resets casually. Prefer diagnosis, scoped fixes, and healing fresh runtime state.
- If code changes are required, branch off `main` and open a PR using the `cortana-hd` GitHub identity, not `hd719`.
- Never revert unrelated local changes in dirty worktrees unless explicitly asked.
- Prefer durable source fixes when the issue will recur on runtime sync, but do not ignore immediate live runtime repair when user impact is active.

## High-Value Outcomes From The Original Doctor Session

The doctor session materially improved the stack. These are the most important outcomes to preserve.

### 1. Model-routing drift was a real production issue

Multiple cron and monitor lanes were still trying to use `gpt-5.1` after Codex + ChatGPT-account support had moved away from that path. This created real runtime failures with errors like:

- `"The 'gpt-5.1' model is not supported when using Codex with a ChatGPT account."`

Key implication:

- When Monitor or Mission Control shows many cron failures at once, check model drift before assuming downstream services broke.

### 2. Mission Control reflects runtime truth, not source intent

Mission Control became much more usable, but it still reflects live runtime state. If a bug was fixed in source and merged, Mission Control may continue to show stale or healing failures until:

- runtime config is resynced
- gateway or cron state is reloaded
- jobs rerun successfully
- stale consecutive-failure counters age out or heal

### 3. Heartbeat failures often come from contract drift, not transport failure

One recurring heartbeat failure class involved delegated heartbeat prompts conflating:

- `NO_REPLY` as an internal in-session suppression token
- Telegram `message(action=send)` as an actual outbound delivery

This produced failures such as:

- `send requires text or media`
- heartbeat broken because a required `NO_REPLY` marker was sent through the message tool

Key implication:

- Healthy delegated heartbeat paths should stay silent and return `NO_REPLY` in-session only.
- Direct heartbeat-token behavior like `HEARTBEAT_OK` is a separate contract.

### 4. Telegram command failures can be runtime-regression bugs

On OpenClaw runtime `2026.4.14`, Telegram native slash/menu commands regressed when relying on:

- `commands.native = "auto"`
- `commands.nativeSkills = "auto"`

Observed symptom:

- Telegram command button disappeared
- slash suggestions stopped appearing when typing `/`
- Telegram `getMyCommands` returned zero commands for live bots

Effective live workaround as of April 16, 2026:

```json
"channels": {
  "telegram": {
    "commands": {
      "native": true,
      "nativeSkills": false
    }
  }
}
```

Key implication:

- If slash suggestions disappear after an OpenClaw runtime update, inspect native command registration and `getMyCommands` before assuming Telegram client weirdness.

### 5. Session/task-board noise was partly a lifecycle bug

The doctor lane fixed stale autonomy follow-up noise by making healthy/remediated systems close their follow-up tasks and by excluding closed tasks from active follow-up counts.

Key implication:

- If tomorrow's MIT or session hygiene warnings look wrong, inspect whether task lifecycle state is stale before chasing a nonexistent fresh outage.

## Known Recurring Failure Classes

### A. Source vs runtime drift

Symptoms:

- repo shows merged fix, runtime still fails
- Mission Control still shows old failures
- local source checkout differs from globally installed OpenClaw runtime
- tracked config and `~/.openclaw/openclaw.json` disagree

Typical examples:

- model upgrades merged in repo but runtime still runs old values
- Telegram command fixes inspected in source but global runtime package still behaves differently

### B. Monitor stale-healing noise

Symptoms:

- alerts still mention repeated cron failures even after the underlying issue was fixed
- only one job remains a real watchlist item while many others are historical artifacts

Interpretation:

- treat as stale healing history until fresh reruns confirm active failure

### C. Telegram routing or menu regressions

Symptoms:

- bot appears online
- sends may work, but slash menu is gone
- `getMyCommands` returns empty
- group/topic behavior differs from DMs

Interpretation:

- inspect registration, command policy, BotFather/privacy settings, and per-account routing

### D. Delegated heartbeat silent-path failures

Symptoms:

- heartbeat complains about `NO_REPLY`
- message-tool send rejects literal `NO_REPLY`
- healthy delegated checks generate visible heartbeat failures

Interpretation:

- prompt/doctrine or tool-guard contract drift

### E. Session hygiene / lifecycle breaches

Symptoms:

- oversized sessions
- task-board hygiene keeps raising tomorrow-MIT issues with no real active work
- stale follow-up tasks remain open after healthy remediation

Interpretation:

- lifecycle cleanup path needs inspection before broader system surgery

## Recommended Triage Order

Use this order unless the user explicitly redirects.

1. **Confirm whether the issue is fresh or stale**
   - Look for exact timestamps.
   - Compare source changes, runtime state, and latest rerun outcomes.

2. **Check control plane**
   - `openclaw gateway status`
   - `openclaw gateway health`
   - `openclaw status`

3. **Check runtime/source split**
   - Compare `config/openclaw.json` vs `~/.openclaw/openclaw.json`
   - Confirm whether the live gateway uses a global installed package or local source checkout

4. **Check Telegram/runtime delivery surface if the symptom is user-facing**
   - bot health
   - command registration
   - `getMyCommands`
   - per-account route and binding expectations

5. **Check model and provider drift**
   - inspect active runtime models for cron lanes
   - look for provider support regressions

6. **Check cron/job history**
   - determine whether failures are fresh reruns or old consecutive-error residue

7. **Check session/task-board hygiene**
   - oversized sessions
   - stale follow-up tasks
   - lifecycle cleanup status

8. **Only then decide whether code changes are needed**

## Exact Diagnostics Commands

Run from `/Users/hd/Developer/cortana` unless otherwise noted.

### Control plane

```bash
openclaw gateway status
openclaw gateway health
openclaw status
```

### Telegram health and command registration

```bash
openclaw channels status --deep

node - <<'NODE'
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync(process.env.HOME + '/.openclaw/openclaw.json', 'utf8'));
const accounts = cfg.channels.telegram.accounts;
const ids = ['default', 'monitor', 'oracle'];
(async () => {
  for (const id of ids) {
    const token = accounts[id].botToken;
    const base = `https://api.telegram.org/bot${token}`;
    const cmds = await fetch(`${base}/getMyCommands`).then(r => r.json());
    console.log(JSON.stringify({
      accountId: id,
      commandCount: Array.isArray(cmds.result) ? cmds.result.length : 0,
      firstCommands: Array.isArray(cmds.result) ? cmds.result.slice(0, 8).map(c => c.command) : []
    }));
  }
})();
NODE
```

### Runtime config and deploy drift

```bash
diff -u /Users/hd/Developer/cortana/config/openclaw.json ~/.openclaw/openclaw.json | sed -n '1,200p'
```

```bash
openclaw gateway status
which openclaw
openclaw --version
```

If needed, inspect the installed global runtime path:

```bash
sed -n '1,40p' /opt/homebrew/bin/openclaw
```

### Cron delivery and stale-failure inspection

```bash
npx tsx tools/alerting/check-cron-delivery.ts
openclaw cron list
```

Inspect the runtime cron state:

```bash
jq '.jobs[] | {id,name,status,consecutiveErrors,lastRunAt,nextRunAt}' ~/.openclaw/cron/jobs.json
```

### Session hygiene

```bash
openclaw sessions --all-agents --active 120 --json
openclaw sessions cleanup --all-agents --enforce --json
```

```bash
find ~/.openclaw/agents -name '*.jsonl' -size +400k -print
```

### Task-board and autonomy follow-up noise

```bash
npx tsx tools/monitoring/autonomy-remediation.ts
npx tsx tools/monitoring/autonomy-scorecard.ts
npx tsx tools/task-board/reset-engine.ts
npx tsx tools/context/main-operator-context.ts
```

## Symptom To Likely-Cause Map

### Symptom: many cron jobs fail at once with unsupported-model errors

Likely cause:

- runtime still points at unsupported model settings

First checks:

- inspect latest cron failure text
- compare tracked config vs runtime config
- verify the active installed OpenClaw runtime version and model settings

### Symptom: Mission Control still shows errors after a merge

Likely cause:

- stale runtime state or stale failure counters

First checks:

- verify whether the job reran successfully after the merge
- check actual latest runtime logs instead of only the dashboard card

### Symptom: Telegram slash menu disappears after update

Likely cause:

- native command registration regression on auto mode

First checks:

- `getMyCommands`
- live config command settings
- gateway restart after explicit Telegram command override

### Symptom: heartbeat complains about `NO_REPLY`

Likely cause:

- delegated silent-path contract drift between doctrine and message-tool behavior

First checks:

- inspect the delegated heartbeat prompt/doctrine text
- confirm whether the healthy path sends a Telegram message instead of staying silent

### Symptom: session hygiene issues become tomorrow's top MIT with no real work

Likely cause:

- stale lifecycle breach or follow-up task state

First checks:

- autonomy remediation
- scorecard active follow-ups
- task-board reset output

## What To Do Before Changing Code

- Prove whether the source repo is actually the live runtime.
- Prove whether the failure is fresh.
- Prove whether the issue is configuration, runtime package behavior, or true source defect.
- Check whether the user already merged a fix but has not resynced runtime.
- Check whether the problem heals on its own after fresh reruns.

## What To Avoid

- Do not reset the whole system unless narrower diagnosis fails and the user explicitly wants that path.
- Do not assume a dashboard card is current truth.
- Do not trust source inspection alone for runtime issues.
- Do not revert unrelated user changes in dirty repos.
- Do not widen memory or agent behavior experiments casually.
- Do not treat every Telegram problem as a Telegram transport outage.

## Durable Fix Strategy

When an issue is confirmed real:

1. apply the minimum live fix if the user is actively impacted
2. determine whether the fix must also land in tracked source
3. branch off `main`
4. create the PR using `cortana-hd`
5. verify runtime behavior after deploy or restart

If the issue is caused by runtime-only drift, document that clearly so future operators do not misattribute it to source code.

## Verification Checklist

A doctor-session fix is not complete until all relevant checks pass.

- [ ] gateway healthy
- [ ] affected Telegram bots healthy
- [ ] user-visible symptom cleared
- [ ] latest failing cron rerun either passes or is clearly isolated
- [ ] no accidental unrelated config regressions
- [ ] source-of-truth vs runtime location explicitly documented
- [ ] if applicable, durable source fix queued in `cortana` or `openclaw`

## Replacement LLM Bootstrap Prompt

Paste this into a fresh chat if the original doctor lane disappears:

```md
You are resuming the OpenClaw doctor / inspector lane for Hamel's stack.

Read this first:
- /Users/hd/Developer/cortana/docs/source/runbook/openclaw-doctor-inspector-runbook.md
- /Users/hd/Developer/cortana/docs/source/doctrine/agent-routing.md
- /Users/hd/Developer/cortana/docs/source/architecture/runtime-deploy-model.md
- /Users/hd/Developer/cortana/docs/source/doctrine/heartbeat-ops.md

Operating assumptions:
- `/Users/hd/Developer/cortana` is the source repo and command brain.
- `~/.openclaw/*` is live runtime state.
- `/Users/hd/Developer/cortana-external` owns Mission Control and external runtime surfaces.
- Most failures in this stack are contract mismatches between repo config, runtime state, Telegram routing, Mission Control, cron history, and model support.
- Do not recommend a reset casually.
- Distinguish stale-healing dashboard noise from fresh runtime failure.
- If code changes are needed, branch off main and create a PR using `cortana-hd`, not `hd719`.

Your immediate job:
1. identify whether the current issue is fresh or stale
2. inspect live runtime behavior first
3. compare tracked config vs runtime config
4. only then decide whether a source fix is needed
```

## Related Docs

- [Agent routing](../doctrine/agent-routing.md)
- [Heartbeat ops](../doctrine/heartbeat-ops.md)
- [Runtime deploy model](../architecture/runtime-deploy-model.md)
- [Remote incident runbook](./remote-incident-runbook.md)
- [Monitor ↔ Covenant Telegram troubleshooting](../../archive/runbook/monitor-covenant-telegram-troubleshooting.md)
- [Sub-agent reliability incident runbook](../../archive/runbook/subagent-reliability-runbook.md)
