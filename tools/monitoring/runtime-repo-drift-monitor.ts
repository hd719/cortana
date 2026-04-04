#!/usr/bin/env -S npx tsx
import fs from "node:fs";
import { execSync } from "node:child_process";

type Args = {
  dryRun: boolean;
  json: boolean;
  sourceRepo: string;
  runtimeRepo: string;
  sourceBranch: string;
  runtimeBranch: string;
};

type Check = {
  label: string;
  repo: string;
};

type DriftAssessment = {
  check: Check;
  actionable: boolean;
  reason: string;
  details?: Record<string, string>;
};

type RepoState = {
  repo: string;
  branch: string;
  upstream: string;
  head: string;
  originHead: string;
  remoteUrl: string;
  clean: boolean;
  changedPaths: string[];
};

const FALLBACK_SOURCE_REPO = "/Users/hd/Developer/cortana";
const DEFAULT_DEPLOY_REPO = process.env.CORTANA_DEPLOY_REPO || "/Users/hd/Developer/cortana-deploy";
const IGNORED_RUNTIME_STATE_PATHS = new Set([
  "memory/apple-reminders-sent.json",
  "var/backtests/rechecks/state.json",
]);

function resolveDefaultSourceRepo(): string {
  if (repoExists(DEFAULT_DEPLOY_REPO)) return DEFAULT_DEPLOY_REPO;
  return process.env.CORTANA_SOURCE_REPO || FALLBACK_SOURCE_REPO;
}

function resolveDefaultRuntimeRepo(sourceRepo: string): string {
  const configured = process.env.CORTANA_RUNTIME_REPO;
  if (configured) return configured;
  const compatRepo = "/Users/hd/openclaw";
  if (repoExists(compatRepo) || pathExists(compatRepo)) return compatRepo;
  return sourceRepo;
}

const DEFAULT_SOURCE_REPO = resolveDefaultSourceRepo();
const DEFAULT_RUNTIME_REPO = resolveDefaultRuntimeRepo(DEFAULT_SOURCE_REPO);

function parseArgs(): Args {
  const argv = process.argv.slice(2);

  let dryRun = false;
  let json = false;
  let sourceRepo = DEFAULT_SOURCE_REPO;
  let runtimeRepo = DEFAULT_RUNTIME_REPO;
  let sourceBranch = "main";
  let runtimeBranch = "main";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--json") json = true;
    else if ((arg === "--source-repo" || arg === "--repo-root") && argv[i + 1]) sourceRepo = argv[++i];
    else if (arg === "--runtime-repo" && argv[i + 1]) runtimeRepo = argv[++i];
    else if (arg === "--source-branch" && argv[i + 1]) sourceBranch = argv[++i];
    else if (arg === "--runtime-branch" && argv[i + 1]) runtimeBranch = argv[++i];
    else if (arg === "--auto-pr" || arg === "--base" || arg === "--branch-prefix") {
      if (argv[i + 1] && arg !== "--auto-pr" && !argv[i + 1].startsWith("--")) i += 1;
    }
  }

  return { dryRun, json, sourceRepo, runtimeRepo, sourceBranch, runtimeBranch };
}

function run(cmd: string, cwd: string): string {
  return execSync(cmd, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

function repoExists(repo: string): boolean {
  return fs.existsSync(`${repo}/.git`);
}

function pathExists(repo: string): boolean {
  return fs.existsSync(repo);
}

function realpath(repo: string): string {
  return fs.realpathSync.native?.(repo) ?? fs.realpathSync(repo);
}

function normalizeStatusPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return "";
  const renameMarker = " -> ";
  if (trimmed.includes(renameMarker)) {
    return trimmed.split(renameMarker).at(-1)?.trim() ?? trimmed;
  }
  return trimmed;
}

function collectChangedPaths(repo: string): string[] {
  const raw = run("git status --porcelain --untracked-files=all", repo);
  return raw
    .split("\n")
    .map((line) => normalizeStatusPath(line.slice(3)))
    .filter(Boolean);
}

function isMeaningfulDriftPath(repoPath: string): boolean {
  return !IGNORED_RUNTIME_STATE_PATHS.has(repoPath);
}

function isShimmedRuntime(sourceRepo: string, runtimeRepo: string): boolean {
  if (!pathExists(sourceRepo) || !pathExists(runtimeRepo)) return false;
  try {
    return realpath(sourceRepo) === realpath(runtimeRepo);
  } catch {
    return false;
  }
}

function collectRepoState(repo: string, branch: string): RepoState {
  run(`git fetch origin ${branch} --prune --quiet`, repo);
  const changedPaths = collectChangedPaths(repo);
  return {
    repo,
    branch: run("git rev-parse --abbrev-ref HEAD", repo),
    upstream: run("git rev-parse --abbrev-ref --symbolic-full-name @{u}", repo),
    head: run("git rev-parse HEAD", repo),
    originHead: run(`git rev-parse origin/${branch}`, repo),
    remoteUrl: run("git remote get-url origin", repo),
    clean: changedPaths.every((repoPath) => !isMeaningfulDriftPath(repoPath)),
    changedPaths,
  };
}

function assessSource(state: RepoState, expectedBranch: string): DriftAssessment[] {
  const check: Check = { label: "source-repo", repo: state.repo };
  const findings: DriftAssessment[] = [];

  if (state.branch !== expectedBranch) {
    findings.push({
      check,
      actionable: true,
      reason: "source repo is not on the deploy branch",
      details: { expected: expectedBranch, actual: state.branch },
    });
  }

  if (state.upstream !== `origin/${expectedBranch}`) {
    findings.push({
      check,
      actionable: true,
      reason: "source repo is not tracking origin/main",
      details: { expected: `origin/${expectedBranch}`, actual: state.upstream },
    });
  }

  if (!state.clean) {
    findings.push({
      check,
      actionable: true,
      reason: "source repo has local changes",
    });
  }

  if (state.head !== state.originHead) {
    findings.push({
      check,
      actionable: true,
      reason: "source repo is not synced with origin/main",
      details: { head: state.head, originHead: state.originHead },
    });
  }

  return findings;
}

function assessRuntime(state: RepoState, source: RepoState, expectedBranch: string): DriftAssessment[] {
  const check: Check = { label: "runtime-repo", repo: state.repo };
  const findings: DriftAssessment[] = [];

  if (state.remoteUrl !== source.remoteUrl) {
    findings.push({
      check,
      actionable: true,
      reason: "runtime repo remote does not match source repo remote",
      details: { sourceRemote: source.remoteUrl, runtimeRemote: state.remoteUrl },
    });
  }

  if (state.branch !== expectedBranch) {
    findings.push({
      check,
      actionable: true,
      reason: "runtime repo is not on main",
      details: { expected: expectedBranch, actual: state.branch },
    });
  }

  if (state.upstream !== `origin/${expectedBranch}`) {
    findings.push({
      check,
      actionable: true,
      reason: "runtime repo is not tracking origin/main",
      details: { expected: `origin/${expectedBranch}`, actual: state.upstream },
    });
  }

  if (!state.clean) {
    findings.push({
      check,
      actionable: true,
      reason: "runtime repo has local changes",
    });
  }

  if (state.head !== source.head) {
    let fastForwardable = false;
    try {
      run(`git merge-base --is-ancestor ${state.head} ${source.head}`, state.repo);
      fastForwardable = true;
    } catch {
      fastForwardable = false;
    }

    findings.push({
      check,
      actionable: true,
      reason: fastForwardable
        ? "runtime repo is behind the source deploy commit"
        : "runtime repo diverged from the source deploy commit",
      details: { runtimeHead: state.head, sourceHead: source.head },
    });
  }

  return findings;
}

function main(): void {
  const args = parseArgs();
  void args.dryRun;

  const missing: DriftAssessment[] = [];
  if (!repoExists(args.sourceRepo)) {
    missing.push({
      check: { label: "source-repo", repo: args.sourceRepo },
      actionable: false,
      reason: "missing repo",
    });
  }
  if (!repoExists(args.runtimeRepo)) {
    missing.push({
      check: { label: "runtime-repo", repo: args.runtimeRepo },
      actionable: false,
      reason: "missing repo",
    });
  }

  if (missing.length) {
    const payload = { status: "needs_action", actionable: [], suppressed: [], missing };
    if (args.json) {
      console.log(JSON.stringify(payload));
      return;
    }
    console.log(["🧭 Runtime Deploy Drift", ...missing.map((item) => `- ${item.check.label}: ${item.reason}`)].join("\n"));
    return;
  }

  const sourceState = collectRepoState(args.sourceRepo, args.sourceBranch);
  if (isShimmedRuntime(args.sourceRepo, args.runtimeRepo)) {
    const actionable = assessSource(sourceState, args.sourceBranch);
    const payload = {
      status: actionable.length ? "needs_action" : "healthy",
      sourceRepo: args.sourceRepo,
      runtimeRepo: args.runtimeRepo,
      sourceOfTruth: args.sourceRepo === DEFAULT_DEPLOY_REPO ? "deploy-worktree" : "primary-worktree",
      actionable,
      suppressed: [
        {
          check: { label: "runtime-repo", repo: args.runtimeRepo },
          actionable: false,
          reason: "runtime path is a compatibility shim to the source repo",
        },
      ],
      missing: [],
    };

    if (args.json) {
      console.log(JSON.stringify(payload));
      return;
    }

    if (!actionable.length) {
      console.log("NO_REPLY");
      return;
    }

    const lines = ["🧭 Runtime Deploy Drift"];
    for (const item of actionable) {
      lines.push(`- ${item.check.label}: ${item.reason}`);
    }
    lines.push(`- runtime-repo: compatibility shim target=${args.runtimeRepo}`);
    console.log(lines.join("\n"));
    return;
  }

  const runtimeState = collectRepoState(args.runtimeRepo, args.runtimeBranch);
  const actionable = [
    ...assessSource(sourceState, args.sourceBranch),
    ...assessRuntime(runtimeState, sourceState, args.runtimeBranch),
  ];

  const payload = {
    status: actionable.length ? "needs_action" : "healthy",
    sourceRepo: args.sourceRepo,
    runtimeRepo: args.runtimeRepo,
    sourceOfTruth: args.sourceRepo === DEFAULT_DEPLOY_REPO ? "deploy-worktree" : "primary-worktree",
    actionable,
    suppressed: [],
    missing: [],
  };

  if (args.json) {
    console.log(JSON.stringify(payload));
    return;
  }

  if (!actionable.length) {
    console.log("NO_REPLY");
    return;
  }

  const lines = ["🧭 Runtime Deploy Drift"];
  for (const item of actionable) {
    lines.push(`- ${item.check.label}: ${item.reason}`);
  }
  console.log(lines.join("\n"));
}

main();
