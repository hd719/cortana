import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, flushModuleSideEffects, importFresh, resetProcess, setArgv } from "../test-utils";

const execSync = vi.hoisted(() => vi.fn());
const existsSync = vi.hoisted(() => vi.fn(() => true));
const realpathSync = vi.hoisted(() => vi.fn((p: string) => p));
const readFileSync = vi.hoisted(() => vi.fn(() => {
  throw new Error("missing state");
}));
const writeFileSync = vi.hoisted(() => vi.fn());
const mkdirSync = vi.hoisted(() => vi.fn());
const reconcileMissionControlFeedbackSignal = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("node:child_process", () => ({ execSync }));
vi.mock("node:fs", () => ({
  default: {
    existsSync,
    realpathSync,
    readFileSync,
    writeFileSync,
    mkdirSync,
  },
}));
vi.mock("../../tools/feedback/mission-control-feedback-signal.js", () => ({
  reconcileMissionControlFeedbackSignal,
}));

type RepoMockState = {
  branch: string;
  upstream: string;
  head: string;
  originHead: string;
  remoteUrl: string;
  clean: boolean;
  mergeBase?: Record<string, boolean>;
};

describe("runtime-repo-drift-monitor", () => {
  beforeEach(() => {
    execSync.mockReset();
    existsSync.mockReset();
    realpathSync.mockReset();
    readFileSync.mockReset();
    writeFileSync.mockReset();
    mkdirSync.mockReset();
    reconcileMissionControlFeedbackSignal.mockReset();
    reconcileMissionControlFeedbackSignal.mockResolvedValue({ ok: true });
    existsSync.mockImplementation((filePath: string) => {
      const value = String(filePath);
      return !value.includes("/Users/hd/Developer/cortana-deploy/.git") &&
        !value.includes("/Users/hd/openclaw/.git") &&
        value !== "/Users/hd/openclaw";
    });
    realpathSync.mockImplementation((p: string) => p);
    readFileSync.mockImplementation(() => {
      throw new Error("missing state");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetProcess();
  });

  function seedRepos(repos: Record<string, RepoMockState>) {
    execSync.mockImplementation((cmd: string, options?: { cwd?: string }) => {
      const cwd = options?.cwd;
      if (!cwd || !(cwd in repos)) throw new Error(`unexpected cwd: ${cwd ?? "none"}`);
      const repo = repos[cwd];

      if (cmd.startsWith("git fetch ")) return "";
      if (cmd === "git rev-parse --abbrev-ref HEAD") return `${repo.branch}\n`;
      if (cmd === "git rev-parse --abbrev-ref --symbolic-full-name @{u}") return `${repo.upstream}\n`;
      if (cmd === "git rev-parse HEAD") return `${repo.head}\n`;
      if (cmd === "git rev-parse origin/main") return `${repo.originHead}\n`;
      if (cmd === "git remote get-url origin") return `${repo.remoteUrl}\n`;
      if (cmd === "git status --porcelain --untracked-files=all") return repo.clean ? "" : " M README.md\n";
      if (cmd.startsWith("git merge-base --is-ancestor ")) {
        const parts = cmd.split(/\s+/);
        const key = `${parts[3]}->${parts[4]}`;
        if (repo.mergeBase?.[key] === false) {
          throw new Error(`not ancestor: ${key}`);
        }
        return "";
      }

      throw new Error(`unexpected command: ${cmd}`);
    });
  }

  async function runMonitor(args: string[] = []) {
    setArgv(args);
    const consoleSpy = captureConsole();
    await importFresh("../../tools/monitoring/runtime-repo-drift-monitor.ts");
    await flushModuleSideEffects();
    consoleSpy.restore();
    return consoleSpy.logs.join("\n");
  }

  it("returns NO_REPLY when source and runtime repos are healthy", async () => {
    seedRepos({
      "/source": {
        branch: "main",
        upstream: "origin/main",
        head: "abc123",
        originHead: "abc123",
        remoteUrl: "git@github-cortana:hd719/cortana.git",
        clean: true,
      },
      "/runtime": {
        branch: "main",
        upstream: "origin/main",
        head: "abc123",
        originHead: "abc123",
        remoteUrl: "git@github-cortana:hd719/cortana.git",
        clean: true,
      },
    });

    const output = await runMonitor(["--source-repo", "/source", "--runtime-repo", "/runtime"]);
    expect(output).toContain("NO_REPLY");
    expect(reconcileMissionControlFeedbackSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        recurrenceKey: "ops:runtime-repo-drift",
        signalState: "cleared",
      }),
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("runtime-repo-drift-monitor-state.json"),
      expect.stringContaining('"active": false'),
      "utf8",
    );
  });

  it("defaults runtime repo to the source repo when no runtime override is provided", async () => {
    const sourceRepo = {
      branch: "main",
      upstream: "origin/main",
      head: "abc123",
      originHead: "abc123",
      remoteUrl: "git@github-cortana:hd719/cortana.git",
      clean: true,
    };

    seedRepos({
      "/source": sourceRepo,
      "/Users/hd/Developer/cortana": sourceRepo,
    });

    const output = await runMonitor(["--json", "--source-repo", "/source"]);
    const payload = JSON.parse(output);
    expect(payload.status).toBe("healthy");
    expect(payload.actionable ?? []).toEqual([]);
    expect(payload.missing ?? []).toEqual([]);
  });

  it("prefers the deploy worktree as default source repo when it exists", async () => {
    existsSync.mockImplementation(() => true);

    seedRepos({
      "/Users/hd/Developer/cortana-deploy": {
        branch: "main",
        upstream: "origin/main",
        head: "abc123",
        originHead: "abc123",
        remoteUrl: "git@github-cortana:hd719/cortana.git",
        clean: true,
      },
      "/Users/hd/openclaw": {
        branch: "main",
        upstream: "origin/main",
        head: "abc123",
        originHead: "abc123",
        remoteUrl: "git@github-cortana:hd719/cortana.git",
        clean: true,
      },
    });

    const output = await runMonitor(["--json"]);
    const payload = JSON.parse(output);
    expect(payload.status).toBe("healthy");
    expect(payload.sourceRepo).toBe("/Users/hd/Developer/cortana-deploy");
    expect(payload.sourceOfTruth).toBe("deploy-worktree");
  });

  it("flags runtime lag behind the source deploy commit", async () => {
    seedRepos({
      "/source": {
        branch: "main",
        upstream: "origin/main",
        head: "def456",
        originHead: "def456",
        remoteUrl: "git@github-cortana:hd719/cortana.git",
        clean: true,
      },
      "/runtime": {
        branch: "main",
        upstream: "origin/main",
        head: "abc123",
        originHead: "abc123",
        remoteUrl: "git@github-cortana:hd719/cortana.git",
        clean: true,
        mergeBase: {
          "abc123->def456": true,
        },
      },
    });

    const output = await runMonitor(["--json", "--source-repo", "/source", "--runtime-repo", "/runtime"]);
    const payload = JSON.parse(output);
    expect(payload.status).toBe("needs_action");
    expect(payload.actionable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "runtime repo is behind the source deploy commit",
        }),
      ]),
    );
    expect(reconcileMissionControlFeedbackSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        recurrenceKey: "ops:runtime-repo-drift",
        signalState: "active",
      }),
    );
  });

  it("suppresses repeated human alerts when the actionable drift state is unchanged", async () => {
    seedRepos({
      "/source": {
        branch: "main",
        upstream: "origin/main",
        head: "def456",
        originHead: "def456",
        remoteUrl: "git@github-cortana:hd719/cortana.git",
        clean: true,
      },
      "/runtime": {
        branch: "main",
        upstream: "origin/main",
        head: "abc123",
        originHead: "abc123",
        remoteUrl: "git@github-cortana:hd719/cortana.git",
        clean: true,
        mergeBase: {
          "abc123->def456": true,
        },
      },
    });

    const firstOutput = await runMonitor(["--source-repo", "/source", "--runtime-repo", "/runtime"]);
    const persisted = writeFileSync.mock.calls.at(-1)?.[1];

    expect(firstOutput).toContain("🧭 Runtime Deploy Drift");
    expect(typeof persisted).toBe("string");

    writeFileSync.mockClear();
    readFileSync.mockImplementation(() => String(persisted));

    const secondOutput = await runMonitor(["--source-repo", "/source", "--runtime-repo", "/runtime"]);
    expect(secondOutput).toContain("NO_REPLY");
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("flags source dirt and missing runtime repo", async () => {
    existsSync.mockImplementation((filePath: string) => filePath !== "/runtime/.git");
    seedRepos({
      "/source": {
        branch: "main",
        upstream: "origin/main",
        head: "abc123",
        originHead: "abc123",
        remoteUrl: "git@github-cortana:hd719/cortana.git",
        clean: false,
      },
    });

    const output = await runMonitor(["--json", "--source-repo", "/source", "--runtime-repo", "/runtime"]);
    const payload = JSON.parse(output);
    expect(payload.status).toBe("needs_action");
    expect(payload.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: expect.objectContaining({ label: "runtime-repo" }),
          reason: "missing repo",
        }),
      ]),
    );
  });

  it("treats a runtime shim to source as healthy when source is healthy", async () => {
    realpathSync.mockImplementation((p: string) => (p === "/runtime" ? "/source" : p));
    seedRepos({
      "/source": {
        branch: "main",
        upstream: "origin/main",
        head: "abc123",
        originHead: "abc123",
        remoteUrl: "git@github-cortana:hd719/cortana.git",
        clean: true,
      },
    });

    const output = await runMonitor(["--json", "--source-repo", "/source", "--runtime-repo", "/runtime"]);
    const payload = JSON.parse(output);
    expect(payload.status).toBe("healthy");
    expect(payload.suppressed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "runtime path is a compatibility shim to the source repo",
        }),
      ]),
    );
  });
});
