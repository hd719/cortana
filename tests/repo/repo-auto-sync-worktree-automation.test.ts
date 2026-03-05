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
    const externalBase = path.resolve(
      ".tmp-repo-auto-sync-tests",
      `non-temp-worktree-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    cleanupPaths.add(externalBase);
    fs.mkdirSync(externalBase, { recursive: true });

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
});
