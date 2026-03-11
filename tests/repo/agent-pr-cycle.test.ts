import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

const SCRIPT = "/Users/hd/openclaw/tools/repo/agent-pr-cycle.sh";

function run(cmd: string, cwd: string, env?: NodeJS.ProcessEnv) {
  const result = spawnSync("bash", ["-lc", cmd], { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`command failed (${result.status}): ${cmd}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return result.stdout.trim();
}

function setupRepo(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  fs.mkdirSync(origin, { recursive: true });
  run(`git init --bare ${JSON.stringify(origin)}`, root);
  run(`git clone ${JSON.stringify(origin)} ${JSON.stringify(repo)}`, root);
  run(`git config user.name 'Test User'`, repo);
  run(`git config user.email 'test@example.com'`, repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n", "utf8");
  run("git add README.md", repo);
  run("git commit -m 'initial'", repo);
  run("git branch -M main", repo);
  run("git push -u origin main", repo);
  run("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", repo);
  return { root, origin, repo };
}

function setupFakeGh(root: string, behavior: "create-success" | "create-fails-no-pr" | "existing-pr") {
  const bin = path.join(root, "bin");
  const calls = path.join(root, "gh-calls.log");
  fs.mkdirSync(bin, { recursive: true });
  const script = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(calls)}
if [[ "$1 $2" == "repo view" ]]; then
  echo hd719/cortana
  exit 0
fi
if [[ "$1 $2" == "pr create" ]]; then
  case ${JSON.stringify(behavior)} in
    create-success)
      echo https://github.com/hd719/cortana/pull/999
      exit 0
      ;;
    existing-pr)
      echo "a pull request for branch already exists" >&2
      exit 1
      ;;
    create-fails-no-pr)
      echo "boom" >&2
      exit 1
      ;;
  esac
fi
if [[ "$1 $2" == "pr list" ]]; then
  case ${JSON.stringify(behavior)} in
    existing-pr)
      echo '[{"url":"https://github.com/hd719/cortana/pull/123"}]'
      ;;
    *)
      echo '[]'
      ;;
  esac
  exit 0
fi
exit 0
`;
  const ghPath = path.join(bin, "gh");
  fs.writeFileSync(ghPath, script, { mode: 0o755 });
  return { bin, calls };
}

function runCycle(repo: string, bin: string, extraArgs: string[]) {
  return spawnSync("bash", [SCRIPT, "--repo", repo, ...extraArgs], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}

afterEach(() => {
  // temp dirs are fine to leak briefly in CI if cleanup races; OS will reap.
});

describe("agent-pr-cycle", () => {
  it("returns explicit no_pr_needed when task makes no changes", () => {
    const { root, repo } = setupRepo("agent-pr-cycle-no-changes");
    const { bin, calls } = setupFakeGh(root, "create-success");

    const result = runCycle(repo, bin, ["--task-cmd", "true"]);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
    expect(payload.result).toBe("no_pr_needed");
    expect(payload.branch).toMatch(/^agent\//);
    expect(payload.reason).toBe("no_changes_detected");
    expect(fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "").not.toContain("pr create");
  });

  it("opens a PR and returns pr_opened when changes exist", () => {
    const { root, repo } = setupRepo("agent-pr-cycle-pr-opened");
    const { bin } = setupFakeGh(root, "create-success");

    const result = runCycle(repo, bin, [
      "--task-cmd",
      "printf 'change\n' >> README.md",
      "--commit-msg",
      "test: update readme",
      "--pr-title",
      "Test PR",
      "--pr-body",
      "Body",
    ]);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
    expect(payload.result).toBe("pr_opened");
    expect(payload.pr_url).toBe("https://github.com/hd719/cortana/pull/999");
    expect(payload.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("fails loudly with branch_exists_no_pr when branch work exists but no PR is created", () => {
    const { root, repo } = setupRepo("agent-pr-cycle-missing-pr");
    const { bin } = setupFakeGh(root, "create-fails-no-pr");

    const result = runCycle(repo, bin, [
      "--task-cmd",
      "printf 'change\n' >> README.md",
      "--commit-msg",
      "test: update readme",
      "--pr-title",
      "Test PR",
      "--pr-body",
      "Body",
    ]);

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
    expect(payload.result).toBe("blocked");
    expect(payload.reason).toBe("branch_exists_no_pr");
    expect(payload.branch).toMatch(/^agent\//);
    expect(payload.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(payload.pr_url).toBeNull();
    expect(String(payload.detail)).toContain("No pull request was created");
  });
});
