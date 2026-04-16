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

## Current Operating Snapshot

This section is intentionally more concrete than normal doctrine. It is a point-in-time state capture for the doctor lane as of April 16, 2026.

### What is materially better than before

- Broad model-routing drift was reduced after unsupported `gpt-5.1` usage was moved forward to supported lanes.
- Mission Control became more trustworthy as an operator surface, but only after multiple route, feedback, approval, and action-button fixes.
- Vacation Ops stopped being a backend-only concept and became a visible operator discipline with real health surfaces and away-mode expectations.
- Heartbeat doctrine was tightened around silent healthy paths instead of forcing invalid `NO_REPLY` Telegram sends.
- Task-board and autonomy follow-up hygiene improved after stale healthy/remediated tasks began closing correctly.
- Telegram command-menu behavior was restored with a runtime workaround after the `2026.4.14` auto-registration regression.

### What still remains inherently fragile

- Runtime state can still lag source code even after a merge.
- Mission Control will continue to surface upstream auth and service problems rather than hiding them.
- Cron consecutive-failure counts can remain noisy after the underlying cause is fixed.
- Telegram-specific behavior can differ between:
  - direct message chats
  - groups
  - forum topics
  - native command registration vs manually typed slash commands
- Global installed OpenClaw runtime behavior can differ from the local `Developer/openclaw` checkout being inspected.

### Working assumption about alerts

When an alert appears, the correct default stance is:

1. it may be real
2. it may be stale
3. it may be a source/runtime contract mismatch

Do not collapse directly to "the code is broken" or "it healed itself" without evidence.

## Scope Boundaries

This doctor lane is broad, but it is not infinite. It should stay focused on OpenClaw operational diagnosis and nearby Cortana runtime contracts.

### In scope

- OpenClaw gateway behavior
- Telegram delivery and command routing
- live config under `~/.openclaw`
- tracked baseline config under `cortana/config/openclaw.json`
- cron/job execution and delivery state
- heartbeat and silent-path contract behavior
- Mission Control symptoms that reflect runtime truth
- session hygiene, autonomy noise, and task-board lifecycle issues
- upstream OpenClaw runtime regressions that affect Hamel's stack

### Adjacent but still relevant

- `cortana-external` Mission Control behavior when it is clearly downstream of runtime or auth state
- OpenClaw source fixes in `/Users/hd/Developer/openclaw`
- runtime deploy and sync workflows from `cortana`

### Out of scope unless the user redirects

- generic product brainstorming
- promoting optional local-model features into production just because they exist
- broad memory-policy redesign
- cosmetic Mission Control cleanup when the real issue is upstream runtime state

## File And Surface Map

A replacement LLM should not waste time rediscovering where things live.

### Primary source files

- Tracked runtime baseline: `/Users/hd/Developer/cortana/config/openclaw.json`
- Tracked cron baseline: `/Users/hd/Developer/cortana/config/cron/jobs.json`
- Agent routing doctrine: `/Users/hd/Developer/cortana/docs/source/doctrine/agent-routing.md`
- Heartbeat doctrine: `/Users/hd/Developer/cortana/docs/source/doctrine/heartbeat-ops.md`
- Runtime deploy model: `/Users/hd/Developer/cortana/docs/source/architecture/runtime-deploy-model.md`

### Live runtime files

- Live config: `~/.openclaw/openclaw.json`
- Live cron state: `~/.openclaw/cron/jobs.json`
- Telegram command hashes: `~/.openclaw/telegram/command-hash-*`
- Sessions: `~/.openclaw/agents/*/sessions`
- Runtime wiki: `~/.openclaw/wiki/cortana`

### Live services and apps

- OpenClaw gateway: loopback gateway on `127.0.0.1:18789`
- Mission Control UI: typically on `http://127.0.0.1:3000`
- Telegram bots: visible through gateway health and direct Telegram Bot API probes

### OpenClaw runtime binary path

Do not assume `openclaw` points at source.

Check:

```bash
which openclaw
sed -n '1,40p' /opt/homebrew/bin/openclaw
```

On April 16, 2026 the live service was running the globally installed package under a path like:

- `~/Library/pnpm/global/5/node_modules/openclaw/dist/index.js`

That fact mattered because source inspection in `/Users/hd/Developer/openclaw` did not automatically describe live runtime behavior.

## Known Actors And Surfaces

These are the relevant named surfaces that kept appearing in this lane.

### Telegram accounts observed live

From gateway health on April 16, 2026:

- `@cortanahdbot`
- `@arbiterhdbot`
- `@huragokhdbot`
- `@monitorhdbot`
- `@oraclehdbot`
- `@researcherhdbot`
- `@spartanhdbot`

### Practical interpretation

- `default` / `cortanahdbot` is the primary operator-facing Telegram surface.
- `monitor` is the owner lane for many operational alerts and watchlist messages.
- `oracle`, `researcher`, `arbiter`, `spartan`, and `huragok` are specialist surfaces whose routing or menu behavior may differ even when the control plane is healthy.

If exact specialist responsibility matters, verify it from routing/config rather than assuming from the name alone.

### High-signal dashboards and summaries

- Monitor chat is useful but noisy.
- Mission Control is useful but reflects live runtime truth rather than source intent.
- Cron delivery summaries often mix fresh failures with stale healing history.

## Start-Of-Session Protocol For A Replacement LLM

A fresh LLM should follow this exact startup pattern before trying to fix anything.

### Step 1: establish the problem statement in one sentence

Examples:

- "Telegram slash commands disappeared after runtime update."
- "Monitor still reports degraded cron delivery after the model fix merged."
- "Heartbeat is broken because delegated silent-path handling regressed."

### Step 2: determine whether the issue is likely runtime, source, or presentation

Ask implicitly through inspection:

- Is the live runtime unhealthy?
- Is the symptom only in Mission Control or also in the underlying service?
- Is source already fixed while runtime still shows old behavior?

### Step 3: gather live evidence first

Minimum first-pass commands:

```bash
openclaw gateway status
openclaw gateway health
openclaw status
```

Then branch into the relevant surface.

### Step 4: compare source and runtime if anything smells like drift

```bash
diff -u /Users/hd/Developer/cortana/config/openclaw.json ~/.openclaw/openclaw.json | sed -n '1,200p'
```

### Step 5: decide whether the user needs

- a diagnosis only
- a live runtime repair
- a tracked source fix
- both layers

### Step 6: only after that, make edits

This lane loses quality fast when the agent edits before proving whether the active issue is:

- stale
- healed-but-noisy
- runtime-only
- source-only
- true cross-layer contract drift

## Detailed Incident Chronology

This chronology is not exhaustive, but it captures the most important incident classes that shaped the lane.

### Phase 1: broad hardening and contract cleanup

The system moved from "works but with too much hidden drift" toward a more production-disciplined state. The meaningful changes were not just individual bug fixes. They tightened the contracts between:

- repo config
- runtime state
- Telegram ownership/routing
- Mission Control surfaces
- vacation-mode operations
- cron behavior

Representative issue classes handled during this broader phase:

- Google/Gog cron auth drift
- Apple Reminders failures
- monitor heartbeat noise
- cron drift handling
- runtime deploy behavior
- GitHub identity consistency
- Codex model routing cleanup

### Phase 2: unsupported model failures

Multiple cron and monitor lanes still had paths capable of requesting `gpt-5.1`, which was unsupported for the current Codex + ChatGPT-account setup.

Operational effect:

- Monitor chat failures
- Mission Control failure cards
- repeated cron errors with the same unsupported-model message

Doctor-lane lesson:

- when many different jobs fail with the same model/provider text, treat it as shared runtime-model drift, not many independent broken jobs

### Phase 3: heartbeat silent-path contract bug

The system began failing on healthy delegated heartbeat paths because a prompt/runtime mismatch made the lane try to send literal `NO_REPLY` through Telegram message delivery.

Observed lesson:

- `NO_REPLY` is an in-session suppression token, not a user-visible delivery payload
- direct heartbeat token behavior like `HEARTBEAT_OK` should not be conflated with delegated specialist silent paths

### Phase 4: stale autonomy and task-board noise

Session hygiene and tomorrow-board noise were partly driven by lifecycle issues rather than fresh user work or genuine active incidents.

Observed lesson:

- a dashboard or scorecard can remain noisy even when the underlying health state has already remediated
- close healthy follow-ups and ignore closed tasks when calculating active remediation work

### Phase 5: Telegram slash-command regression on `2026.4.14`

After updating OpenClaw, Telegram command button and slash suggestions disappeared again.

Important facts observed directly:

- Telegram bots were healthy
- Telegram `getMyCommands` returned zero commands
- the command-hash cache held the empty-command hash for all Telegram accounts
- the live runtime was the globally installed package, not the local source checkout
- explicit Telegram command overrides restored the menu

Doctor-lane lesson:

- this was a real runtime behavior change/regression when relying on `auto`
- runtime package behavior can diverge from the local source tree you are inspecting

## Evidence Handling Rules

Future LLMs should preserve and communicate evidence clearly.

### Always capture

- exact timestamp or approximate recency
- whether the evidence came from source, runtime, Telegram API, Mission Control, or local logs
- whether the issue is reproducible now
- whether the user-visible symptom still exists after the proposed fix

### Prefer direct probes over screenshots when possible

Screenshots are helpful, but direct checks are stronger:

- Telegram `getMyCommands`
- `openclaw gateway health`
- direct cron/job state inspection
- diff between tracked and live config

### Distinguish observation from inference

Examples:

- Observation: "Telegram `getMyCommands` returned zero commands for `default`."
- Inference: "The runtime intentionally published an empty command menu."

That separation matters in this stack because many surfaces summarize or cache state.

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

### Telegram command-hash inspection

Use this when Telegram menus look missing or stale.

```bash
for f in ~/.openclaw/telegram/command-hash-*; do
  printf '%s ' "$(basename "$f")"
  cat "$f"
  echo
done
```

Important observed value from the regression:

- empty command list hash: `4f53cda18c2baa0c`

If many or all Telegram command-hash files equal that value during a menu outage, the runtime likely believes the command list is empty.

### Installed runtime inspection

Use this when source and live behavior disagree.

```bash
openclaw --version
which openclaw
sed -n '1,40p' /opt/homebrew/bin/openclaw
openclaw gateway status
```

If needed, inspect the globally installed bundle:

```bash
ls -d ~/Library/pnpm/global/5/.pnpm/openclaw*
```

### Telegram live-command probe

Use this exact probe when the user reports slash/menu regressions:

```bash
node - <<'NODE'
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync(process.env.HOME + '/.openclaw/openclaw.json', 'utf8'));
const accounts = cfg.channels.telegram.accounts;
const ids = ['default', 'monitor', 'oracle'];
(async () => {
  for (const id of ids) {
    const token = accounts[id].botToken;
    const base = `https://api.telegram.org/bot${token}`;
    const me = await fetch(`${base}/getMe`).then(r => r.json());
    const cmds = await fetch(`${base}/getMyCommands`).then(r => r.json());
    console.log(JSON.stringify({
      accountId: id,
      username: me?.result?.username ?? null,
      commandCount: Array.isArray(cmds?.result) ? cmds.result.length : 0,
      firstCommands: Array.isArray(cmds?.result) ? cmds.result.slice(0, 8).map(c => c.command) : []
    }));
  }
})();
NODE
```

### Logs worth searching

When runtime behavior is unclear, search these strings in gateway logs:

```bash
rg -n "command menu unchanged|command sync failed|setMyCommands failed|deleteMyCommands failed|BOT_COMMANDS_TOO_MUCH|send requires text or media|The 'gpt-5.1' model is not supported" ~/.openclaw/logs /tmp/openclaw
```

### Mission Control and stale-history interpretation

Mission Control often needs corroboration.

Useful rule:

- if a Mission Control card shows a failure older than the latest successful rerun, treat it as stale display history, not an active incident

Confirm through:

- latest runtime log
- cron state
- direct gateway/Telegram probe

## Surface-Specific Playbooks

These are more detailed than the high-level symptom map and are intended to be used directly.

### Playbook: Telegram slash commands disappeared

1. Confirm gateway and Telegram bots are healthy.
2. Run `getMyCommands` for the affected accounts.
3. Check command-hash cache values under `~/.openclaw/telegram`.
4. Compare `config/openclaw.json` with `~/.openclaw/openclaw.json`.
5. Confirm whether `openclaw` runtime is global package or local source.
6. If `auto` mode appears broken, apply the scoped live workaround:

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

7. Restart gateway.
8. Re-run `getMyCommands`.
9. Ask the user to test `/help` and not just the menu button.

### Playbook: Monitor says cron delivery is still degraded

1. Determine whether the cited jobs have rerun since the root fix merged.
2. Inspect latest run results, not just `consecutiveErrors`.
3. Look for common-cause shared failures such as:
   - unsupported model
   - auth outage
   - browser lane failure
4. If only one job remains fresh, call the rest stale healing history explicitly.
5. Avoid noisy broad remediation when a single remaining watch item explains the residual alert.

### Playbook: Heartbeat broke on healthy path

1. Search for `NO_REPLY` or `send requires text or media`.
2. Identify whether the path is:
   - delegated specialist heartbeat
   - direct heartbeat poll
3. For delegated healthy paths:
   - no Telegram message should be sent
   - final in-session reply should be `NO_REPLY`
4. For direct heartbeat polls:
   - explicit healthy tokens such as `HEARTBEAT_OK` may still be valid if the workspace contract requires them
5. If the problem is active:
   - fix doctrine/prompt if it instructs outbound delivery incorrectly
   - harden runtime if accidental silent-token sends should be treated as no-op

### Playbook: Session hygiene still noisy after remediation

1. Inspect oversized sessions.
2. Run session cleanup.
3. Run autonomy remediation.
4. Check whether active follow-ups are truly open or merely stale.
5. Inspect tomorrow-board reset output.
6. If context shows no real ready or in-progress work, describe the issue as lifecycle noise rather than active incident load.

### Playbook: Repo merged, runtime still wrong

1. Verify branch and merge actually landed in source.
2. Verify whether runtime sync/deploy happened.
3. Confirm the live binary path.
4. Compare tracked config and live config.
5. Determine whether the user needs:
   - runtime resync only
   - runtime restart only
   - source fix still missing
   - both source fix and runtime repair

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

## When To Change Runtime Only vs Source Control

Use this rule set explicitly.

### Change runtime only when

- the user is actively impacted right now
- the failure is caused by live config drift
- the source repo already contains the correct fix
- the issue is known to be a runtime-only compatibility or deploy problem

Examples:

- restoring Telegram commands by changing `~/.openclaw/openclaw.json`
- restarting gateway after a live config repair

### Change source control when

- the issue will recur on the next runtime sync
- tracked baseline config is wrong
- doctrine or runbook text is missing or misleading
- the OpenClaw source itself has the actual defect

### Change both layers when

- Cortana doctrine/config is the source of truth
- but the user also needs immediate live recovery now

That "fix both layers, with source as truth and runtime as backstop" pattern was the right model for the heartbeat silent-path issue and the Telegram command workaround.

## Git And PR Rules For This Lane

These rules should be followed by future LLMs unless the user explicitly asks otherwise.

### Branching

- Branch off `main`.
- Use `codex/<description>` branch names.

### Identity

- Use `cortana-hd` for Cortana repo PRs.
- Do not use `hd719` for the PR branch/publish path when the user already specified the preferred identity.

### Dirty worktrees

- Never stage unrelated memory or continuity files just because they are present.
- If the main repo is dirty, prefer:
  - a clean worktree
  - a clean clone
  - or a separate branch from a clean checkout

### Commit style

- Use a terse, literal commit message.
- Do not amend unless explicitly asked.

## How To Answer The User From This Lane

A replacement LLM should not only run diagnostics correctly; it should report them correctly too.

### Good response shape

1. state whether the issue is real, stale, or mixed
2. identify the strongest evidence
3. name the likely root cause
4. state what was changed, if anything
5. state what still remains open

### Avoid weak phrasing

Avoid:

- "probably fixed"
- "should heal"
- "seems okay"

Prefer:

- "Telegram `getMyCommands` returned 0 before the fix and 66 after restart."
- "Mission Control is showing stale healing history; latest rerun evidence does not support an active outage."
- "The source repo is not the live runtime; the gateway is using the globally installed package."

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
