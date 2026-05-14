import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import * as contextModule from "../../tools/context/main-operator-context.ts";
import { buildMainIdentityOverlay, writeMainBootstrap, writeMainIdentityOverlay } from "../../tools/context/refresh-main-bootstrap.ts";

describe("writeMainBootstrap", () => {
  it("writes a compact BOOTSTRAP.md snapshot", () => {
    vi.spyOn(contextModule, "collectOperatorContext").mockReturnValue({
      generatedAt: "Mon, Apr 6, 8:00 AM",
      schedule: ["9:00 AM - Standup"],
      reminders: ["Submit quiz"],
      followUps: {
        items: [{ title: "Fix degraded runtime", system: "mission-control", severity: "high", due_at: "Apr 06 05:00 PM" }],
        openCount: 1,
      },
      warnings: [],
    });

    const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "main-bootstrap-")), "BOOTSTRAP.md");
    const content = writeMainBootstrap(filePath);

    expect(fs.readFileSync(filePath, "utf8")).toBe(content);
    expect(content).toContain("# BOOTSTRAP.md");
    expect(content).toContain("- 9:00 AM - Standup");
    expect(content).toContain("- Submit quiz");
    expect(content).toContain("- [high] Fix degraded runtime (due Apr 06 05:00 PM)");
  });
});

describe("writeMainIdentityOverlay", () => {
  it("writes the live snapshot ahead of durable identity text", () => {
    vi.spyOn(contextModule, "collectOperatorContext").mockReturnValue({
      generatedAt: "Mon, Apr 6, 8:00 AM",
      schedule: ["9:00 AM - Standup"],
      reminders: ["Submit quiz"],
      followUps: {
        items: [{ title: "Fix degraded runtime", system: "mission-control", severity: "high", due_at: "Apr 06 05:00 PM" }],
        openCount: 1,
      },
      warnings: [],
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "main-identity-"));
    const out = path.join(dir, "IDENTITY.md");
    const root = path.join(dir, "root-IDENTITY.md");
    fs.writeFileSync(root, "Cortana durable identity.\n", "utf8");

    const content = writeMainIdentityOverlay(out, root);

    expect(fs.readFileSync(out, "utf8")).toBe(content);
    expect(content).toContain("# IDENTITY.md");
    expect(content).toContain("Generated: Mon, Apr 6, 8:00 AM");
    expect(content).toContain("## Durable Identity");
    expect(content).toContain("Cortana durable identity.");
  });

  it("builds a stable overlay layout", () => {
    const content = buildMainIdentityOverlay("# BOOTSTRAP.md\nGenerated: now", "Durable.");
    expect(content).toContain("Current operator-state snapshot first");
    expect(content).toContain("## Durable Identity");
  });
});
