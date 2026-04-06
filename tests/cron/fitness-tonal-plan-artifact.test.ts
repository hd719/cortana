import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildTonalPlanArtifact,
  persistTonalPlanArtifact,
  renderTonalPlanMarkdown,
  tonalPlanPaths,
} from "../../tools/fitness/tonal-plan-artifact.ts";

describe("fitness tonal plan artifact", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds predictable plan paths", () => {
    const paths = tonalPlanPaths("2026-04-05", "cron-fitness", {
      sandboxRoot: "/tmp/sandbox-plans",
      repoRoot: "/tmp/repo-plans",
      programRoot: "/tmp/repo-programs",
    });

    expect(paths.sandboxJsonPath).toContain("2026-04-05-tomorrow-session.json");
    expect(paths.repoMarkdownPath).toContain("2026-04-05-tomorrow-session.md");
    expect(paths.repoCatalogPath).toContain("current-tonal-catalog.json");
  });

  it("writes json and markdown artifacts that match the structured plan", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tonal-plan-"));
    tempDirs.push(root);
    const artifact = buildTonalPlanArtifact({
      dateLocal: "2026-04-05",
      plan: {
        id: "planner-1",
        stateDate: "2026-04-06",
        isoWeek: "2026-W14",
        planType: "tomorrow",
        sourceTemplateId: "upper-hypertrophy-45m-v1",
        confidence: 0.81,
        targetDurationMinutes: 45,
        targetMuscles: { lagging: ["chest"] },
        sessionBlocks: {
          blocks: [
            {
              blockId: "primary",
              label: "Primary",
              plannedMovements: [
                {
                  label: "Press",
                  movementTitle: "Bench Press",
                  setTarget: 4,
                  repRange: [6, 10],
                },
              ],
            },
          ],
        },
        constraints: { readiness_band: "green" },
        rationale: { planner_goal_mode: "hypertrophy" },
        artifactPath: "/tmp/fake.md",
      },
      librarySummary: {
        workouts_seen: 12,
        movements_seen: 18,
        mapped_movement_pct: 94,
        latest_workout_at: "2026-04-05T12:00:00Z",
      },
    });

    const markdown = renderTonalPlanMarkdown(artifact);
    expect(markdown).toContain("upper-hypertrophy-45m-v1");
    expect(markdown).toContain("Bench Press");

    const write = persistTonalPlanArtifact(artifact, { catalog: "ok" }, {
      sandboxRoot: path.join(root, "sandbox"),
      repoRoot: path.join(root, "repo", "plans"),
      programRoot: path.join(root, "repo", "programs"),
    });

    expect(write.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(write.repoJsonPath, "utf8")).plan.sourceTemplateId).toBe("upper-hypertrophy-45m-v1");
    expect(fs.readFileSync(write.repoMarkdownPath, "utf8")).toContain("Bench Press");
  });
});
