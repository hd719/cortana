import { describe, expect, it } from "vitest";

import {
  DEFAULT_TONAL_PROGRAM_TEMPLATES,
  selectTonalTemplates,
} from "../../tools/fitness/tonal-template-library.ts";

describe("fitness tonal template library", () => {
  it("ships the required versioned templates", () => {
    const ids = DEFAULT_TONAL_PROGRAM_TEMPLATES.map((template) => template.templateId);
    expect(ids).toContain("upper-hypertrophy-45m-v1");
    expect(ids).toContain("lower-hypertrophy-45m-v1");
    expect(ids).toContain("push-45m-v1");
    expect(ids).toContain("pull-45m-v1");
    expect(ids).toContain("full-body-30m-v1");
    expect(ids).toContain("recovery-30m-v1");
    expect(ids).toContain("cut-support-upper-45m-v1");
    expect(ids).toContain("cut-support-lower-45m-v1");
    expect(DEFAULT_TONAL_PROGRAM_TEMPLATES.every((template) => template.version >= 1)).toBe(true);
  });

  it("selects deterministic templates for recovery and time-constrained contexts", () => {
    const recovery = selectTonalTemplates({
      goalMode: "recovery",
      availableTimeMinutes: 30,
      readinessBand: "red",
      preferredTags: ["low_fatigue"],
    });
    expect(recovery[0]?.templateId).toBe("recovery-30m-v1");

    const fast = selectTonalTemplates({
      goalMode: "maintenance",
      availableTimeMinutes: 22,
      readinessBand: "yellow",
      preferredTags: ["time_constrained"],
    });
    expect(fast[0]?.durationMinutes).toBeLessThanOrEqual(30);
  });
});
