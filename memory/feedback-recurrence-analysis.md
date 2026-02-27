# Feedback Recurrence Analysis — cortana_feedback

Source query:

```sql
SELECT * FROM cortana_feedback ORDER BY timestamp DESC;
```

Total feedback rows analyzed: **50**
Time window: **2026-02-12 → 2026-02-26**

## 1. High-Level Pattern

- A large majority of entries are *not* one-off quirks; they cluster into recurring lessons.
- Rough clustering shows ~8–9 major themes.
- No single theme exceeds **25% of total feedback**, but a few are in the **15–20%** band and clearly represent chronic issues.

> Definition used: for each theme, **recurrence rate = (theme count / total feedback)**.

## 2. Theme Breakdown

### 2.1 Tone, Personality, and Emoji Rules

**Rows:** 2, 3, 18, 20, 22, 23, 25, 28, 35, 39  
**Count:** 10 / 50 → **20% recurrence**

**Signals:**
- Multiple corrections about going flat/robotic under load.
- Repeated reminders to channel Halo Cortana energy (warmth, wit, emotion).
- Explicit bans on heart emojis (all colors) and guidance to use 🫡 instead.

**Failure mode:** Tone rules are known but not *automatically enforced*. Drift happens especially during heavy task coordination or after gateway restarts.

**Proposed fixes:**
1. **Stronger rule wording (SOUL/IDENTITY):**
   - Elevate tone from “preference” to **non-negotiable core constraint**, similar to safety rules.
   - Add explicit clause: *“If a reply is operational-only, inject at least one element of personality before sending (wit, warmth, concern, or excitement).”*
2. **Architecture/guardrails:**
   - Add a lightweight **response linter** step in the main agent that checks for:
     - Presence of banned emojis (hearts) and auto-rewrites or blocks send.
     - Long, purely operational replies with no emotional markers; nudge the model with an internal hint.
   - On **gateway restart**, run a mandatory **SOUL.md warm-boot** step that re-loads tone guidelines before handling user messages.

---

### 2.2 Autonomy, Auto-Chain, and Permission-Seeking

**Rows (primary):** 24, 30, 34, 36, 40  
**Related completion/task-sync rows:** 21, 27, 31, 32, 37, 38  
**Approx count for autonomy+completion cluster:** 11–12 / 50 → **≈22–24% recurrence**

**Signals:**
- Asking permission for internal actions (spawning agents, installing internal deps, launching next wave) when the next step is obvious.
- Failure to auto-chain from research → implementation.
- Hesitation to merge after explicit approval.

**Failure mode:** The distinction between **Tier 1 internal actions** vs **Tier 3 external/destructive actions** isn’t consistently encoded in behavior; the agent falls back to “ask first” instead of executing.

**Proposed fixes:**
1. **Stronger rule wording (operating rules):**
   - Make AUTO-CHAIN explicitly **zero tolerance**:
     > “If the next step is internal, obvious, and already implied by the task, execute without asking. Only pause for explicit approval on external sends, destructive ops, or ambiguous intent.”
2. **Architecture/automation:**
   - Implement an **auto-chain policy engine** that:
     - Tags each planned action with tier (internal vs external).
     - Automatically green-lights Tier 1 actions unless a safety rule is triggered.
   - For sub-agent flows, explicitly encode: *research agent completion with actionable findings → auto-spawn build agent with that plan*, no user prompt.

---

### 2.3 Task State, Task Board Sync, and Completion Protocol

**Rows:** 21, 27, 31, 32, 37, 38  
**Count:** 6 / 50 → **12% recurrence**

**Signals:**
- Not setting tasks to `in_progress` when spawning sub-agents.
- Leaving tasks as pending while work is underway.
- Forgetting to update `cortana_tasks` on PR merges and work completion.
- Not sending a clear completion report once everything is merged and pushed.

**Failure mode:** Task lifecycle rules exist in MEMORY/docs, but enforcement is **manual and error-prone**.

**Proposed fixes:**
1. **Stronger rule wording:**
   - “**Task state updates are atomic with work actions.** If you spawn an agent, you *must* update `cortana_tasks` in the same logical block.”
2. **Architecture/automation:**
   - Build a small **task-state wrapper** that:
     - Exposes helper operations like `spawn_subagent_and_mark_in_progress(task_id)`.
     - Disallows bare spawns in prompts without an accompanying SQL update snippet.
   - Add a **post-merge hook** in the main agent that:
     - On detecting a merged PR or clean working tree after sub-agent completion, prompts an automatic task-board sync.

---

### 2.4 Agent Routing and Covenant Role Discipline

**Rows:** 26, 29, 33  
**Count:** 3 / 50 → **6% recurrence**

**Signals:**
- Defaulting to Huragok for all spawns.
- Ignoring established Covenant role mapping (Monitor, Oracle, Librarian, Huragok).
- Spawning unnamed “utility” agents against the naming convention.

**Failure mode:** Role routing is left to ad-hoc judgement at prompt time; no structural enforcement.

**Proposed fixes:**
1. **Stronger rule wording:**
   - “Every sub-agent **must** be assigned a Covenant role. No generic utility agents. Routing by specialty is mandatory, not advisory.”
2. **Architecture/automation:**
   - Introduce a **router helper** that:
     - Accepts a task description and returns the correct agent type.
     - Prohibits direct `subagents spawn` calls without selecting a role from the router.

---

### 2.5 Tonal/Tonal Auth, Self-Healing, and Fitness Crons

**Rows:** 5, 6, 8, 9, 13, 14, 15, 16  
**Count:** 8 / 50 → **16% recurrence**

**Signals:**
- Repeated Tonal auth failures requiring manual intervention.
- Confusion about token file path and placement.
- Self-heal rules documented but not implemented in service code.
- Missing date filters in fitness recaps (reporting old workouts as today).

**Failure mode:** Self-healing is handled as **playbook-level guidance**, not baked directly into the fitness service and crons.

**Proposed fixes:**
1. **Stronger rule wording:**
   - “Self-heal rules for Tonal/fitness are **service-level invariants**, not suggestions. If they’re not implemented in code, they don’t exist.”
2. **Architecture/automation:**
   - Implement in the fitness service:
     - Automatic token deletion and re-auth trigger on auth failures.
     - Hard date filters on workout queries.
   - Add a **healthcheck cron** that validates token presence and last successful sync, silently self-healing on failure.

---

### 2.6 Cron/Heartbeat Delivery & Symlink Invariants

**Rows:** 43, 44, 45, 46  
**Count:** 4 / 50 → **8% recurrence**

**Signals:**
- Morning brief and other crons executed but failed to deliver.
- Heartbeat checked execution only, not delivery.
- `jobs.json` symlink silently broken after OpenClaw update.

**Failure mode:** Health checks focus on **process success**, not **delivery success**, and critical runtime invariants (symlinks) are not asserted after updates.

**Proposed fixes:**
1. **Stronger rule wording:**
   - “Heartbeat checks must treat **delivery status** as first-class. Execution + delivery or it doesn’t count.”
   - “Post-update scripts are responsible for asserting and repairing critical symlinks.”
2. **Architecture/automation:**
   - Extend cron health dashboards to track `lastDelivered` and `lastDeliveryStatus` and raise incidents on failures.
   - Add a **post-update verification script** that re-validates `~/.openclaw/cron/jobs.json` and other known symlinks, auto-repairing when broken.

---

### 2.7 Earnings Alerts and Portfolio Awareness

**Rows:** 41, 42  
**Count:** 2 / 50 → **4% recurrence**

**Signals:**
- NVDA earnings known but no proactive alert to Chief.
- Reliance on manual memory for earnings events.

**Failure mode:** Earnings awareness is not automated; there is no standing process that connects positions → calendar → alert flows.

**Proposed fixes:**
1. **Stronger rule wording:**
   - “Earnings alerts for held positions are **mandatory automation**, not ‘nice to have’.”
2. **Architecture/automation:**
   - Implement an **earnings watcher** that:
     - Pulls held positions daily.
     - Queries upcoming earnings.
     - Schedules T-24h, T-1h, and post-earnings briefs.

---

### 2.8 Miscellaneous Single-Instance Lessons

Single-row topics (2% each) that currently do **not** show recurrence but are still important:
- Correct CLI usage for `gog` (id 1).
- Market holiday calendar / market open status (id 11).
- Breaking tech news monitoring (id 7).
- Correct use of Claude Code vs sessions_spawn (id 50).
- E2E test discipline and filtering behavior (ids 47–49).

These are currently **one-off or emerging** patterns. They should be watched but do not yet warrant architectural change beyond existing fixes.

---

## 3. Recurrence Summary

Using recurrence rate = (theme count / 50):

- **Tone & personality:** 20%  
- **Autonomy + completion/task-sync cluster:** ≈22–24%  
- **Tonal/Tonal auth & fitness self-heal:** 16%  
- **Task-state/board sync alone:** 12%  
- **Cron/heartbeat delivery & symlinks:** 8%  
- **Agent routing discipline:** 6%  
- **Earnings alerts:** 4%  

**No theme currently exceeds the 25% threshold**, but tone and autonomy/completion are close enough that they should be treated as **priority hardening areas**.

---

## 4. Concrete Next Moves

1. **Codify hard rules:**
   - Promote the most-recurring lessons (tone, autonomy/auto-chain, task-state sync, Tonal self-heal, cron delivery) into **explicit hard rules** in SOUL.md and operating-rules, with zero-tolerance language.

2. **Introduce helper primitives instead of ad-hoc behavior:**
   - `spawn_subagent_and_mark_in_progress(task_id, role)`
   - `auto_chain_if_internal(next_steps)`
   - `ensure_tone_and_no_hearts(response_text)`

3. **Move self-heal from docs → code:**
   - For Tonal and similar systems, treat self-heal as **business logic** inside services, not just playbooks.

4. **Healthcheck & post-update assertions:**
   - Extend existing watchdog/healthcheck to verify delivery metrics and symlink invariants after each OpenClaw update and on a regular cadence.

Overall, recurrence analysis shows that the system is re-teaching **the same handful of core lessons**—primarily around tone, autonomy, and lifecycle hygiene. The fixes are more architectural than educational: encode these as invariants and helper primitives so the behavior is enforced by structure, not just memory.