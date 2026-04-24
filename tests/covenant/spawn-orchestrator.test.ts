import { describe, expect, it } from "vitest";
import { normalizeSpawnHandshake, planSpawn, renderSpawnPrompt } from "../../tools/covenant/spawn-orchestrator.ts";

describe("spawn orchestrator boundary", () => {
  it("normalizes legacy sparse handshakes", () => {
    expect(normalizeSpawnHandshake({ role: "Huragok", objective: "Fix CI" })).toMatchObject({
      harness: "sessions_spawn",
      role: "huragok",
      model: "openai-codex/gpt-5.3-codex",
      objective: "Fix CI",
    });
  });

  it("blocks non sessions_spawn harnesses through the shared validator", () => {
    const plan = planSpawn({ harness: "codex-cli", role: "huragok", model: "openai-codex/gpt-5.3-codex", objective: "Fix CI" });
    expect(plan.valid).toBe(false);
    expect(plan.validation.reason).toContain("not using sessions_spawn");
  });

  it("renders a stable prompt from a validated plan", () => {
    const plan = planSpawn({ role: "monitor", objective: "Check cron drift", repoPath: "/repo" });
    expect(renderSpawnPrompt(plan)).toContain("Role: monitor");
    expect(renderSpawnPrompt(plan)).toContain("Repo: /repo");
  });
});
