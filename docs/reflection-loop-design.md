# Reflection & Correction Learning Loop Design

## Goal
Automate Cortana's learning loop so corrections become durable behavior changes without relying on manual updates.

## Problems in current state
- `cortana_feedback` captures lessons, but learning remains mostly manual.
- No post-task reflection pass after tasks complete.
- No confidence-scored rule extraction pipeline.
- No automated policy-file reinforcement for high-confidence patterns.
- No KPI that quantifies repeated corrections (signal that rules are not sticking).

## Design Overview

### Inputs
1. **Direct feedback**: `cortana_feedback` (correction/preference/fact/behavior/tone)
2. **Task outcomes**: `cortana_tasks` (`status`, `outcome`, `completed_at`)

### Core components
1. **Post-task reflection** (`tools/reflection/reflect.py`)
   - Finds newly completed/cancelled tasks not yet reflected.
   - Classifies outcome as `success`, `failure`, `near_miss`, or `unknown`.
   - Writes structured reflection rows to `cortana_task_reflections`.

2. **Rule extraction + confidence scoring**
   - Groups feedback by `(feedback_type, lesson)` over a configurable window (default 30 days).
   - Confidence score formula:
     - base = 0.35
     - frequency term = `0.22 * ln(count + 1)`
     - recency bonus = 0.15 (same-day) else 0.05
     - capped at 0.98
   - Upserts extracted rules into `cortana_reflection_rules`.

3. **Policy auto-apply**
   - Auto-apply rule to file when:
     - `confidence >= 0.82` and `evidence_count >= 2`
   - Target files by feedback type:
     - preference/fact → `MEMORY.md`
     - behavior/correction → `AGENTS.md`
     - tone → `SOUL.md`
   - File updates are appended into a managed block:
     - `<!-- AUTO_REFLECTION_RULES:START --> ... END -->`

4. **Repeated correction rate KPI**
   - `repeated_correction_rate = sum(max(0, count-1)) / total_feedback_rows * 100`
   - Stored in `cortana_reflection_runs` per execution.
   - Journal entry written each run for traceability.

5. **Reflection journal**
   - Structured timeline in `cortana_reflection_journal`:
     - task reflections
     - rule extraction outcomes
     - policy auto-applies
     - KPI snapshots
     - failures/errors

## Database additions (migration 007)
- `cortana_reflection_runs`
- `cortana_task_reflections`
- `cortana_reflection_rules`
- `cortana_reflection_journal`

## Heartbeat integration
Added to `HEARTBEAT.md` as a periodic sweep:
- Run once daily (typically evening):
  - `python3 /Users/hd/clawd/tools/reflection/reflect.py --mode sweep --trigger-source heartbeat --window-days 30`
- If repeated correction rate rises, surface to Hamel and recommend stronger policy edits.

## Operational commands

### Full sweep
```bash
python3 /Users/hd/clawd/tools/reflection/reflect.py \
  --mode sweep \
  --trigger-source manual \
  --window-days 30
```

### Post-task reflection for a specific task
```bash
python3 /Users/hd/clawd/tools/reflection/reflect.py \
  --mode task \
  --task-id 53 \
  --trigger-source post_task
```

## Safety/guardrails
- Uses append-only managed blocks for file changes (avoids destructive rewrites).
- Auto-apply requires both confidence and repeated evidence.
- Full run history and errors are persisted for auditing.
