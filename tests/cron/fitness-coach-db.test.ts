import { describe, expect, it } from "vitest";

import {
  buildCoachConversationUpsertSql,
  buildCoachDecisionUpsertSql,
  buildCoachSchemaSql,
} from "../../tools/fitness/coach-db.ts";

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
});
