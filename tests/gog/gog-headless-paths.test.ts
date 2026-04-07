import { describe, expect, it } from "vitest";
import fs from "node:fs";

describe("headless Gog calendar paths", () => {
  it("routes earnings calendar creation through the env-aware helper", () => {
    const text = fs.readFileSync("tools/earnings/create-calendar-events.ts", "utf8");
    expect(text).toContain("gog-with-env.ts");
    expect(text).not.toContain('gog cal add "$CAL_NAME"');
    expect(text).not.toContain('gog cal list "$CAL_NAME"');
  });

  it("routes weekly compounder calendar reads through the env-aware helper", () => {
    const text = fs.readFileSync("tools/weekly-compounder/weekly-compounder.ts", "utf8");
    expect(text).toContain("gog-with-env.ts");
    expect(text).not.toContain('gog cal list "Clawdbot-Calendar"');
    expect(text).not.toContain('gog calendar events "$CAL_ID"');
  });
});
