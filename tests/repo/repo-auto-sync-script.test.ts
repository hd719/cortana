import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("repo-auto-sync.sh hygiene policy", () => {
  const scriptPath = path.resolve("tools/repo/repo-auto-sync.sh");
  const script = fs.readFileSync(scriptPath, "utf8");

  it("fails fast on dirty/untracked state, but allows stash with snapshot logging", () => {
    expect(script).toContain("git -C \"$repo\" status --porcelain --untracked-files=all");
    expect(script).toContain("git -C \"$repo\" stash list");
    expect(script).toContain("snapshot_existing_stash_metadata");
    expect(script).toContain("detail=stash-present-continue");
    expect(script).toContain("detail=stash-snapshot-written");
    expect(script).not.toContain('stash list not empty');
  });

  it("keeps safe order: preflight before branch-state/pull, stale worktree cleanup before branch cleanup", () => {
    const syncRepoBody = script.match(/sync_repo\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const preflight = syncRepoBody.indexOf("ensure_clean_preflight");
    const branchState = syncRepoBody.indexOf("rev-list --left-right --count \"$main_remote_ref...HEAD\"");
    const staleTemp = syncRepoBody.indexOf("cleanup_stale_temp_worktrees");
    const pull = syncRepoBody.indexOf("pull --ff-only \"$pull_remote\" \"$pull_branch\"");
    const cleanup = syncRepoBody.indexOf("cleanup_local_merged_branches");

    expect(syncRepoBody).toBeTruthy();
    expect(preflight).toBeGreaterThan(-1);
    expect(branchState).toBeGreaterThan(-1);
    expect(staleTemp).toBeGreaterThan(-1);
    expect(pull).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(branchState);
    expect(staleTemp).toBeLessThan(cleanup);
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
    expect(script).toContain("cleanup_stale_temp_worktrees");
    expect(script).toContain('stash push --include-untracked -m "$stash_message"');
    expect(script).toContain('detail=temp-worktree-stashed');
    expect(script).toContain('worktree remove -- "$worktree_path"');
    expect(script).toContain('detail=temp-worktree-removed');
    expect(script).toContain('detail=non-temp-worktree-skip');
    expect(script).toContain('detail=delete-skipped-worktree-blocked');
  });

  it("only deletes local branches merged into the tracked main remote and never remote branches", () => {
    expect(script).toContain("resolve_main_remote_ref");
    expect(script).toContain("for-each-ref --format='%(refname:short)' refs/heads --merged \"$main_remote_ref\"");
    expect(script).toContain('git -C "$repo" branch -d -- "$b"');
    expect(script).not.toContain("push --delete");
    expect(script).not.toContain("refs/remotes --merged");
  });

  it("handles ahead/diverged main safely before attempting pull", () => {
    expect(script).toContain('rev-list --left-right --count "$main_remote_ref...HEAD"');
    expect(script).toContain('local-main-ahead');
    expect(script).toContain('diverged-main-manual-intervention-required');
    expect(script).toContain('queue_actionable_alert "$repo" "fetch" "git fetch --all --prune failed"');
    expect(script).toContain('queue_actionable_alert "$repo" "pull" "git pull --ff-only $pull_remote $pull_branch failed"');
  });

  it("suppresses volatile runtime-state false dirt and only re-alerts on changed actionable state", () => {
    expect(script).toContain('memory/calendar-reminders-sent.json');
    expect(script).toContain('memory/newsletter-alerted.json');
    expect(script).toContain('detail=volatile-runtime-state-restored');
    expect(script).toContain('PROMOTABLE_MEMORY_PREFIXES=(');
    expect(script).toContain('memory/.dreams/');
    expect(script).toContain('promotable-memory-pr-opened');
    expect(script).toContain('gh pr create --draft --base main --head "$branch"');
    expect(script).toContain('ALERT_STATE_FILE="${REPO_AUTO_SYNC_ALERT_STATE_FILE:-$HOME/.openclaw/tmp/repo-auto-sync-state.txt}"');
    expect(script).toContain("read_alert_fingerprint");
    expect(script).toContain("write_alert_fingerprint");
    expect(script).toContain("unchanged-actionable-state-suppressed");
    expect(script).toContain("render_output");
    expect(script).toContain("NO_REPLY");
  });

  it("runs main flow only when executed directly", () => {
    expect(script).toContain('if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then');
    expect(script).toContain("main");
  });
});
