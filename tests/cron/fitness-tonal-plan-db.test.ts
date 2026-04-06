import { describe, expect, it } from "vitest";

import {
  buildLinkPlannerSessionToRecommendationSql,
  buildTonalPlanSchemaSql,
  buildUpsertPlannedSessionSql,
  buildUpsertProgramTemplateSql,
  buildUpsertTonalLibrarySnapshotSql,
} from "../../tools/fitness/tonal-plan-db.ts";

describe("fitness tonal plan DB helpers", () => {
  it("builds the planner schema and additive recommendation-log fields", () => {
    const sql = buildTonalPlanSchemaSql();
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS cortana_fitness_tonal_library_snapshot");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS cortana_fitness_program_template");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS cortana_fitness_planned_session");
    expect(sql).toContain("DELETE FROM cortana_fitness_planned_session");
    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_planned_session_unique");
    expect(sql).toContain("ALTER TABLE cortana_fitness_recommendation_log ADD COLUMN IF NOT EXISTS planner_session_id UUID");
    expect(sql).toContain("ALTER TABLE cortana_fitness_recommendation_log ADD COLUMN IF NOT EXISTS planner_context JSONB");
  });

  it("builds safe snapshot and template upserts", () => {
    const snapshotSql = buildUpsertTonalLibrarySnapshotSql({
      snapshotDate: "2026-04-05",
      userId: "user-1",
      workoutsSeen: 24,
      movementsSeen: 35,
      qualityFlags: { missing_program_id_workouts: 2 },
    });
    expect(snapshotSql).toContain("INSERT INTO cortana_fitness_tonal_library_snapshot");
    expect(snapshotSql).toContain("'2026-04-05'::date");

    const templateSql = buildUpsertProgramTemplateSql({
      templateId: "upper-hypertrophy-45m-v1",
      version: 1,
      goalMode: "hypertrophy",
      splitType: "upper_lower",
      durationMinutes: 45,
      tonalRequired: true,
      templateBody: { focus: "upper", sessionLabel: "Upper", blocks: [] },
      tags: ["upper_emphasis"],
      active: true,
    });
    expect(templateSql).toContain("INSERT INTO cortana_fitness_program_template");
    expect(templateSql).toContain("'upper-hypertrophy-45m-v1'");
  });

  it("builds planned-session inserts and recommendation links", () => {
    const plannedSql = buildUpsertPlannedSessionSql({
      stateDate: "2026-04-06",
      isoWeek: "2026-W14",
      planType: "tomorrow",
      sourceTemplateId: "upper-hypertrophy-45m-v1",
      confidence: 0.81,
      targetDurationMinutes: 45,
      targetMuscles: { lagging: ["chest"] },
      sessionBlocks: { blocks: [] },
      constraints: { readiness_band: "green" },
      rationale: { planner_goal_mode: "hypertrophy" },
      artifactPath: "/tmp/plan.md",
    });
    expect(plannedSql).toContain("INSERT INTO cortana_fitness_planned_session");
    expect(plannedSql).toContain("WITH upserted AS");
    expect(plannedSql).toContain("ON CONFLICT (plan_type, state_date, iso_week) DO UPDATE");

    const linkSql = buildLinkPlannerSessionToRecommendationSql("spartan:planner:2026-04-06", "11111111-1111-1111-1111-111111111111", {
      template_id: "upper-hypertrophy-45m-v1",
    });
    expect(linkSql).toContain("planner_session_id = '11111111-1111-1111-1111-111111111111'::uuid");
    expect(linkSql).toContain("WHERE recommendation_key = 'spartan:planner:2026-04-06'");
  });
});
