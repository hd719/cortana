import { describe, expect, it } from "vitest";

import {
  buildCoachAlertSchemaSql,
  buildCoachAlertUpsertSql,
  buildCoachCheckinSchemaSql,
  buildCoachCheckinUpsertSql,
  buildCoachOutcomeEvalWeeklySchemaSql,
  buildCoachOutcomeEvalWeeklyUpsertSql,
} from "../../tools/fitness/checkin-db.ts";

describe("fitness check-in DB helpers", () => {
  it("builds the coaching loop schema for check-ins and alerts", () => {
    const checkinSchema = buildCoachCheckinSchemaSql();
    const alertSchema = buildCoachAlertSchemaSql();
    const outcomeSchema = buildCoachOutcomeEvalWeeklySchemaSql();

    expect(checkinSchema).toContain("CREATE TABLE IF NOT EXISTS coach_checkin_log");
    expect(checkinSchema).toContain("source_key text UNIQUE NOT NULL");
    expect(checkinSchema).toContain("checkin_type text NOT NULL");
    expect(checkinSchema).toContain("schedule_constraint text");
    expect(checkinSchema).toContain("CREATE INDEX IF NOT EXISTS idx_coach_checkin_date_local");
    expect(checkinSchema).toContain("CREATE INDEX IF NOT EXISTS idx_coach_checkin_type");
    expect(checkinSchema).toContain("CREATE INDEX IF NOT EXISTS idx_coach_checkin_ts_utc");

    expect(alertSchema).toContain("CREATE TABLE IF NOT EXISTS coach_alert_log");
    expect(alertSchema).toContain("alert_key text UNIQUE NOT NULL");
    expect(alertSchema).toContain("severity text NOT NULL");
    expect(alertSchema).toContain("delivered boolean NOT NULL DEFAULT FALSE");
    expect(alertSchema).toContain("CREATE INDEX IF NOT EXISTS idx_coach_alert_type");
    expect(alertSchema).toContain("CREATE INDEX IF NOT EXISTS idx_coach_alert_ts_utc");

    expect(outcomeSchema).toContain("CREATE TABLE IF NOT EXISTS coach_outcome_eval_weekly");
    expect(outcomeSchema).toContain("iso_week text PRIMARY KEY");
    expect(outcomeSchema).toContain("overall_score int NOT NULL");
    expect(outcomeSchema).toContain("explanation jsonb NOT NULL DEFAULT '{}'::jsonb");
  });

  it("builds a safe check-in upsert statement", () => {
    const sql = buildCoachCheckinUpsertSql({
      sourceKey: "spartan:checkin:abc123",
      tsUtc: "2026-04-05T23:15:00Z",
      dateLocal: "2026-04-05",
      checkinType: "post_workout",
      complianceStatus: "completed",
      sorenessScore: 6,
      painFlag: false,
      motivationScore: 8,
      scheduleConstraint: "travel",
      rawText: "Post-workout note from O'Brien",
      parsed: {
        speaker: "O'Brien",
        confidence: "high",
      },
    });

    expect(sql).toContain("INSERT INTO coach_checkin_log");
    expect(sql).toContain("ON CONFLICT (source_key) DO UPDATE");
    expect(sql).toContain("COALESCE(coach_checkin_log.parsed, '{}'::jsonb) || COALESCE(EXCLUDED.parsed, '{}'::jsonb)");
    expect(sql).toContain("O''Brien");
    expect(sql).toContain("post_workout");
  });

  it("builds a safe alert upsert statement", () => {
    const sql = buildCoachAlertUpsertSql({
      alertKey: "alert:spartan:001",
      tsUtc: "2026-04-05T23:20:00Z",
      alertType: "checkin_missed",
      severity: "warning",
      delivered: true,
      deliveredAt: "2026-04-05T23:25:00Z",
      context: {
        message: "Coach can't reach O'Brien right now",
        priority: "high",
      },
    });

    expect(sql).toContain("INSERT INTO coach_alert_log");
    expect(sql).toContain("ON CONFLICT (alert_key) DO UPDATE");
    expect(sql).toContain("COALESCE(coach_alert_log.context, '{}'::jsonb) || COALESCE(EXCLUDED.context, '{}'::jsonb)");
    expect(sql).toContain("Coach can''t reach O''Brien right now");
    expect(sql).toContain("checkin_missed");
  });

  it("builds a safe weekly outcome evaluation upsert", () => {
    const sql = buildCoachOutcomeEvalWeeklyUpsertSql({
      isoWeek: "2026-W14",
      weekStart: "2026-03-30",
      weekEnd: "2026-04-05",
      overallScore: 82,
      adherenceScore: 85,
      recoveryAlignmentScore: 78,
      nutritionAlignmentScore: 80,
      riskManagementScore: 83,
      performanceAlignmentScore: 79,
      explanation: {
        summary: "strong alignment",
      },
      evidence: {
        overreach_alerts: 0,
      },
    });

    expect(sql).toContain("INSERT INTO coach_outcome_eval_weekly");
    expect(sql).toContain("ON CONFLICT (iso_week) DO UPDATE");
    expect(sql).toContain("performance_alignment_score");
    expect(sql).toContain("strong alignment");
  });
});
