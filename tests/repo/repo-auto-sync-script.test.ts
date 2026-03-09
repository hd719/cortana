import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("repo-auto-sync.sh hygiene policy", () => {
  const scriptPath = path.resolve("tools/repo/repo-auto-sync.sh");
  const script = fs.readFileSync(scriptPath, "utf8");

  it("fails fast on dirty/untracked state, but allows stash with snapshot logging", () => {
    expect(script).toContain("git -C \"$repo\" status --porcelain --untracked-files=all");
    expect(script).toContain("git -C \"$repo\" stash list");
    expect(script).toContain('fail "$repo" "preflight-clean"');
    expect(script).toContain("snapshot_existing_stash_metadata");
    expect(script).toContain("detail=stash-present-continue");
    expect(script).toContain("detail=stash-snapshot-written");
    expect(script).not.toContain('stash list not empty');
  });

  it("keeps safe order: preflight before branch-state/pull, cleanup after sync decision", () => {
    const syncRepoBody = script.match(/sync_repo\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const preflight = syncRepoBody.indexOf("ensure_clean_preflight");
    const branchState = syncRepoBody.indexOf("rev-list --left-right --count origin/main...HEAD");
    const pull = syncRepoBody.indexOf("pull --ff-only origin main");
    const cleanup = syncRepoBody.indexOf("cleanup_local_merged_branches");

    expect(syncRepoBody).toBeTruthy();
    expect(preflight).toBeGreaterThan(-1);
    expect(branchState).toBeGreaterThan(-1);
    expect(pull).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(branchState);
    expect(branchState).toBeLessThan(cleanup);
    expect(pull).toBeLessThan(cleanup);
  });

  it("sanitizes and validates branch candidates and skips protected branches", () => {
    expect(script).toContain("sanitize_branch_token");
    expect(script).toContain("s/^[*+[:space:]]+//");
    expect(script).toContain('PROTECTED_BRANCHES=("main" "master" "dev" "develop")');
    expect(script).toContain('check-ref-format --branch "$b"');
    expect(script).toContain('show-ref --verify --quiet "refs/heads/$b"');
  });

  it("automates temp worktree conflicts with stash+remove and skips non-temp worktrees", () => {
    expect(script).toContain("is_temp_worktree_path");
    expect(script).toContain("list_worktrees_for_branch");
    expect(script).toContain('stash push --include-untracked -m "$stash_message"');
    expect(script).toContain('detail=temp-worktree-stashed');
    expect(script).toContain('worktree remove -- "$worktree_path"');
    expect(script).toContain('detail=temp-worktree-removed');
    expect(script).toContain('detail=non-temp-worktree-skip');
    expect(script).toContain('detail=delete-skipped-worktree-blocked');
  });

  it("only deletes local branches merged into origin/main and never remote branches", () => {
    expect(script).toContain("for-each-ref --format='%(refname:short)' refs/heads --merged origin/main");
    expect(script).toContain('git -C "$repo" branch -d -- "$b"');
    expect(script).not.toContain("push --delete");
    expect(script).not.toContain("refs/remotes");
  });

  it("handles ahead/diverged main safely before attempting pull", () => {
    expect(script).toContain('rev-list --left-right --count origin/main...HEAD');
    expect(script).toContain('detail=local-main-ahead');
    expect(script).toContain('detail=skip-local-main-ahead');
    expect(script).toContain('main diverged from origin/main');
  });

  it("runs main flow only when executed directly", () => {
    expect(script).toContain('if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then');
    expect(script).toContain("main");
  });
});
