import { describe, expect, it } from "vitest";

import {
  buildFetchLatestTrainingStateWeeklySql,
  buildFetchRecommendationLogsSql,
  buildFetchTrainingStateWeeklySql,
  buildTrainingIntelligenceSchemaSql,
  buildUpsertRecommendationLogSql,
  buildUpsertTrainingStateWeeklySql,
} from "../../tools/fitness/training-intelligence-db.ts";

describe("fitness training intelligence db helpers", () => {
  it("builds the weekly state and recommendation schema", () => {
    const schema = buildTrainingIntelligenceSchemaSql();

    expect(schema).toContain("CREATE TABLE IF NOT EXISTS cortana_fitness_training_state_weekly");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS cortana_fitness_recommendation_log");
    expect(schema).toContain("recommendation_key TEXT UNIQUE");
    expect(schema).toContain("underdosed_muscles JSONB NOT NULL DEFAULT '{}'::jsonb");
  });

  it("builds safe weekly state and recommendation upsert statements", () => {
    const weeklySql = buildUpsertTrainingStateWeeklySql({
      isoWeek: "2026-W14",
      weekStart: "2026-03-30",
      weekEnd: "2026-04-05",
      phaseMode: "lean_gain",
      fatigueScore: 18.5,
      recommendationSummary: {
        mode: "volume_rise",
        rationale: "O'Brien needs more upper body work.",
      },
    });
    const recommendationSql = buildUpsertRecommendationLogSql({
      recommendationKey: "spartan:weekly:2026-W14",
      recommendationScope: "weekly",
      isoWeek: "2026-W14",
      mode: "volume_rise",
      rationale: "O'Brien needs more upper body work.",
    });

    expect(weeklySql).toContain("INSERT INTO cortana_fitness_training_state_weekly");
    expect(weeklySql).toContain("ON CONFLICT (iso_week) DO UPDATE");
    expect(weeklySql).toContain("O''Brien");
    expect(recommendationSql).toContain("INSERT INTO cortana_fitness_recommendation_log");
    expect(recommendationSql).toContain("ON CONFLICT (recommendation_key) DO UPDATE");
    expect(recommendationSql).toContain("spartan:weekly:2026-W14");
  });

  it("builds fetch SQL for latest weekly state and scoped recommendation logs", () => {
    expect(buildFetchTrainingStateWeeklySql("2026-W14")).toContain("WHERE iso_week = '2026-W14'");
    expect(buildFetchLatestTrainingStateWeeklySql()).toContain("ORDER BY week_start DESC");
    expect(buildFetchRecommendationLogsSql("weekly", "2026-W14")).toContain("recommendation_scope = 'weekly'");
    expect(buildFetchRecommendationLogsSql("daily", "2026-04-05")).toContain("state_date = '2026-04-05'::date");
  });
});
