import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Spartan fitness voice playbook", () => {
  it("exists with scenario examples, banned phrases, and rewrite gate", () => {
    const filePath = path.resolve("identities/spartan/VOICE.md");
    const content = fs.readFileSync(filePath, "utf8");

    expect(content).toContain("voice translation layer");
    expect(content).toContain("Do Not Sound Like This");
    expect(content).toContain("Rewrite Gate");
    expect(content).toContain("Morning — Green");
    expect(content).toContain("Morning — Yellow");
    expect(content).toContain("Morning — Red");
    expect(content).toContain("Morning — Stale Or Uncertain Data");
    expect(content).toContain("Evening Recap");
    expect(content).toContain("Weekly Check-In");
    expect(content).toContain("Alerts");
    expect(content).toContain("\"You're in a good spot today.\"");
    expect(content).toContain("\"This is a day to train hard but clean.\"");
    expect(content).toContain("\"Today should feel solid if you stay disciplined.\"");
    expect(content).toContain("\"Action:\"");
    expect(content).toContain("\"Longevity impact\"");
  });
});
