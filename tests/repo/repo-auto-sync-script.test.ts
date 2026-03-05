import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("repo-auto-sync.sh hygiene policy", () => {
  const scriptPath = path.resolve("tools/repo/repo-auto-sync.sh");
  const script = fs.readFileSync(scriptPath, "utf8");

  it("fails fast on dirty/untracked/stash-present state", () => {
    expect(script).toContain("git -C \"$repo\" status --porcelain --untracked-files=all");
    expect(script).toContain("git -C \"$repo\" stash list");
    expect(script).toContain('fail "$repo" "preflight-clean"');
    expect(script).toContain('fail "$repo" "preflight-stash"');
  });

  it("keeps safe order: preflight before pull, cleanup after pull", () => {
    const syncRepoBody = script.match(/sync_repo\(\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const preflight = syncRepoBody.indexOf("ensure_clean_preflight");
    const pull = syncRepoBody.indexOf("pull --ff-only origin main");
    const cleanup = syncRepoBody.indexOf("cleanup_local_merged_branches");

    expect(syncRepoBody).toBeTruthy();
    expect(preflight).toBeGreaterThan(-1);
    expect(pull).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(pull);
    expect(pull).toBeLessThan(cleanup);
  });

  it("only deletes local branches merged into origin/main and never remote branches", () => {
    expect(script).toContain("for-each-ref --format='%(refname:short)' refs/heads --merged origin/main");
    expect(script).toContain('git -C "$repo" branch -d -- "$b"');
    expect(script).not.toContain("push --delete");
    expect(script).not.toContain("refs/remotes");
  });
});
