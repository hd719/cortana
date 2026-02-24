#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
from datetime import datetime, timezone
from typing import Any, Dict

PSQL_BIN = "/opt/homebrew/opt/postgresql@17/bin/psql"

DEFAULT_WEIGHTS = {
    "self_heal_rate": 0.20,
    "proactive_hit_rate": 0.15,
    "task_completion_rate": 0.20,
    "correction_frequency_score": 0.10,
    "response_quality_score": 0.15,
    "memory_accuracy": 0.10,
    "uptime_score": 0.10,
}


def _clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


def _run_sql_json(sql: str) -> Dict[str, Any]:
    env = os.environ.copy()
    env.setdefault("PGHOST", "localhost")
    env.setdefault("PGUSER", os.environ.get("USER", "hd"))
    cmd = [PSQL_BIN, "cortana", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql]
    result = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if result.returncode != 0:
        raise RuntimeError(f"psql failed: {result.stderr.strip()}")
    out = result.stdout.strip()
    if not out:
        return {}
    return json.loads(out)


def collect_metric_counts(window_days: int) -> Dict[str, Any]:
    sql = f"""
WITH params AS (
  SELECT NOW() - INTERVAL '{int(window_days)} days' AS since_ts
),
incident_counts AS (
  SELECT
    COUNT(*) FILTER (WHERE auto_resolved = TRUE) AS auto_resolved,
    COUNT(*) FILTER (WHERE escalated_to_human = TRUE) AS escalated,
    COUNT(*) AS total
  FROM cortana_autonomy_incidents a, params p
  WHERE a.timestamp >= p.since_ts
),
legacy_autoheal AS (
  SELECT
    COUNT(*) FILTER (WHERE event_type IN ('auto_heal', 'heartbeat_auto_remediation')) AS auto_resolved,
    COUNT(*) FILTER (WHERE event_type IN ('human_escalation', 'human_intervention_required', 'needs_human')) AS escalated
  FROM cortana_events e, params p
  WHERE e.timestamp >= p.since_ts
),
proactive AS (
  SELECT
    COUNT(*) FILTER (WHERE status IN ('useful', 'acted_on')) AS hits,
    COUNT(*) FILTER (WHERE status <> 'pending') AS decided
  FROM cortana_proactive_suggestions s, params p
  WHERE s.timestamp >= p.since_ts
),
auto_tasks AS (
  SELECT
    COUNT(*) FILTER (WHERE auto_executable = TRUE) AS total_auto,
    COUNT(*) FILTER (
      WHERE auto_executable = TRUE
        AND status = 'done'
        AND COALESCE(assigned_to, '') NOT IN ('hamel', 'human')
    ) AS done_auto
  FROM cortana_tasks t, params p
  WHERE t.created_at >= p.since_ts
),
corrections AS (
  SELECT COUNT(*) AS correction_count
  FROM cortana_feedback f, params p
  WHERE f.timestamp >= p.since_ts
    AND f.feedback_type IN ('correction', 'behavior', 'tone', 'fact', 'preference')
),
responses AS (
  SELECT
    COUNT(*) FILTER (WHERE outcome = 'success') AS success_count,
    COUNT(*) FILTER (WHERE outcome = 'partial') AS partial_count,
    COUNT(*) FILTER (WHERE outcome = 'fail') AS fail_count,
    COUNT(*) AS total
  FROM cortana_response_evaluations r, params p
  WHERE r.timestamp >= p.since_ts
),
memory_checks AS (
  SELECT
    COUNT(*) FILTER (WHERE correct = TRUE) AS correct_count,
    COUNT(*) AS total
  FROM cortana_memory_recall_checks m, params p
  WHERE m.timestamp >= p.since_ts
),
heartbeat_crons AS (
  SELECT
    COUNT(*) FILTER (WHERE status = 'ok') AS ok_count,
    COUNT(*) AS total
  FROM cortana_cron_health c, params p
  WHERE c.timestamp >= p.since_ts
    AND c.cron_name ILIKE '%heartbeat%'
),
all_crons AS (
  SELECT
    COUNT(*) FILTER (WHERE status = 'ok') AS ok_count,
    COUNT(*) AS total
  FROM cortana_cron_health c, params p
  WHERE c.timestamp >= p.since_ts
)
SELECT json_build_object(
  'incident_auto_resolved', COALESCE((SELECT auto_resolved FROM incident_counts), 0) + COALESCE((SELECT auto_resolved FROM legacy_autoheal), 0),
  'incident_escalated', COALESCE((SELECT escalated FROM incident_counts), 0) + COALESCE((SELECT escalated FROM legacy_autoheal), 0),
  'proactive_hits', COALESCE((SELECT hits FROM proactive), 0),
  'proactive_decided', COALESCE((SELECT decided FROM proactive), 0),
  'auto_tasks_done', COALESCE((SELECT done_auto FROM auto_tasks), 0),
  'auto_tasks_total', COALESCE((SELECT total_auto FROM auto_tasks), 0),
  'correction_count', COALESCE((SELECT correction_count FROM corrections), 0),
  'response_success', COALESCE((SELECT success_count FROM responses), 0),
  'response_partial', COALESCE((SELECT partial_count FROM responses), 0),
  'response_fail', COALESCE((SELECT fail_count FROM responses), 0),
  'response_total', COALESCE((SELECT total FROM responses), 0),
  'memory_correct', COALESCE((SELECT correct_count FROM memory_checks), 0),
  'memory_total', COALESCE((SELECT total FROM memory_checks), 0),
  'heartbeat_ok', COALESCE((SELECT ok_count FROM heartbeat_crons), 0),
  'heartbeat_total', COALESCE((SELECT total FROM heartbeat_crons), 0),
  'cron_ok', COALESCE((SELECT ok_count FROM all_crons), 0),
  'cron_total', COALESCE((SELECT total FROM all_crons), 0)
);
"""
    return _run_sql_json(sql)


def compute_scorecard(window_days: int = 7) -> Dict[str, Any]:
    counts = collect_metric_counts(window_days)

    incident_total = counts["incident_auto_resolved"] + counts["incident_escalated"]
    self_heal_rate = 100.0 if incident_total == 0 else (counts["incident_auto_resolved"] / incident_total) * 100.0

    proactive_hit_rate = 100.0 if counts["proactive_decided"] == 0 else (counts["proactive_hits"] / counts["proactive_decided"]) * 100.0

    task_completion_rate = 100.0 if counts["auto_tasks_total"] == 0 else (counts["auto_tasks_done"] / counts["auto_tasks_total"]) * 100.0

    correction_rate_per_day = counts["correction_count"] / max(window_days, 1)
    correction_frequency_score = _clamp(100.0 - (correction_rate_per_day * 50.0))

    if counts["response_total"] == 0:
        response_quality_score = 100.0
    else:
        response_quality_score = (
            (counts["response_success"] * 1.0) +
            (counts["response_partial"] * 0.5)
        ) / counts["response_total"] * 100.0

    memory_accuracy = 100.0 if counts["memory_total"] == 0 else (counts["memory_correct"] / counts["memory_total"]) * 100.0

    heartbeat_rate = 100.0 if counts["heartbeat_total"] == 0 else (counts["heartbeat_ok"] / counts["heartbeat_total"]) * 100.0
    cron_rate = 100.0 if counts["cron_total"] == 0 else (counts["cron_ok"] / counts["cron_total"]) * 100.0
    uptime_score = (heartbeat_rate * 0.7) + (cron_rate * 0.3)

    metrics = {
        "self_heal_rate": round(_clamp(self_heal_rate), 2),
        "proactive_hit_rate": round(_clamp(proactive_hit_rate), 2),
        "task_completion_rate": round(_clamp(task_completion_rate), 2),
        "correction_frequency_score": round(_clamp(correction_frequency_score), 2),
        "response_quality_score": round(_clamp(response_quality_score), 2),
        "memory_accuracy": round(_clamp(memory_accuracy), 2),
        "uptime_score": round(_clamp(uptime_score), 2),
    }

    score = 0.0
    for key, weight in DEFAULT_WEIGHTS.items():
        score += metrics[key] * weight

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "window_days": window_days,
        "score": round(_clamp(score), 2),
        "weights": DEFAULT_WEIGHTS,
        "metrics": metrics,
        "counts": counts,
    }


def compute_and_store_scorecard(window_days: int = 7, dry_run: bool = False) -> Dict[str, Any]:
    scorecard = compute_scorecard(window_days=window_days)
    if not dry_run:
        # Use plain psql for multi-statement write path.
        m = scorecard["metrics"]
        snapshot_payload = json.dumps(scorecard)
        weights_payload = json.dumps(scorecard["weights"])
        counts_payload = json.dumps(scorecard["counts"])
        metrics_payload = json.dumps(m)

        sql = f"""
INSERT INTO cortana_autonomy_scorecard_snapshots (
  window_days, score, self_heal_rate, proactive_hit_rate, task_completion_rate,
  correction_frequency_score, response_quality_score, memory_accuracy, uptime_score,
  metrics, weights
)
VALUES (
  {int(scorecard['window_days'])}, {scorecard['score']}, {m['self_heal_rate']}, {m['proactive_hit_rate']}, {m['task_completion_rate']},
  {m['correction_frequency_score']}, {m['response_quality_score']}, {m['memory_accuracy']}, {m['uptime_score']},
  '{snapshot_payload}'::jsonb, '{weights_payload}'::jsonb
);

UPDATE cortana_self_model
SET metadata = COALESCE(metadata, '{{}}'::jsonb) || jsonb_build_object(
  'autonomy_scorecard', jsonb_build_object(
    'score', {scorecard['score']},
    'window_days', {int(scorecard['window_days'])},
    'updated_at', NOW(),
    'metrics', '{metrics_payload}'::jsonb,
    'counts', '{counts_payload}'::jsonb
  )
),
updated_at = NOW()
WHERE id = 1;
"""
        env = os.environ.copy()
        env.setdefault("PGHOST", "localhost")
        env.setdefault("PGUSER", os.environ.get("USER", "hd"))
        cmd = [PSQL_BIN, "cortana", "-X", "-v", "ON_ERROR_STOP=1", "-c", sql]
        result = subprocess.run(cmd, capture_output=True, text=True, env=env)
        if result.returncode != 0:
            raise RuntimeError(f"failed storing autonomy scorecard: {result.stderr.strip()}")
    return scorecard


def main() -> None:
    parser = argparse.ArgumentParser(description="Compute Cortana autonomy scorecard")
    parser.add_argument("--window-days", type=int, default=7)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true", help="print scorecard JSON")
    args = parser.parse_args()

    scorecard = compute_and_store_scorecard(window_days=args.window_days, dry_run=args.dry_run)

    if args.json or args.dry_run:
        print(json.dumps(scorecard, indent=2))
    else:
        print(f"Autonomy score: {scorecard['score']:.2f} (window={args.window_days}d)")


if __name__ == "__main__":
    main()
