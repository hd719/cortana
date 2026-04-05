import { describe, expect, it } from "vitest";

import {
  buildAthleteStateSchemaSql,
  buildFetchAthleteStateRowSql,
  buildFetchAthleteStateWindowSql,
  buildFetchMuscleVolumeWindowSql,
  buildMuscleVolumeSchemaSql,
  buildReplaceMuscleVolumeSql,
  buildUpsertAthleteStateSql,
} from "../../tools/fitness/athlete-state-db.ts";
import { buildFetchHealthSourceRowsStatement } from "../../tools/fitness/health-source-db.ts";

describe("fitness athlete state DB helpers", () => {
  it("builds the athlete-state and muscle-volume schemas", () => {
    const athleteSchema = buildAthleteStateSchemaSql();
    const muscleSchema = buildMuscleVolumeSchemaSql();

    expect(athleteSchema).toContain("CREATE TABLE IF NOT EXISTS cortana_fitness_athlete_state_daily");
    expect(athleteSchema).toContain("state_date DATE PRIMARY KEY");
    expect(athleteSchema).toContain("recommendation_mode TEXT");
    expect(athleteSchema).toContain("body_weight_source TEXT");
    expect(athleteSchema).toContain("active_energy_kcal NUMERIC(8,2)");
    expect(athleteSchema).toContain("health_context JSONB NOT NULL DEFAULT '{}'::jsonb");
    expect(athleteSchema).toContain("quality_flags JSONB NOT NULL DEFAULT '{}'::jsonb");
    expect(muscleSchema).toContain("CREATE TABLE IF NOT EXISTS cortana_fitness_muscle_volume_daily");
    expect(muscleSchema).toContain("PRIMARY KEY (state_date, muscle_group)");
    expect(muscleSchema).toContain("load_bucket_summary JSONB NOT NULL DEFAULT '{}'::jsonb");
  });

  it("builds a safe athlete-state upsert statement", () => {
    const sql = buildUpsertAthleteStateSql({
      stateDate: "2026-04-06",
      generatedAt: "2026-04-06T12:00:00Z",
      readinessScore: 63,
      readinessBand: "yellow",
      whoopStrain: 12.4,
      bodyWeightSource: "apple_health",
      activeEnergyKcal: 650,
      healthContext: {
        goal_mode: "on_pace",
      },
      phaseMode: "lean_gain",
      recommendationMode: "controlled_train",
      qualityFlags: {
        note: "coach's warning",
      },
    });

    expect(sql).toContain("INSERT INTO cortana_fitness_athlete_state_daily");
    expect(sql).toContain("ON CONFLICT (state_date) DO UPDATE");
    expect(sql).toContain("recommendation_mode");
    expect(sql).toContain("body_weight_source");
    expect(sql).toContain("active_energy_kcal");
    expect(sql).toContain("health_context");
    expect(sql).toContain("quality_flags");
    expect(sql).toContain("coach''s warning");
  });

  it("builds replacement and fetch SQL for muscle-volume rows", () => {
    const replaceSql = buildReplaceMuscleVolumeSql("2026-04-06", [
      {
        stateDate: "2026-04-06",
        muscleGroup: "chest",
        hardSets: 8,
        sourceConfidence: 0.9,
      },
      {
        stateDate: "2026-04-06",
        muscleGroup: "back",
        hardSets: 10,
        notes: { unmapped: 1 },
      },
    ]);

    expect(replaceSql).toContain("DELETE FROM cortana_fitness_muscle_volume_daily");
    expect(replaceSql).toContain("muscle_group");
    expect(replaceSql).toContain("source_confidence");
    expect(replaceSql).toContain("\"unmapped\":1");

    const rowSql = buildFetchAthleteStateRowSql("2026-04-06");
    const windowSql = buildFetchAthleteStateWindowSql("2026-04-01", "2026-04-07");
    const muscleWindowSql = buildFetchMuscleVolumeWindowSql("2026-04-01", "2026-04-07");
    const healthWindowSql = buildFetchHealthSourceRowsStatement("2026-04-01", "2026-04-07", "body_weight_kg");
    expect(rowSql).toContain("WHERE state_date = '2026-04-06'::date");
    expect(windowSql).toContain("BETWEEN '2026-04-01'::date AND '2026-04-07'::date");
    expect(muscleWindowSql).toContain("cortana_fitness_muscle_volume_daily");
    expect(healthWindowSql).toContain("metric_name = 'body_weight_kg'");
  });
});
