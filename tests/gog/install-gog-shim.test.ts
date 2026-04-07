import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildGogShimScript, installGogShim } from "../../tools/gog/install-gog-shim";

describe("install-gog-shim", () => {
  it("builds a shim that routes through the env-aware helper", () => {
    const script = buildGogShimScript("/repo");
    expect(script).toContain('/repo/tools/gog/gog-with-env.ts');
    expect(script).toContain('OPENCLAW_REAL_GOG_BIN');
    expect(script).toContain('npx tsx');
  });

  it("writes an executable gog shim", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gog-shim-"));
    const shimPath = path.join(tempDir, "bin", "gog");

    const result = installGogShim(shimPath, "/repo");
    const stat = fs.statSync(shimPath);

    expect(result.changed).toBe(true);
    expect(fs.readFileSync(shimPath, "utf8")).toContain('/repo/tools/gog/gog-with-env.ts');
    expect((stat.mode & 0o111) !== 0).toBe(true);
  });
});
