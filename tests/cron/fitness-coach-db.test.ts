import { describe, expect, it } from "vitest";

import {
  buildCoachConversationUpsertSql,
  buildCoachDecisionUpsertSql,
  buildFetchCoachNutritionRowSql,
  buildCoachNutritionUpsertSql,
  buildCoachSchemaSql,
} from "../../tools/fitness/coach-db.ts";
import { resolveSpartanPhaseDefaults } from "../../tools/fitness/spartan-defaults.ts";

describe("fitness coach DB helpers", () => {
  it("adds linkage columns needed by the coaching loop schema", () => {
    const schema = buildCoachSchemaSql();

    expect(schema).toContain("linked_state_date date");
    expect(schema).toContain("linked_decision_key text");
    expect(schema).toContain("parsed_entities jsonb NOT NULL DEFAULT '{}'::jsonb");
    expect(schema).toContain("source_state_date date");
    expect(schema).toContain("source_iso_week text");
    expect(schema).toContain("expected_followup_by timestamptz");
    expect(schema).toContain("decision_key text UNIQUE");
    expect(schema).toContain("payload jsonb NOT NULL DEFAULT '{}'::jsonb");
    expect(schema).toContain("calories_actual_kcal numeric(8,2)");
    expect(schema).toContain("carbs_g numeric(8,2)");
    expect(schema).toContain("fats_g numeric(8,2)");
    expect(schema).toContain("hydration_liters numeric(8,3)");
    expect(schema).toContain("meals_logged int");
    expect(schema).toContain("confidence text");
    expect(schema).toContain("phase_mode text");
  });

  it("resolves typed phase defaults for the nutrition baseline", () => {
    const cut = resolveSpartanPhaseDefaults("gentle_cut");
    const maintain = resolveSpartanPhaseDefaults("maintenance");

    expect(cut.proteinTargetG).toBe(160);
    expect(cut.targetCutRatePctPerWeek).toBe(0.35);
    expect(maintain.proteinTargetG).toBe(140);
    expect(maintain.caloriesDeltaKcalPerDay).toBe(0);
  });

  it("builds a safe conversation upsert with parsed entities and decision linkage", () => {
    const sql = buildCoachConversationUpsertSql({
      sourceKey: "spartan:session:abc",
      tsUtc: "2026-04-05T11:30:00Z",
      channel: "telegram",
      direction: "inbound",
      messageText: "I finished but O'Brien says my shoulder hurts.",
      intent: "training_update",
      linkedStateDate: "2026-04-05",
      linkedDecisionKey: "spartan:decision:morning:2026-04-05",
      parsedEntities: {
        pain_flag: true,
        schedule_constraint: "travel",
      },
    });

    expect(sql).toContain("INSERT INTO coach_conversation_log");
    expect(sql).toContain("linked_state_date");
    expect(sql).toContain("linked_decision_key");
    expect(sql).toContain("parsed_entities");
    expect(sql).toContain("spartan:decision:morning:2026-04-05");
    expect(sql).toContain("O''Brien");
  });

  it("builds a safe decision upsert with stable decision keys", () => {
    const sql = buildCoachDecisionUpsertSql({
      tsUtc: "2026-04-05T11:35:00Z",
      readinessCall: "Yellow",
      longevityImpact: "neutral",
      topRisk: "Sleep quality drag reducing adaptation.",
      reasonSummary: "Moderate readiness supports controlled work.",
      prescribedAction: "Run a controlled session.",
      actualDayStrain: 8.4,
      sleepPerfPct: 79,
      recoveryScore: 58,
      sourceStateDate: "2026-04-05",
      sourceIsoWeek: "2026-W14",
      expectedFollowupBy: "2026-04-05T20:30:00Z",
      decisionKey: "spartan:decision:morning:2026-04-05",
      payload: {
        today_mission_key: "spartan:2026-04-05:yellow:controlled_train",
      },
    });

    expect(sql).toContain("INSERT INTO coach_decision_log");
    expect(sql).toContain("ON CONFLICT (decision_key) DO UPDATE");
    expect(sql).toContain("source_state_date");
    expect(sql).toContain("source_iso_week");
    expect(sql).toContain("expected_followup_by");
    expect(sql).toContain("today_mission_key");
  });

  it("builds a nutrition upsert that persists the new daily nutrition fields", () => {
    const sql = buildCoachNutritionUpsertSql({
      dateLocal: "2026-04-05",
      proteinTargetG: 160,
      proteinActualG: 148,
      hydrationStatus: "moderate",
      caloriesActualKcal: 2450.5,
      carbsG: 210.25,
      fatsG: 72,
      hydrationLiters: 2.35,
      mealsLogged: 5,
      confidence: "high",
      phaseMode: "gentle_cut",
      notes: "baseline day with manual hydration estimate",
    });

    expect(sql).toContain("INSERT INTO coach_nutrition_log");
    expect(sql).toContain("calories_actual_kcal");
    expect(sql).toContain("carbs_g");
    expect(sql).toContain("fats_g");
    expect(sql).toContain("hydration_liters");
    expect(sql).toContain("meals_logged");
    expect(sql).toContain("confidence");
    expect(sql).toContain("phase_mode");
    expect(sql).toContain("baseline day with manual hydration estimate");
    expect(sql).toContain("gentle_cut");
    expect(sql).toContain("ON CONFLICT (date_local) DO UPDATE");
  });

  it("builds a fetch query for one nutrition row", () => {
    const sql = buildFetchCoachNutritionRowSql("2026-04-05");

    expect(sql).toContain("FROM coach_nutrition_log");
    expect(sql).toContain("protein_target_g");
    expect(sql).toContain("hydration_liters");
    expect(sql).toContain("WHERE date_local = '2026-04-05'::date");
  });
});
