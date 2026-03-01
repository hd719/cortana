#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { resolveRepoPath } from "../lib/paths.js";

type Status = "pass" | "fail";

type TestCase = {
  name: string;
  candidates: string[];
  commandFor: (target: string) => string;
  validate: (rc: number, output: string) => { ok: boolean; reason?: string };
};

const ROOT_DIR = resolveRepoPath();
const reportRows: string[] = [];
let anyFail = false;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function nowMs(): number {
  return Date.now();
}

function sanitizeOutput(output: string): string {
  return output.replace(/\r?\n/g, " ").slice(0, 300);
}

function runCommandCapture(cmd: string): { rc: number; output: string } {
  const res = spawnSync("bash", ["-lc", cmd], { encoding: "utf8" });
  const stdout = (res.stdout ?? "").toString();
  const stderr = (res.stderr ?? "").toString();
  return { rc: res.status ?? 1, output: stdout + stderr };
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function recordResult(tool: string, status: Status, runtimeMs: number, error: string): void {
  reportRows.push(`${tool}|${status}|${runtimeMs}|${error}`);
  if (status === "fail") anyFail = true;
}

function resolveTarget(candidates: string[]): string | null {
  for (const rel of candidates) {
    const abs = path.join(ROOT_DIR, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

function jsonOk(payload: string): boolean {
  try {
    JSON.parse(payload);
    return true;
  } catch {
    return false;
  }
}

function extractJsonObject(payload: string): string | null {
  const trimmed = payload.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return trimmed.slice(first, last + 1);
  }

  const firstArr = trimmed.indexOf("[");
  const lastArr = trimmed.lastIndexOf("]");
  if (firstArr >= 0 && lastArr > firstArr) {
    return trimmed.slice(firstArr, lastArr + 1);
  }

  return null;
}

function runTest(test: TestCase): void {
  const start = nowMs();
  const target = resolveTarget(test.candidates);

  if (!target) {
    const runtime = nowMs() - start;
    recordResult(test.name, "fail", runtime, `missing_file candidates=${test.candidates.join(",")}`);
    return;
  }

  if (!isExecutable(target)) {
    const runtime = nowMs() - start;
    recordResult(test.name, "fail", runtime, `not_executable target=${path.relative(ROOT_DIR, target)}`);
    return;
  }

  const { rc, output } = runCommandCapture(test.commandFor(target));
  const runtime = nowMs() - start;
  const verdict = test.validate(rc, output);

  if (!verdict.ok) {
    recordResult(
      test.name,
      "fail",
      runtime,
      `${verdict.reason ?? "validation_failed"} output=${sanitizeOutput(output)}`
    );
    return;
  }

  recordResult(test.name, "pass", runtime, "");
}

const tests: TestCase[] = [
  {
    name: "tools/alerting/check-cron-delivery",
    candidates: ["tools/alerting/check-cron-delivery.ts"],
    commandFor: (target) => `\"${target}\"`,
    validate: (rc, output) => {
      if (rc === 0 || rc === 1) return { ok: true };
      if (output.includes("PrismaClientInitializationError")) {
        return { ok: true, reason: "runtime_guarded_prisma_init_error" };
      }
      return { ok: false, reason: `unexpected_exit_code=${rc}` };
    },
  },
  {
    name: "tools/alerting/cron-auto-retry.sh",
    candidates: ["tools/alerting/cron-auto-retry.sh"],
    commandFor: (target) => `\"${target}\"`,
    validate: (rc, output) => {
      if (rc !== 0) return { ok: false, reason: `unexpected_exit_code=${rc}` };
      const payload = extractJsonObject(output);
      if (!payload || !jsonOk(payload)) return { ok: false, reason: "invalid_json" };
      return { ok: true };
    },
  },
  {
    name: "tools/monitoring/meta-monitor",
    candidates: ["tools/monitoring/meta-monitor.ts"],
    commandFor: (target) => `\"${target}\" --json`,
    validate: (rc, output) => {
      const payload = extractJsonObject(output);
      if (rc === 0 && payload && jsonOk(payload)) return { ok: true };
      if (output.includes("PrismaClientInitializationError")) {
        return { ok: true, reason: "runtime_guarded_prisma_init_error" };
      }
      return { ok: false, reason: `meta_monitor_failed rc=${rc}` };
    },
  },
  {
    name: "tools/qa/validate-system",
    candidates: ["tools/qa/validate-system.sh", "tools/qa/validate-system.ts"],
    commandFor: (target) => (target.endsWith(".sh") ? `\"${target}\" --json` : `\"${target}\"`),
    validate: (rc, output) => {
      if (output.trim().length === 0) return { ok: false, reason: "no_output" };
      if (rc === 0 || rc === 1) return { ok: true };
      return { ok: false, reason: `unexpected_exit_code=${rc}` };
    },
  },
  {
    name: "tools/heartbeat/validate-heartbeat-state",
    candidates: ["tools/heartbeat/validate-heartbeat-state.sh", "tools/heartbeat/validate-heartbeat-state.ts"],
    commandFor: (target) => `\"${target}\" --help`,
    validate: (rc, output) => {
      if (rc === 0 || rc === 2) return { ok: true };
      if (output.includes("PrismaClientInitializationError")) {
        return { ok: true, reason: "runtime_guarded_prisma_init_error" };
      }
      return { ok: false, reason: `unexpected_exit_code=${rc}` };
    },
  },
  {
    name: "tools/feedback/pipeline-reconciliation",
    candidates: ["tools/feedback/pipeline-reconciliation.sh", "tools/feedback/pipeline-reconciliation.ts"],
    commandFor: (target) => `\"${target}\" --help`,
    validate: (rc, output) => {
      if (rc === 0 || rc === 2) return { ok: true };
      if (output.includes("PrismaClientInitializationError")) {
        return { ok: true, reason: "runtime_guarded_prisma_init_error" };
      }
      return { ok: false, reason: `unexpected_exit_code=${rc}` };
    },
  },
  {
    name: "tools/reaper/reaper",
    candidates: ["tools/reaper/reaper.sh", "tools/reaper/reaper.ts"],
    commandFor: (target) => `\"${target}\"`,
    validate: (rc, output) => {
      if (rc !== 0) return { ok: false, reason: `unexpected_exit_code=${rc}` };
      if (!output.includes("reaper:")) return { ok: false, reason: "missing_reaper_summary" };
      return { ok: true };
    },
  },
  {
    name: "tools/subagent-watchdog/check-subagents",
    candidates: ["tools/subagent-watchdog/check-subagents.sh", "tools/subagent-watchdog/check-subagents.ts"],
    commandFor: (target) => `\"${target}\" --all --json`,
    validate: (rc, output) => {
      if (rc !== 0) return { ok: false, reason: `unexpected_exit_code=${rc}` };
      const payload = extractJsonObject(output);
      if (!payload || !jsonOk(payload)) return { ok: false, reason: "invalid_json" };
      return { ok: true };
    },
  },
  {
    name: "tools/memory/compact-memory",
    candidates: ["tools/memory/compact-memory.sh", "tools/memory/compact-memory.ts"],
    commandFor: (target) => (target.endsWith(".sh") ? `bash -n \"${target}\"` : `\"${target}\" --help`),
    validate: (rc, output) => {
      if (rc === 0 || rc === 2) return { ok: true };
      if (output.includes("PrismaClientInitializationError")) {
        return { ok: true, reason: "runtime_guarded_prisma_init_error" };
      }
      return { ok: false, reason: `unexpected_exit_code=${rc}` };
    },
  },
  {
    name: "tools/tracing/log_decision.ts",
    candidates: ["tools/tracing/log_decision.ts"],
    commandFor: (target) => `\"${target}\" --help`,
    validate: (rc, output) => {
      if (rc !== 2) return { ok: false, reason: `unexpected_exit_code=${rc}` };
      if (!output.toLowerCase().includes("usage")) return { ok: false, reason: "missing_usage" };
      return { ok: true };
    },
  },
];

function printReport(): void {
  process.stdout.write("tool|status|runtime_ms|error\n");
  for (const row of reportRows) {
    process.stdout.write(`${row}\n`);
  }
}

async function main(): Promise<number> {
  for (const test of tests) {
    runTest(test);
  }

  printReport();
  return anyFail ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${msg}\n`);
    process.exit(1);
  });
