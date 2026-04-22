import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = path.resolve("tools/repo/repo-auto-sync.sh");
const cleanupPaths = new Set<string>();

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

function setupMergedBranchRepo(prefix: string): {
  repoDir: string;
  branchName: string;
  rootDir: string;
} {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  cleanupPaths.add(rootDir);

  const originDir = path.join(rootDir, "origin.git");
  const repoDir = path.join(rootDir, "repo");

  run(`git init --bare ${shQuote(originDir)}`, rootDir);
  run(`git clone ${shQuote(originDir)} ${shQuote(repoDir)}`, rootDir);

  run("git config user.name 'Repo Auto Sync Test'", repoDir);
  run("git config user.email 'repo-auto-sync-test@example.com'", repoDir);
  run("git checkout -b main", repoDir);

  fs.writeFileSync(path.join(repoDir, "README.md"), "seed\n", "utf8");
  run("git add README.md", repoDir);
  run("git commit -m 'seed'", repoDir);
  run("git push -u origin main", repoDir);

  const branchName = "feature/merged-temp";
  run(`git checkout -b ${shQuote(branchName)}`, repoDir);
  fs.writeFileSync(path.join(repoDir, "feature.txt"), "feature\n", "utf8");
  run("git add feature.txt", repoDir);
  run("git commit -m 'feature branch commit'", repoDir);
  run("git checkout main", repoDir);
  run(`git merge --ff-only ${shQuote(branchName)}`, repoDir);
  run("git push origin main", repoDir);

  return { repoDir, branchName, rootDir };
}

function runBranchCleanup(repoDir: string): { stdout: string; stderr: string; status: number } {
  const command = `set -euo pipefail; source ${shQuote(scriptPath)}; cleanup_local_merged_branches ${shQuote(repoDir)}`;
  const result = spawnSync("bash", ["-lc", command], {
    cwd: repoDir,
    encoding: "utf8",
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

function hasLocalBranch(repoDir: string, branchName: string): boolean {
  const result = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
    cwd: repoDir,
  });
  return result.status === 0;
}

function runRepoAutoSync(repoDir: string, extraArgs: string[] = []): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bash", [scriptPath, "--repo", repoDir, ...extraArgs], {
    cwd: repoDir,
    encoding: "utf8",
    env: process.env,
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

function setupFakeGh(rootDir: string): { binDir: string; callsPath: string } {
  const binDir = path.join(rootDir, "bin");
  const callsPath = path.join(rootDir, "gh-calls.log");
  fs.mkdirSync(binDir, { recursive: true });
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(callsPath)}
if [[ "$1 $2" == "pr create" ]]; then
  echo https://github.com/hd719/cortana/pull/4242
  exit 0
fi
if [[ "$1 $2" == "pr list" ]]; then
  echo '[]'
  exit 0
fi
exit 0
`,
    { mode: 0o755 },
  );

  return { binDir, callsPath };
}

function runRepoAutoSyncWithEnv(
  repoDir: string,
  env: NodeJS.ProcessEnv,
  extraArgs: string[] = [],
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bash", [scriptPath, "--repo", repoDir, ...extraArgs], {
    cwd: repoDir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

afterEach(() => {
  for (const target of cleanupPaths) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  cleanupPaths.clear();
});

describe("repo-auto-sync worktree conflict automation", () => {
  it("does not fail preflight when stash entries exist and snapshots metadata", () => {
    const { repoDir } = setupMergedBranchRepo("repo-auto-sync-stash-preflight");
    const snapshotLog = path.join(repoDir, "stash-snapshot.log");

    fs.writeFileSync(path.join(repoDir, "preflight-dirty.txt"), "dirty\n", "utf8");
    run("git add preflight-dirty.txt", repoDir);
    run("git stash push --include-untracked -m 'manual stash before preflight test'", repoDir);

    const command = `set -euo pipefail; source ${shQuote(scriptPath)}; REPO_AUTO_SYNC_STASH_SNAPSHOT_LOG=${shQuote(snapshotLog)}; ensure_no_stash_preflight ${shQuote(repoDir)}`;
    const result = spawnSync("bash", ["-lc", command], {
      cwd: repoDir,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("detail=stash-present-continue");
    expect(result.stderr).toContain("detail=stash-entry");
    expect(result.stderr).toContain("detail=stash-snapshot-written");

    const snapshot = fs.readFileSync(snapshotLog, "utf8");
    expect(snapshot).toContain("detail=stash-snapshot-begin");
    expect(snapshot).toContain("manual\\ stash\\ before\\ preflight\\ test");
    expect(snapshot).toContain("detail=stash-snapshot-end");
  });
  it("auto-stashes dirty temp worktree and removes it before deleting merged branch", () => {
    const { repoDir, branchName } = setupMergedBranchRepo("repo-auto-sync-temp-worktree");
    const tempWorktree = path.join(
      os.tmpdir(),
      `repo-auto-sync-worktree-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );

    run(`git worktree add ${shQuote(tempWorktree)} ${shQuote(branchName)}`, repoDir);
    fs.writeFileSync(path.join(tempWorktree, "dirty-untracked.txt"), "dirty\n", "utf8");

    const result = runBranchCleanup(repoDir);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("detail=temp-worktree-stashed");
    expect(result.stderr).toContain("detail=temp-worktree-removed");
    expect(fs.existsSync(tempWorktree)).toBe(false);
    expect(hasLocalBranch(repoDir, branchName)).toBe(false);

    const stashList = run("git stash list", repoDir);
    expect(stashList).toContain(`repo-auto-sync auto-stash branch=${branchName} ts=`);
  });

  it("skips non-temp external worktree with warning and preserves branch", () => {
    const { repoDir, branchName } = setupMergedBranchRepo("repo-auto-sync-non-temp-worktree");
    const externalBase = fs.mkdtempSync(
      path.join(os.homedir(), ".repo-auto-sync-non-temp-"),
    );
    cleanupPaths.add(externalBase);

    const externalWorktree = path.join(externalBase, "worktree");
    run(`git worktree add ${shQuote(externalWorktree)} ${shQuote(branchName)}`, repoDir);
    fs.writeFileSync(path.join(externalWorktree, "dirty-untracked.txt"), "dirty\n", "utf8");

    const result = runBranchCleanup(repoDir);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("detail=non-temp-worktree-skip");
    expect(result.stderr).toContain("detail=delete-skipped-worktree-blocked");
    expect(fs.existsSync(externalWorktree)).toBe(true);
    expect(hasLocalBranch(repoDir, branchName)).toBe(true);
  });

  it("auto-restores runtime heartbeat-state dirt on main and stays quiet", () => {
    const { repoDir } = setupMergedBranchRepo("repo-auto-sync-volatile-runtime-state");
    const runtimeState = path.join(repoDir, "memory", "heartbeat-state.json");

    fs.mkdirSync(path.dirname(runtimeState), { recursive: true });
    fs.writeFileSync(runtimeState, '{"lastHeartbeat":1,"lastChecks":{"monitor":{"lastChecked":1}}}\n', "utf8");
    run("git add memory/heartbeat-state.json", repoDir);
    run("git commit -m 'track runtime state file for regression'", repoDir);
    run("git push origin main", repoDir);

    fs.writeFileSync(runtimeState, '{"lastHeartbeat":2,"lastChecks":{"monitor":{"lastChecked":2}}}\n', "utf8");

    const result = runRepoAutoSync(repoDir);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("NO_REPLY");
    expect(result.stderr).toContain("detail=volatile-runtime-state-restored");
    expect(run("git status --short", repoDir)).toBe("");
    expect(fs.readFileSync(runtimeState, "utf8")).toContain('"lastHeartbeat":1');
  });

  it("promotes tracked and untracked dream-memory dirt on main into a draft PR and returns to clean main", () => {
    const { repoDir, rootDir } = setupMergedBranchRepo("repo-auto-sync-promotable-memory");
    const rootDream = path.join(repoDir, "DREAMS.md");
    const identityDream = path.join(repoDir, "identities", "oracle", "DREAMS.md");
    const dreamState = path.join(repoDir, "memory", ".dreams", "short-term-recall.json");
    const dreamingDiary = path.join(repoDir, "memory", "dreaming", "rem", "2026-04-22.md");
    const { binDir, callsPath } = setupFakeGh(rootDir);

    fs.mkdirSync(path.dirname(rootDream), { recursive: true });
    fs.mkdirSync(path.dirname(identityDream), { recursive: true });
    fs.mkdirSync(path.dirname(dreamState), { recursive: true });
    fs.writeFileSync(rootDream, "# Seed dream diary\n", "utf8");
    fs.writeFileSync(identityDream, "# Oracle seed dream diary\n", "utf8");
    fs.writeFileSync(dreamState, '{"summary":"seed"}\n', "utf8");
    run("git add DREAMS.md identities/oracle/DREAMS.md memory/.dreams/short-term-recall.json", repoDir);
    run("git commit -m 'track dream memory files for regression'", repoDir);
    run("git push origin main", repoDir);

    fs.writeFileSync(rootDream, "# Updated dream diary\n", "utf8");
    fs.writeFileSync(identityDream, "# Oracle updated dream diary\n", "utf8");
    fs.writeFileSync(dreamState, '{"summary":"updated"}\n', "utf8");
    fs.mkdirSync(path.dirname(dreamingDiary), { recursive: true });
    fs.writeFileSync(dreamingDiary, "# REM dream\n", "utf8");

    const result = runRepoAutoSyncWithEnv(repoDir, {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("promotable-memory-pr-opened");
    expect(result.stdout).toContain("https://github.com/hd719/cortana/pull/4242");
    expect(result.stderr).toContain("detail=promotable-memory-pr-opened");
    expect(run("git branch --show-current", repoDir)).toBe("main");
    expect(run("git status --short", repoDir)).toBe("");
    expect(fs.readFileSync(callsPath, "utf8")).toContain("pr create --draft");

    const promotedBranch = result.stdout.match(/branch=(codex\/promote-[^ ]+)/)?.[1];
    expect(promotedBranch).toBeTruthy();
    expect(hasLocalBranch(repoDir, promotedBranch ?? "")).toBe(true);
    expect(run(`git show ${shQuote(promotedBranch ?? "")}:DREAMS.md`, repoDir)).toContain("Updated dream diary");
    expect(run(`git show ${shQuote(promotedBranch ?? "")}:identities/oracle/DREAMS.md`, repoDir)).toContain("updated dream diary");
    expect(run(`git show ${shQuote(promotedBranch ?? "")}:memory/dreaming/rem/2026-04-22.md`, repoDir)).toContain("REM dream");
  });

  it("resumes an existing promotable-memory branch instead of treating it as ordinary feature dirt", () => {
    const { repoDir, rootDir } = setupMergedBranchRepo("repo-auto-sync-promotable-memory-resume");
    const dreamState = path.join(repoDir, "memory", ".dreams", "short-term-recall.json");
    const { binDir, callsPath } = setupFakeGh(rootDir);
    const promotedBranch = "codex/promote-dream-memory-20260422-000000";

    fs.mkdirSync(path.dirname(dreamState), { recursive: true });
    fs.writeFileSync(dreamState, '{"summary":"seed"}\n', "utf8");
    run("git add memory/.dreams/short-term-recall.json", repoDir);
    run("git commit -m 'track dream memory file for resume regression'", repoDir);
    run("git push origin main", repoDir);

    fs.writeFileSync(dreamState, '{"summary":"updated"}\n', "utf8");
    run(`git checkout -b ${shQuote(promotedBranch)}`, repoDir);

    const result = runRepoAutoSyncWithEnv(repoDir, {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`branch=${promotedBranch}`);
    expect(result.stderr).toContain("detail=promotable-memory-branch-resume");
    expect(result.stderr).toContain("detail=promotable-memory-pr-opened");
    expect(run("git branch --show-current", repoDir)).toBe("main");
    expect(run("git status --short", repoDir)).toBe("");
    expect(fs.readFileSync(callsPath, "utf8")).toContain("pr create --draft");
    expect(hasLocalBranch(repoDir, promotedBranch)).toBe(true);
    expect(run(`git show ${shQuote(promotedBranch)}:memory/.dreams/short-term-recall.json`, repoDir)).toContain('"summary":"updated"');
  });
});
