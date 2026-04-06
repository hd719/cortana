import { describe, expect, it } from "vitest";

import {
  coachCheckinDateLocal,
  hasCoachCheckinSignal,
  parseCoachCheckin,
} from "../../tools/fitness/post-workout-note-parser.ts";

describe("fitness post-workout note parser", () => {
  it("parses a completed post-workout check-in with soreness, motivation, and schedule constraints", () => {
    const parsed = parseCoachCheckin(
      "Post-workout check-in: done. Soreness 6/10. Feeling strong and ready to go, but traveling for work so I need a short session tomorrow.",
      { timestampUtc: "2026-04-05T23:15:00Z" },
    );

    expect(parsed.checkinType).toBe("post_workout");
    expect(parsed.complianceStatus).toBe("completed");
    expect(parsed.completed).toBe(true);
    expect(parsed.missed).toBe(false);
    expect(parsed.sorenessScore).toBe(6);
    expect(parsed.painFlag).toBe(false);
    expect(parsed.motivationScore).toBe(8);
    expect(parsed.scheduleConstraints).toEqual(["short_session", "travel"]);
    expect(parsed.scheduleConstraint).toBe("short_session");
    expect(parsed.confidence).toBe("high");
    expect(parsed.explicitSignalCount).toBeGreaterThanOrEqual(4);
    expect(parsed.matchedSignals).toEqual(expect.arrayContaining([
      "checkin_type_post_workout",
      "compliance_completed",
      "soreness_numeric",
      "motivation_high",
      "schedule_short_session",
      "schedule_travel",
    ]));
    expect(hasCoachCheckinSignal(parsed)).toBe(true);
    expect(coachCheckinDateLocal("2026-04-05T23:15:00Z")).toBe("2026-04-05");
  });

  it("parses a missed check-in with pain and external constraints", () => {
    const parsed = parseCoachCheckin(
      "Missed today. Pain in my left shoulder, no workout because of a late meeting and family pickup.",
      { timestampUtc: "2026-04-05T21:00:00Z" },
    );

    expect(parsed.checkinType).toBe("evening");
    expect(parsed.complianceStatus).toBe("missed");
    expect(parsed.completed).toBe(false);
    expect(parsed.missed).toBe(true);
    expect(parsed.painFlag).toBe(true);
    expect(parsed.scheduleConstraints).toEqual(["late_meeting", "family_commitment"]);
    expect(parsed.scheduleConstraint).toBe("late_meeting");
    expect(parsed.confidence).toBe("high");
    expect(parsed.matchedSignals).toEqual(expect.arrayContaining([
      "compliance_missed",
      "pain_flag",
      "schedule_late_meeting",
      "schedule_family_commitment",
      "checkin_type_inferred_evening",
    ]));
  });

  it("parses a pending evening check-in with short-session and motivation signals", () => {
    const parsed = parseCoachCheckin(
      "Not yet. Planning to train tonight after dinner, only have a short session and motivation is 3/10.",
      { timestampUtc: "2026-04-05T15:00:00Z" },
    );

    expect(parsed.checkinType).toBe("evening");
    expect(parsed.complianceStatus).toBe("pending");
    expect(parsed.completed).toBe(false);
    expect(parsed.missed).toBe(false);
    expect(parsed.motivationScore).toBe(3);
    expect(parsed.scheduleConstraints).toEqual(["short_session"]);
    expect(parsed.scheduleConstraint).toBe("short_session");
    expect(parsed.confidence).toBe("high");
    expect(parsed.matchedSignals).toEqual(expect.arrayContaining([
      "compliance_pending",
      "motivation_numeric",
      "schedule_short_session",
      "checkin_type_evening",
    ]));
  });

  it("uses midday inference and qualitative soreness when the note is light on explicit fields", () => {
    const parsed = parseCoachCheckin("Lunch check-in: pretty sore but no pain, decent energy, ready to go.", {
      timestampUtc: "2026-04-05T15:30:00Z",
    });

    expect(parsed.checkinType).toBe("midday");
    expect(parsed.complianceStatus).toBe("unknown");
    expect(parsed.sorenessScore).toBe(5);
    expect(parsed.painFlag).toBe(false);
    expect(parsed.motivationScore).toBe(8);
    expect(parsed.confidence).toBe("high");
    expect(parsed.matchedSignals).toEqual(expect.arrayContaining([
      "soreness_moderate",
      "motivation_high",
      "checkin_type_midday",
    ]));
  });
});
