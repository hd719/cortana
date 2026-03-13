# Autonomy Governor v2: Dynamic Approval Gates by Risk Score

Task: `cortana_tasks.id = 118`

## What changed

Implemented a risk-based approval governor for auto-executable task dispatch.

### 1) Risk model (normalized 0.0–1.0)

| Action Category | Risk Score | Default Gate |
|---|---:|---|
| `read-only` | `0.0` | Auto-approve |
| `internal-write` | `0.2` | Auto-approve |
| `external-send` | `0.7` | Human approval required |
| `financial` | `0.9` | Human approval required |
| `destructive` | `1.0` | Human approval required |

Global auto-approve threshold: `0.5`.

Decision behavior:
- `risk < threshold` and no forced-approval rule → `approved`
- `risk >= threshold` OR policy says `requires_human_approval=true` → `escalated` (queued)
- Unknown action type with fail-closed enabled → `denied`

---

### 2) Governor module

Created: `~/Developer/cortana/tools/governor/risk_score.ts`

Responsibilities:
- Load governor policy config
- Infer `action_type` from task metadata/command hints
- Compute risk decision (`approved` / `escalated` / `denied`)
- Log decisions to DB table `cortana_governor_decisions`
- Update task state when escalated/denied

CLI usage example:

```bash
npx tsx ~/Developer/cortana/tools/governor/risk_score.ts \
  --db cortana \
  --task-json '{"id":123,"execution_plan":"cat README.md","metadata":{}}' \
  --actor auto-executor \
  --log \
  --apply-task-state
```

---

### 3) Policy config

Created: `~/Developer/cortana/tools/governor/policy.json`

Contains:
- canonical action types + risk scores
- approval requirements per type
- global threshold
- fail-closed behavior for unknown action types
- regex command hints for action-type inference

Override path at runtime via `--policy <path>`.

---

### 4) Decision logging table

Migration added: `~/Developer/cortana/migrations/012_autonomy_governor_v2.sql`

Creates:
- `cortana_governor_decisions`
  - logs task_id, action_type, risk_score, threshold
  - logs decision (`approved|denied|escalated`)
  - rationale, queue state, metadata

---

### 5) Integration into auto-execution path

Updated: `~/Developer/cortana/tools/task-board/auto-executor.sh`

Flow now:
1. Select next dependency-ready `auto_executable` task.
2. Call governor (`risk_score.ts`) before execution.
3. If `approved` → proceed to existing safelist/whitelist and run command.
4. If `escalated` or `denied` → do not execute; task is queued/blocked and logged.

This enforces risk gating at the exact execution boundary.

---

## Operational notes

- Policy is intentionally simple and explicit for predictable behavior.
- `metadata.action_type` or `metadata.exec.action_type` can force the action class per task.
- Unknown action types default to fail-closed (`denied`) unless policy is changed.

## Files touched

- `tools/governor/risk_score.ts` (new)
- `tools/governor/policy.json` (new)
- `tools/task-board/auto-executor.sh` (updated)
- `migrations/012_autonomy_governor_v2.sql` (new)
- `docs/autonomy-governor.md` (new)
