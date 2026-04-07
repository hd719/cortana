import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findInstalledOpenClawGogSkillPaths, syncGogSkillTargets } from "../../tools/openclaw/gog-skill-sync";

describe("gog-skill-sync", () => {
  it("finds installed global Gog skill paths", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gog-skill-sync-"));
    const globalRoot = path.join(tempDir, "global");
    const target = path.join(
      globalRoot,
      "5",
      ".pnpm",
      "openclaw@2026.4.5_foo",
      "node_modules",
      "openclaw",
      "skills",
      "gog",
      "SKILL.md",
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "old skill\n", "utf8");

    expect(findInstalledOpenClawGogSkillPaths(globalRoot)).toEqual([target]);
  });

  it("copies the repo Gog skill into installed OpenClaw skill targets", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gog-skill-sync-"));
    const source = path.join(tempDir, "source.md");
    const target = path.join(tempDir, "target.md");

    fs.writeFileSync(source, "new skill\n", "utf8");
    fs.writeFileSync(target, "old skill\n", "utf8");

    const result = syncGogSkillTargets(source, [target]);

    expect(result.changed).toBe(true);
    expect(result.updated).toEqual([target]);
    expect(fs.readFileSync(target, "utf8")).toBe("new skill\n");
  });
});
