import { describe, expect, it } from "vitest";
import { parseVacationOpsArgs, recommendVacationWindow } from "../../tools/vacation/vacation-ops.ts";

describe("vacation ops CLI", () => {
  it("parses the documented subcommand flags", () => {
    const parsed = parseVacationOpsArgs([
      "enable",
      "--json",
      "--window-id", "12",
      "--start", "2026-04-20T12:00:00.000Z",
      "--end", "2026-04-30T12:00:00.000Z",
      "--timezone", "America/New_York",
    ]);
    expect(parsed.command).toBe("enable");
    expect(parsed.json).toBe(true);
    expect(parsed.windowId).toBe(12);
    expect(parsed.timezone).toBe("America/New_York");
  });

  it("recommends prep roughly 24 hours before departure", () => {
    const recommendation = recommendVacationWindow("2026-04-20T12:00:00.000Z", "2026-04-30T12:00:00.000Z", "America/New_York");
    expect(recommendation.recommended_prep_at).toBe("2026-04-19T12:00:00.000Z");
  });
});
