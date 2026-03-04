import { describe, expect, it } from "vitest";
import { buildActions, inferPillar, renderScorecard, validateScorecard, wordCount } from "../../tools/mission-scorecard/daily-mission-scorecard";

describe("daily mission scorecard", () => {
  it("infers pillar from keywords", () => {
    expect(inferPillar("Whoop recovery and sleep lock-in")).toBe("health");
    expect(inferPillar("portfolio concentration review")).toBe("wealth");
    expect(inferPillar("masters assignment shipment")).toBe("career");
  });

  it("builds all four pillars with fallback coverage", () => {
    const actions = buildActions(
      [
        { id: 1, title: "Review mortgage rates", description: null, priority: 2, status: "ready", due_at: null },
        { id: 2, title: "Sleep + workout block", description: null, priority: 1, status: "ready", due_at: null },
      ],
      [],
    );

    expect(actions).toHaveLength(4);
    expect(actions.map((a) => a.pillar)).toEqual(["time", "health", "wealth", "career"]);
  });

  it("renders telegram output under word limit with validation", () => {
    const actions = [
      { pillar: "time", text: "Set first deep work block.", minutes: 30, source: "task" as const },
      { pillar: "health", text: "Train to readiness and lock bedtime.", minutes: 45, source: "task" as const },
      { pillar: "wealth", text: "Run portfolio risk pulse.", minutes: 20, source: "task" as const },
      { pillar: "career", text: "Ship one visible artifact before noon.", minutes: 50, source: "task" as const },
    ];

    const output = renderScorecard(actions, "Finish the highest-leverage deliverable first.");
    expect(wordCount(output)).toBeLessThanOrEqual(180);

    const validation = validateScorecard(output);
    expect(validation.ok).toBe(true);
    expect(validation.errors).toEqual([]);
  });
});
