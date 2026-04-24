import { describe, expect, it } from "vitest";
import { normalizeBullets, renderBriefSections } from "../../tools/briefing/brief-assembler.ts";

describe("brief assembler", () => {
  it("normalizes noisy bullet text with deterministic fallback", () => {
    expect(normalizeBullets("- First\n* Second\n\n", "Fallback", 2)).toEqual(["First", "Second"]);
    expect(normalizeBullets("", "Fallback")).toEqual(["Fallback"]);
  });

  it("renders sections without leaking undefined or blank bullets", () => {
    const output = renderBriefSections({
      heading: "Brief",
      sections: [
        { title: "Schedule", items: ["9 AM Standup"], recommendation: "Protect focus." },
        { title: "Markets", items: [] },
      ],
    });
    expect(output).toContain("Schedule\n- 9 AM Standup\nRecommendation: Protect focus.");
    expect(output).toContain("Markets\n- Unavailable.");
    expect(output).not.toMatch(/undefined|NaN/);
  });
});
