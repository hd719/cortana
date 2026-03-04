#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

type FailedAgent = { reasonCode?: string; status?: string };
type WatchdogPayload = {
  ok?: boolean;
  summary?: { failedOrTimedOut?: number };
  failedAgents?: FailedAgent[];
};

type TimeoutProfiles = Record<string, number>;

type RetryMetrics = {
  reasonCounts: Record<string, number>;
  retryCount: number;
  successAfterRetry: boolean;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const WATCHDOG_TS = path.join(ROOT, "tools", "subagent-watchdog", "check-subagents.ts");
const RETRY_BASE_MS = Number(process.env.SUBAGENT_RETRY_BASE_MS ?? "1200");
const RETRY_JITTER_MS = Number(process.env.SUBAGENT_RETRY_JITTER_MS ?? "700");
const DEFAULT_PROFILES: TimeoutProfiles = {
  standard: 600,
  heavy: 420,
  extreme: 900,
};

function parseArgs(argv: string[]) {
  const passthrough: string[] = [];
  let timeoutProfile = process.env.SUBAGENT_TIMEOUT_PROFILE ?? "standard";
  let taskType = process.env.SUBAGENT_TASK_TYPE ?? "";

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--timeout-profile") {
      timeoutProfile = argv[i + 1] ?? timeoutProfile;
      i += 1;
      continue;
    }
    if (a === "--task-type") {
      taskType = argv[i + 1] ?? taskType;
      i += 1;
      continue;
    }
    passthrough.push(a);
  }

  return { passthrough, timeoutProfile, taskType };
}

function parseTaskProfileMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([k, v]) => typeof k === "string" && typeof v === "string")
        .map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()])
    );
  } catch {
    return {};
  }
}

function resolveProfiles(): TimeoutProfiles {
  const merged = { ...DEFAULT_PROFILES };
  const raw = process.env.SUBAGENT_TIMEOUT_PROFILES_JSON;
  if (!raw) return merged;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return merged;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) merged[k.toLowerCase()] = Math.trunc(n);
    }
  } catch {
    // ignore malformed env override
  }
  return merged;
}

function resolveMaxRuntime(profile: string, taskType: string, profiles: TimeoutProfiles): number {
  const taskMap = parseTaskProfileMap(process.env.SUBAGENT_TASK_TIMEOUT_PROFILE_MAP);
  const mapped = taskMap[taskType.toLowerCase()];
  const effectiveProfile = (mapped || profile || "standard").toLowerCase();
  return profiles[effectiveProfile] ?? profiles.standard;
}

function sleepMs(ms: number) {
  const sec = Math.max(0, ms / 1000);
  spawnSync("sleep", [String(sec)], { stdio: "ignore" });
}

function preflightFailures(): string[] {
  const failures: string[] = [];
  if (!fs.existsSync(WATCHDOG_TS)) failures.push(`watchdog script missing: ${WATCHDOG_TS}`);

  const npx = spawnSync("/usr/bin/env", ["bash", "-lc", "command -v npx"], { encoding: "utf8" });
  if (npx.status !== 0 || !(npx.stdout ?? "").trim()) failures.push("dependency missing: npx not found on PATH");

  const gitTop = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: ROOT, encoding: "utf8" });
  if (gitTop.status !== 0) failures.push("repo preflight failed: not inside a git repository");

  const upstream = spawnSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (upstream.status !== 0) failures.push("repo preflight failed: upstream branch not configured");

  return failures;
}

function runWatchdog(args: string[], maxRuntimeSeconds?: number) {
  const cmd = ["--yes", "tsx", WATCHDOG_TS, ...args];
  if (typeof maxRuntimeSeconds === "number" && Number.isFinite(maxRuntimeSeconds)) {
    cmd.push("--max-runtime-seconds", String(maxRuntimeSeconds));
  }
  return spawnSync("npx", cmd, { cwd: ROOT, encoding: "utf8" });
}

function parsePayload(stdout: string): WatchdogPayload | null {
  const trimmed = (stdout ?? "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as WatchdogPayload;
  } catch {
    return null;
  }
}

function reasonCounts(payload: WatchdogPayload | null): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of payload?.failedAgents ?? []) {
    const reason = String(item.reasonCode ?? "unknown");
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

function isTimeoutRetryable(item: FailedAgent): boolean {
  const reason = String(item.reasonCode ?? "").toLowerCase();
  const status = String(item.status ?? "").toLowerCase();
  if (reason === "runtime_exceeded") return true;
  return reason === "failed_status" && (status === "timeout" || status === "timed_out");
}

function shouldRetry(payload: WatchdogPayload | null): boolean {
  if (!payload) return false;
  const failures = payload.failedAgents ?? [];
  if (!failures.length) return false;
  return failures.every(isTimeoutRetryable);
}

function main() {
  const { passthrough, timeoutProfile, taskType } = parseArgs(process.argv.slice(2));
  const preflight = preflightFailures();
  if (preflight.length) {
    console.log(
      JSON.stringify({ ok: false, failFast: true, failures: preflight, metrics: { reasonCounts: {}, retryCount: 0, successAfterRetry: false } }, null, 2)
    );
    return process.exit(1);
  }

  const first = runWatchdog(passthrough);
  const firstPayload = parsePayload(first.stdout ?? "");
  const metrics: RetryMetrics = {
    reasonCounts: reasonCounts(firstPayload),
    retryCount: 0,
    successAfterRetry: false,
  };

  if (!shouldRetry(firstPayload)) {
    if (first.stdout) process.stdout.write(first.stdout);
    if (first.stderr) process.stderr.write(first.stderr);
    return process.exit(first.status ?? 1);
  }

  metrics.retryCount = 1;
  const profiles = resolveProfiles();
  const maxRuntimeSeconds = resolveMaxRuntime(timeoutProfile, taskType, profiles);
  const backoff = RETRY_BASE_MS + Math.floor(Math.random() * Math.max(1, RETRY_JITTER_MS));
  sleepMs(backoff);

  const second = runWatchdog(passthrough, maxRuntimeSeconds);
  const secondPayload = parsePayload(second.stdout ?? "");
  metrics.successAfterRetry = Boolean((second.status ?? 1) === 0 && (secondPayload?.summary?.failedOrTimedOut ?? 0) === 0);

  const finalPayload = {
    ...(secondPayload ?? {}),
    reliability: {
      timeoutProfile: timeoutProfile,
      taskType: taskType || null,
      maxRuntimeSeconds,
      backoffMs: backoff,
      metrics,
    },
  };

  console.log(JSON.stringify(finalPayload, null, 2));
  if (second.stderr) process.stderr.write(second.stderr);
  process.exit(second.status ?? 1);
}

main();
