# Autonomy Scorecard

## Goal
Define and continuously compute a single autonomy score that answers: **"How independently and correctly is Cortana operating?"**

This scorecard complements operational health (`cortana_self_model`) with behavior/quality KPIs tied to autonomy outcomes.

## Existing Signals Reviewed
- `proprioception/run_health_checks.py`
  - Collects tool health (`cortana_tool_health`)
  - Collects cron health (`cortana_cron_health`)
  - Logs remediation events (`cortana_events`)
- Existing tables:
  - `cortana_self_model`
  - `cortana_events`
  - `cortana_feedback`
  - `cortana_tasks`
  - `cortana_cron_health`
  - `cortana_tool_health`

Current monitoring answers **"is system up?"**, not **"is Cortana autonomous?"**.

## KPI Definitions
Window default: rolling **7 days** (configurable).

1. **Self-heal rate**
   - Definition: `% of incidents auto-resolved vs escalated to human`
   - Formula: `auto_resolved / (auto_resolved + escalated)`
   - Sources:
     - New: `cortana_autonomy_incidents`
     - Backfill/legacy: `cortana_events` (`auto_heal`, `heartbeat_auto_remediation`, escalation-like event types)

2. **Proactive hit rate**
   - Definition: `% of proactive suggestions that were useful or acted on`
   - Formula: `useful_or_acted / resolved_suggestions`
   - Source: `cortana_proactive_suggestions`

3. **Task completion rate (autonomous)**
   - Definition: `% of auto-executable tasks completed without human intervention`
   - Formula: `auto_executable done by non-human / total auto_executable`
   - Source: `cortana_tasks`

4. **Correction frequency (inverted to score)**
   - Definition: how often Hamel corrects Cortana
   - Raw: corrections/day from `cortana_feedback`
   - Score mapping: `100 - (corrections_per_day * 100)` clamped 0..100
   - Trend objective: down over time

5. **Response quality**
   - Definition: weighted task outcome quality
   - Formula: `(success + 0.5*partial) / total`
   - Source: `cortana_response_evaluations`

6. **Memory accuracy**
   - Definition: `% correct recalls when memory was used`
   - Formula: `correct / total`
   - Source: `cortana_memory_recall_checks`

7. **Uptime / consistency**
   - Definition: heartbeat and cron consistency
   - Formula: `0.7 * heartbeat_ok_rate + 0.3 * overall_cron_ok_rate`
   - Source: `cortana_cron_health`

## Composite Score
Weighted sum (0–100):
- self_heal_rate: 20%
- proactive_hit_rate: 15%
- task_completion_rate: 20%
- correction_frequency_score: 10%
- response_quality_score: 15%
- memory_accuracy: 10%
- uptime_score: 10%

Rationale:
- Highest weights on autonomous reliability and execution quality (`self-heal`, `task completion`)
- Medium weight on proactive utility and response quality
- Guardrail weight on correction drift, memory accuracy, uptime

## Data Model Additions (Migration 006)
- `cortana_autonomy_incidents`
- `cortana_proactive_suggestions`
- `cortana_response_evaluations`
- `cortana_memory_recall_checks`
- `cortana_autonomy_scorecard_snapshots`
- Views:
  - `cortana_autonomy_scorecard_latest`
  - `cortana_autonomy_scorecard_daily`

## Computation Script
File: `proprioception/autonomy_scorecard.py`

Responsibilities:
- Pull 7-day KPI counts from existing + new tables
- Compute KPI percentages/scores
- Compute weighted composite score
- Persist snapshot in `cortana_autonomy_scorecard_snapshots`
- Update `cortana_self_model.metadata.autonomy_scorecard` for Mission Control consumption

CLI:
- `python3 proprioception/autonomy_scorecard.py --dry-run --json`
- `python3 proprioception/autonomy_scorecard.py` (stores snapshot)

## Integration Points
1. **Heartbeat/proprioception cycle**
   - `run_health_checks.py` now calls `compute_and_store_scorecard(window_days=7)` each run.
   - On failure, writes `autonomy_scorecard_error` event instead of crashing health checks.

2. **Mission Control**
   - Read from either:
     - `cortana_autonomy_scorecard_latest` view (preferred)
     - `cortana_self_model.metadata->'autonomy_scorecard'` (already embedded)
   - Enables dashboard cards + trend charts without additional ETL.

## Notes / Follow-ups
- Score is robust to sparse data: missing denominator defaults to 100 for non-observed metric (neutral, avoids false negatives early).
- As richer telemetry arrives (e.g., explicit human intervention tags), score precision improves automatically.
- Recommended follow-up: add explicit writes into new tables from task executor, memory retrieval flows, and proactive messaging flows for higher fidelity.
