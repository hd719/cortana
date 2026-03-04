import { describe, expect, it } from "vitest";
import { buildTemplatePrompt, getTemplate, listTemplates } from "../../tools/covenant/run_templates";

describe("run templates", () => {
  it("lists the common templates", () => {
    const ids = listTemplates().map((t) => t.id).sort();
    expect(ids).toEqual(["docs-update", "fix-test", "pr-review"]);
  });

  it("builds a prompt with checklist", () => {
    const prompt = buildTemplatePrompt("fix-test", "Patch flaky timeout test in task-board lane");
    expect(prompt).toContain("Template: Fix + Test");
    expect(prompt).toContain("Execution checklist:");
    expect(prompt).toContain("Patch flaky timeout test");
  });

  it("rejects unknown templates", () => {
    expect(() => getTemplate("nope")).toThrow(/Unknown template/);
  });
});
