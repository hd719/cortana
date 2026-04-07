import { describe, expect, it } from "vitest";
import fs from "node:fs";

describe("headless Gog calendar paths", () => {
  it("teaches the env-aware wrapper in the Gog skill for OpenClaw sessions", () => {
    const text = fs.readFileSync("skills/gog/SKILL.md", "utf8");
    expect(text).toContain("do not call raw `gog` directly");
    expect(text).toContain("tools/gog/gog-with-env.ts");
    expect(text).toContain("paste the keyring passphrase into chat");
  });

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
