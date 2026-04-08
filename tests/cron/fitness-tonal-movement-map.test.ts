import { describe, expect, it } from "vitest";

import { normalizeTonalMovementKey, resolveTonalMovement } from "../../tools/fitness/tonal-movement-map.ts";

describe("fitness tonal movement map", () => {
  it("prefers explicit tonal movement ids over conflicting titles", () => {
    const resolution = resolveTonalMovement({
      movementId: "c7737825-dd6f-44b4-9b25-6ee66b43d07d",
      movementTitle: "Bench Press",
    });

    expect(resolution.mapped).toBe(true);
    expect(resolution.movementKey).toBe("split squat");
    expect(resolution.muscleGroup).toBe("quads");
    expect(resolution.pattern).toBe("lunge");
    expect(resolution.confidenceLabel).toBe("high");
    expect(resolution.reason).toContain("movement id");
  });

  it("canonicalizes mapped title aliases to the same movement key", () => {
    const resolution = resolveTonalMovement({
      movementTitle: "Decline Fly",
    });

    expect(resolution.mapped).toBe(true);
    expect(resolution.movementKey).toBe("decline chest fly");
    expect(resolution.movementId).toBe("f4d78bdf-f70c-4f3c-bccb-78e9ff80f9fb");
    expect(resolution.muscleGroup).toBe("chest");
    expect(resolution.pattern).toBe("fly");
    expect(resolution.aliases).toContain("Decline Fly");
  });

  it("excludes tonal rest placeholders from muscle mapping", () => {
    const resolution = resolveTonalMovement({
      movementId: "00000000-0000-0000-0000-000000000005",
    });

    expect(resolution.mapped).toBe(false);
    expect(resolution.movementKey).toBe("rest");
    expect(resolution.muscleGroup).toBe("unmapped");
    expect(resolution.pattern).toBe("other");
    expect(resolution.confidenceLabel).toBe("high");
    expect(resolution.reason).toContain("Rest");
  });

  it("returns a low-confidence unmapped result for unknown movements", () => {
    const resolution = resolveTonalMovement({
      movementId: "11111111-2222-3333-4444-555555555555",
      movementTitle: "Dragon Press",
    });

    expect(resolution.mapped).toBe(false);
    expect(resolution.movementKey).toBe("dragon press");
    expect(resolution.muscleGroup).toBe("unmapped");
    expect(resolution.pattern).toBe("other");
    expect(resolution.confidenceLabel).toBe("low");
    expect(resolution.reason).toContain("Dragon Press");
  });

  it("normalizes slash-heavy tonal titles consistently", () => {
    expect(normalizeTonalMovementKey("Lateral Bridge w/ Row")).toBe("lateral bridge w row");
  });
});
