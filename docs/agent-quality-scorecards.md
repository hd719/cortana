# Agent Output Quality Scorecards

Task ID reference: `136`

## Purpose

`tools/covenant/quality_scorecard.py` scores completed task output quality for sub-agent work and stores the result in `cortana_quality_scores`.

Each criterion is worth **20 points** for a total score of **0-100**.

## Criteria (20 points each)

1. **Task marked done**
   - Checks `cortana_tasks.status = 'done'`
2. **Git commit made**
   - Checks recent git log for task-related commits (task id markers and title-match heuristics)
3. **Docs created if required**
   - If `execution_plan` references docs/readme/documentation, expects doc files in related commit changes
4. **Python compile check**
   - Runs `python3 -m py_compile` against changed Python files from related commits
5. **Outcome populated**
   - Checks `cortana_tasks.outcome` is non-empty

## Database

Migration: `migrations/019_agent_quality_scores.sql`

Table:

- `id BIGSERIAL PRIMARY KEY`
- `task_id INTEGER NOT NULL` (`cortana_tasks.id` FK)
- `agent_role TEXT NOT NULL`
- `score INTEGER NOT NULL` (0-100 check)
- `criteria_results JSONB NOT NULL`
- `scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

## CLI Usage

```bash
cd ~/clawd
python3 tools/covenant/quality_scorecard.py score 136
python3 tools/covenant/quality_scorecard.py report --period 7d
python3 tools/covenant/quality_scorecard.py trends --period 7d
```

### `score <task_id>`

- Reads the task from `cortana_tasks`
- Evaluates all five criteria
- Inserts one row into `cortana_quality_scores`
- Emits JSON with score + criteria breakdown

### `report --period 7d`

Aggregates by role for a lookback window:

- sample count
- average score
- min/max score

### `trends --period 7d`

Compares the last period vs the previous same-length period and labels trend:

- `improving`
- `declining`
- `flat`

## Apply migration

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
psql cortana -f ~/clawd/migrations/019_agent_quality_scores.sql
```
