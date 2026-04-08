import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildAndPersistCurrentTonalCatalog } from "../../tools/fitness/refresh-current-tonal-catalog.ts";

describe("fitness refresh current tonal catalog", () => {
  it("builds and persists a current-tonal-catalog snapshot from a Tonal payload", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spartan-tonal-catalog-"));
    const outputPath = path.join(tempDir, "current-tonal-catalog.json");
    const markdownPath = path.join(tempDir, "current-tonal-catalog.md");
    const payload = {
      profile: { userId: "user-1", totalWorkouts: 2 },
      workouts: {
        "activity-1": {
          id: "activity-1",
          beginTime: "2026-04-03T12:00:00Z",
          totalDuration: 1800,
          totalVolume: 12000,
          workoutId: "workout-upper-1",
          programId: "program-a",
          workoutType: "Linear",
          workoutSetActivity: [
            { id: "set-1", workoutActivityID: "activity-1", setId: "set-1", movementId: "8edc0211-4594-4e5e-8e1b-b05dfc1d67c7", repCount: 8, avgWeight: 50, totalVolume: 400 },
            { id: "set-2", workoutActivityID: "activity-1", setId: "set-2", movementId: "ec9edd5f-4745-45b7-b78b-b7368839ca38", repCount: 10, avgWeight: 45, totalVolume: 450 },
          ],
        },
        "activity-2": {
          id: "activity-2",
          beginTime: "2026-04-04T12:00:00Z",
          totalDuration: 1650,
          totalVolume: 9800,
          workoutId: "workout-lower-1",
          programId: null,
          workoutType: "Linear",
          workoutSetActivity: [
            { id: "set-3", workoutActivityID: "activity-2", setId: "set-3", movementId: "ef5f1802-a99e-4e56-b473-32bbf353fb73", repCount: 8, avgWeight: 70, totalVolume: 560 },
          ],
        },
      },
      strength_scores: null,
    };

    const { catalog, write } = buildAndPersistCurrentTonalCatalog(payload, { outputPath, markdownPath });

    expect(write.ok).toBe(true);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.existsSync(markdownPath)).toBe(true);
    expect(catalog.summary.workoutsSeen).toBe(2);
    expect(catalog.summary.movementsSeen).toBe(3);

    const persisted = JSON.parse(fs.readFileSync(outputPath, "utf8")) as { summary: { workoutsSeen: number; movementsSeen: number } };
    expect(persisted.summary.workoutsSeen).toBe(2);
    expect(persisted.summary.movementsSeen).toBe(3);

    const markdown = fs.readFileSync(markdownPath, "utf8");
    expect(markdown).toContain("# Current Tonal Catalog");
    expect(markdown).toContain("Workouts seen: 2");
  });
});
