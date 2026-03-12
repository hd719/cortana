import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, flushModuleSideEffects, importFresh, resetProcess, setArgv, useFixedTime } from "../test-utils";

const execSync = vi.hoisted(() => vi.fn());
const readFileSync = vi.hoisted(() => vi.fn());
const copyFileSync = vi.hoisted(() => vi.fn());
const writeFileSync = vi.hoisted(() => vi.fn());
const homedir = vi.hoisted(() => vi.fn(() => "/home/test"));

vi.mock("node:child_process", () => ({ execSync }));
vi.mock("node:fs", () => ({
  default: {
    readFileSync,
    copyFileSync,
    writeFileSync,
  },
}));
vi.mock("node:os", () => ({ default: { homedir } }));

describe("runtime-repo-drift-monitor", () => {
  beforeEach(() => {
    execSync.mockReset();
    readFileSync.mockReset();
    copyFileSync.mockReset();
    writeFileSync.mockReset();
    useFixedTime("2026-03-03T11:00:00.000Z");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetProcess();
  });

  function seedFiles(entries: Record<string, string>) {
    readFileSync.mockImplementation((file: string) => {
      if (!(file in entries)) throw new Error(`missing: ${file}`);
      return Buffer.from(entries[file]);
    });
  }

  function cronJobsJson(nameA = "Runtime Job", nameB = "Repo Job") {
    return JSON.stringify({
      jobs: [
        { id: "job-1", name: nameA, payload: { kind: "agentTurn", message: "runtime" }, state: { nextRunAtMs: 1 } },
        { id: "job-2", name: nameB, payload: { kind: "agentTurn", message: "shared" } },
      ],
    });
  }

  async function runMonitor(args: string[] = [], env: Record<string, string | undefined> = {}) {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    setArgv(args);
    const consoleSpy = captureConsole();
    await importFresh("../../tools/monitoring/runtime-repo-drift-monitor.ts");
    await flushModuleSideEffects();
    consoleSpy.restore();
    return consoleSpy.logs.join("\n");
  }

  it("uses vitest-style module side-effect execution and is non-destructive by default", async () => {
    seedFiles({
      "/home/test/.openclaw/cron/jobs.json": cronJobsJson("Runtime Job", "Shared Job"),
      "/home/test/.openclaw/agent-profiles.json": "same-profiles",
      "/repo/config/cron/jobs.json": cronJobsJson("Repo Job", "Shared Job"),
      "/repo/config/agent-profiles.json": "same-profiles",
    });

    const output = await runMonitor(["--repo-root", "/repo"]);

    expect(output).toContain("🧭 Runtime/Repo Drift Detected");
    expect(output).toContain("cron/jobs.json: actionable config drift");
    expect(execSync).not.toHaveBeenCalled();
    expect(copyFileSync).not.toHaveBeenCalled();
  });

  it("suppresses broad runtime-only state drift and stays quiet", async () => {
    seedFiles({
      "/home/test/.openclaw/cron/jobs.json": JSON.stringify({ jobs: [{ id: "1", name: "A", state: { nextRunAtMs: 1 } }] }),
      "/repo/config/cron/jobs.json": JSON.stringify({ jobs: [{ id: "1", name: "A", state: { nextRunAtMs: 2 } }] }),
      "/home/test/.openclaw/agent-profiles.json": JSON.stringify({ profiles: [] }),
      "/repo/config/agent-profiles.json": JSON.stringify({ profiles: [] }),
    });

    const output = await runMonitor(["--repo-root", "/repo"]);
    expect(output).toContain("NO_REPLY");
  });

  it("emits json visibility with suppressed drift details", async () => {
    seedFiles({
      "/home/test/.openclaw/cron/jobs.json": JSON.stringify({ jobs: [{ id: "1", name: "A", state: { nextRunAtMs: 1 } }] }),
      "/repo/config/cron/jobs.json": JSON.stringify({ jobs: [{ id: "1", name: "A", state: { nextRunAtMs: 2 } }] }),
      "/home/test/.openclaw/agent-profiles.json": JSON.stringify({ profiles: [] }),
      "/repo/config/agent-profiles.json": JSON.stringify({ profiles: [] }),
    });

    const output = await runMonitor(["--json", "--repo-root", "/repo"]);
    const payload = JSON.parse(output);
    expect(payload.status).toBe("healthy");
    expect(payload.suppressed).toHaveLength(1);
    expect(payload.suppressed[0].check.label).toBe("cron/jobs.json");
  });

  it("suppresses actionable drift during intentional runtime patch cooldown", async () => {
    seedFiles({
      "/home/test/.openclaw/cron/jobs.json": cronJobsJson("Runtime Job", "Shared Job"),
      "/repo/config/cron/jobs.json": cronJobsJson("Repo Job", "Shared Job"),
      "/home/test/.openclaw/agent-profiles.json": JSON.stringify({ profiles: [] }),
      "/repo/config/agent-profiles.json": JSON.stringify({ profiles: [] }),
      "/home/test/.openclaw/state/runtime-repo-drift-cooldown.json": JSON.stringify({
        entries: [{ label: "cron/jobs.json", untilMs: 1772535900000, reason: "manual hotfix" }],
      }),
    });

    const output = await runMonitor(["--json", "--repo-root", "/repo"]);
    const payload = JSON.parse(output);
    expect(payload.status).toBe("healthy");
    expect(payload.suppressed[0].reason).toContain("intentional runtime patch cooldown active");
  });

  it("enables auto-pr when --auto-pr is passed", async () => {
    seedFiles({
      "/home/test/.openclaw/cron/jobs.json": cronJobsJson("Runtime Job", "Shared Job"),
      "/home/test/.openclaw/agent-profiles.json": "same-profiles",
      "/repo/config/cron/jobs.json": cronJobsJson("Repo Job", "Shared Job"),
      "/repo/config/agent-profiles.json": "same-profiles",
    });

    execSync.mockImplementation((cmd: string) => {
      if (cmd === "git diff --cached --name-only") return "config/cron/jobs.json";
      if (cmd.startsWith("gh pr create ")) return "https://github.com/acme/repo/pull/999";
      return "";
    });

    const output = await runMonitor(["--auto-pr", "--repo-root", "/repo"]);

    expect(execSync).toHaveBeenCalled();
    expect(copyFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).toHaveBeenCalled();
    expect(output).toContain("auto-pr opened: https://github.com/acme/repo/pull/999");
  });

  it("enables auto-pr when DRIFT_AUTO_PR=1", async () => {
    seedFiles({
      "/home/test/.openclaw/cron/jobs.json": cronJobsJson("Runtime Job", "Shared Job"),
      "/home/test/.openclaw/agent-profiles.json": "same-profiles",
      "/repo/config/cron/jobs.json": cronJobsJson("Repo Job", "Shared Job"),
      "/repo/config/agent-profiles.json": "same-profiles",
    });

    execSync.mockImplementation((cmd: string) => {
      if (cmd === "git diff --cached --name-only") return "config/cron/jobs.json";
      if (cmd.startsWith("gh pr create ")) return "https://github.com/acme/repo/pull/1000";
      return "";
    });

    const output = await runMonitor(["--repo-root", "/repo"], { DRIFT_AUTO_PR: "1" });

    expect(execSync).toHaveBeenCalled();
    expect(output).toContain("auto-pr opened: https://github.com/acme/repo/pull/1000");
  });

  it("supports dry-run auto-pr mode without mutating files or running git/gh", async () => {
    seedFiles({
      "/home/test/.openclaw/cron/jobs.json": cronJobsJson("Runtime Job", "Shared Job"),
      "/home/test/.openclaw/agent-profiles.json": "same-profiles",
      "/repo/config/cron/jobs.json": cronJobsJson("Repo Job", "Shared Job"),
      "/repo/config/agent-profiles.json": "same-profiles",
    });

    const output = await runMonitor(["--auto-pr", "--dry-run", "--repo-root", "/repo"]);

    expect(execSync).not.toHaveBeenCalled();
    expect(copyFileSync).not.toHaveBeenCalled();
    expect(output).toContain("DRY_RUN auto-pr: would create chore/runtime-repo-drift-sync-202603031100");
  });

  it("parses repo-root/base/branch-prefix arguments for git/gh commands", async () => {
    seedFiles({
      "/home/test/.openclaw/cron/jobs.json": cronJobsJson("Runtime Job", "Shared Job"),
      "/home/test/.openclaw/agent-profiles.json": "same-profiles",
      "/custom/repo/config/cron/jobs.json": cronJobsJson("Repo Job", "Shared Job"),
      "/custom/repo/config/agent-profiles.json": "same-profiles",
    });

    const commands: string[] = [];
    execSync.mockImplementation((cmd: string) => {
      commands.push(cmd);
      if (cmd === "git diff --cached --name-only") return "config/cron/jobs.json";
      if (cmd.startsWith("gh pr create ")) return "https://github.com/acme/repo/pull/1001";
      return "";
    });

    await runMonitor([
      "--auto-pr",
      "--repo-root",
      "/custom/repo",
      "--base",
      "develop",
      "--branch-prefix",
      "chore/custom-drift",
    ]);

    expect(commands).toContain("git checkout develop");
    expect(commands).toContain("git pull --ff-only origin develop");
    expect(commands).toContain("git checkout -b chore/custom-drift-202603031100");
    expect(commands.some((c) => c.includes("gh pr create --base develop --head chore/custom-drift-202603031100"))).toBe(true);
    expect(copyFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).toHaveBeenCalled();
  });
});
