import { describe, expect, it } from "vitest";
import { extractMealEntriesFromText, summarizeMealRollup, type MealEntry } from "../../tools/fitness/meal-log.ts";

describe("fitness meal log parsing", () => {
  it("extracts tagged meal entries with macros and note", () => {
    const text = [
      "Conversation info (untrusted metadata): ...",
      "#meal p=42 cals=510 carbs=38 fat=19 water=1.5 note=\"post lift bowl\"",
      "other text",
      "#meal protein=55 calories=650 hydration=750ml note=steak",
    ].join("\n");

    const rows = extractMealEntriesFromText(text, "2026-03-18T13:00:00.000Z", "session.jsonl");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      proteinG: 42,
      calories: 510,
      carbsG: 38,
      fatG: 19,
      hydrationLiters: 1.5,
      note: "post lift bowl",
    });
    expect(rows[1]).toMatchObject({
      proteinG: 55,
      calories: 650,
      hydrationLiters: 0.75,
      note: "steak",
    });
  });

  it("ignores malformed meal tags without numeric or note signal", () => {
    const text = "#meal nothing_here\n#meal note=\n#meal p=abc";
    const rows = extractMealEntriesFromText(text, "2026-03-18T13:00:00.000Z", "session.jsonl");
    expect(rows).toHaveLength(0);
  });

  it("computes daily and trailing protein adherence rollups", () => {
    const entries: MealEntry[] = [
      {
        timestamp: "2026-03-18T10:00:00.000Z",
        date: "2026-03-18",
        proteinG: 60,
        calories: 700,
        carbsG: 60,
        fatG: 20,
        hydrationLiters: 1.5,
        note: null,
        sourceFile: "a.jsonl",
      },
      {
        timestamp: "2026-03-18T16:00:00.000Z",
        date: "2026-03-18",
        proteinG: 70,
        calories: 800,
        carbsG: 70,
        fatG: 25,
        hydrationLiters: 0.75,
        note: null,
        sourceFile: "a.jsonl",
      },
      {
        timestamp: "2026-03-17T16:00:00.000Z",
        date: "2026-03-17",
        proteinG: 120,
        calories: 1900,
        carbsG: 140,
        fatG: 60,
        hydrationLiters: 2,
        note: null,
        sourceFile: "b.jsonl",
      },
    ];

    const rollup = summarizeMealRollup(entries, "2026-03-18");
    expect(rollup.today.proteinG).toBe(130);
    expect(rollup.today.hydrationLiters).toBe(2.25);
    expect(rollup.today.proteinStatus).toBe("on_target");
    expect(rollup.trailing7.daysLogged).toBe(2);
    expect(rollup.trailing7.daysMeetingProteinTarget).toBe(2);
    expect(rollup.trailing7.avgDailyHydrationLiters).toBe(2.13);
  });
});
