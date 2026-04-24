import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("sync-cron-to-runtime", () => {
  const script = path.resolve(process.cwd(), "tools/cron/sync-cron-to-runtime.ts");

  it("uses the script repo by default even when invoked from another cwd", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cron-sync-foreign-cwd-"));
    const foreignCwd = path.join(root, "foreign");
    const runtimeHome = path.join(root, "home");
    const repoRoot = process.cwd();

    fs.mkdirSync(foreignCwd, { recursive: true });
    writeJson(path.join(runtimeHome, ".openclaw", "cron", "jobs.json"), readJson(path.join(repoRoot, "config", "cron", "jobs.json")));

    const result = spawnSync(
      "npx",
      ["tsx", script, "--check", "--json", "--runtime-home", runtimeHome],
      { cwd: foreignCwd, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      repoFile: string;
      runtimeFile: string;
      changed: boolean;
      semanticMatch: boolean;
    };

    expect(payload.repoFile).toBe(path.join(repoRoot, "config", "cron", "jobs.json"));
    expect(payload.runtimeFile).toBe(path.join(runtimeHome, ".openclaw", "cron", "jobs.json"));
    expect(payload.changed).toBe(false);
    expect(payload.semanticMatch).toBe(true);
  });

  it("ignores approved managed runtime-only jobs when checking semantic drift", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cron-sync-"));
    const repoRoot = path.join(root, "repo");
    const runtimeHome = path.join(root, "home");

    writeJson(path.join(repoRoot, "config", "cron", "jobs.json"), {
      jobs: [{ id: "brief", name: "Morning Brief", enabled: true, schedule: { kind: "cron", expr: "0 6 * * *" } }],
    });

    writeJson(path.join(runtimeHome, ".openclaw", "cron", "jobs.json"), {
      jobs: [
        {
          id: "brief",
          name: "Morning Brief",
          enabled: true,
          schedule: { kind: "cron", expr: "0 6 * * *" },
          state: { nextRunAtMs: 123 },
        },
        {
          id: "a528ac8a-41ea-4af6-8dfa-98ca64d2243d",
          name: "Memory Dreaming Promotion",
          description: "[managed-by=memory-core.short-term-promotion] Promote weighted short-term recalls.",
          enabled: true,
          schedule: { kind: "cron", expr: "0 3 * * *" },
          payload: { kind: "systemEvent", text: "__openclaw_memory_core_short_term_promotion_dream__" },
        },
      ],
    });

    const result = spawnSync(
      "npx",
      ["tsx", script, "--check", "--json", "--repo-root", repoRoot, "--runtime-home", runtimeHome],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      changed: boolean;
      semanticMatch: boolean;
      droppedRuntimeOnlyJobs: string[];
      preservedManagedRuntimeOnlyJobs: string[];
    };

    expect(payload.changed).toBe(false);
    expect(payload.semanticMatch).toBe(true);
    expect(payload.droppedRuntimeOnlyJobs).toEqual([]);
    expect(payload.preservedManagedRuntimeOnlyJobs).toEqual(["a528ac8a-41ea-4af6-8dfa-98ca64d2243d"]);
  });
});

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
