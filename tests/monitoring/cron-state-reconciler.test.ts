import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyCronJobs,
  loadCronEvidence,
  scheduleIntervalMs,
} from "../../tools/monitoring/cron-state-evidence.ts";
import { repairRuntimeCronState } from "../../tools/monitoring/cron-state-reconciler.ts";

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendJsonl(filePath: string, entries: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function fixtureRoot(): { root: string; repoRoot: string; runtimeHome: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cron-reconciler-"));
  return {
    root,
    repoRoot: path.join(root, "repo"),
    runtimeHome: path.join(root, "home"),
  };
}

function writeCronFixture(repoRoot: string, runtimeHome: string, job: any, state: any): void {
  writeJson(path.join(repoRoot, "config", "cron", "jobs.json"), {
    version: 1,
    jobs: [job],
  });
  writeJson(path.join(runtimeHome, ".openclaw", "cron", "jobs.json"), {
    version: 1,
    jobs: [job],
  });
  writeJson(path.join(runtimeHome, ".openclaw", "cron", "jobs-state.json"), {
    version: 1,
    jobs: {
      [job.id]: {
        state,
      },
    },
  });
}

describe("cron-state-reconciler", () => {
  it("classifies stale error state when a newer fresh success exists", () => {
    const { repoRoot, runtimeHome } = fixtureRoot();
    const nowMs = Date.parse("2026-05-05T12:00:00.000Z");
    const job = {
      id: "memory",
      name: "Memory Materializer",
      enabled: true,
      schedule: { kind: "cron", expr: "*/30 * * * *", tz: "America/New_York" },
      payload: { kind: "agentTurn", message: "run" },
    };
    writeCronFixture(repoRoot, runtimeHome, job, {
      lastRunAtMs: Date.parse("2026-05-05T10:00:00.000Z"),
      lastStatus: "error",
      lastRunStatus: "error",
      consecutiveErrors: 2,
    });
    appendJsonl(path.join(runtimeHome, ".openclaw", "cron", "runs", "memory.jsonl"), [
      {
        action: "finished",
        status: "error",
        runAtMs: Date.parse("2026-05-05T10:00:00.000Z"),
      },
      {
        action: "finished",
        status: "ok",
        runAtMs: Date.parse("2026-05-05T11:30:00.000Z"),
      },
    ]);

    const evidence = loadCronEvidence({ repoRoot, runtimeHome });
    const [classified] = classifyCronJobs(evidence, { nowMs });

    expect(classified.classification).toBe("stale_error_state");
    expect(classified.evidence).toBe("latest_success_after_error");
    expect(classified.repairable).toBe(true);
    expect(classified.stateSource).toBe("jobs-state");
  });

  it("classifies fresh errors as active failures", () => {
    const { repoRoot, runtimeHome } = fixtureRoot();
    const nowMs = Date.parse("2026-05-05T12:00:00.000Z");
    const job = {
      id: "brief",
      name: "Morning Brief",
      enabled: true,
      schedule: { kind: "cron", expr: "30 7 * * *", tz: "America/New_York" },
      payload: { kind: "agentTurn", message: "run" },
    };
    writeCronFixture(repoRoot, runtimeHome, job, {
      lastRunAtMs: Date.parse("2026-05-05T11:45:00.000Z"),
      lastStatus: "error",
      lastRunStatus: "error",
      consecutiveErrors: 1,
    });
    appendJsonl(path.join(runtimeHome, ".openclaw", "cron", "runs", "brief.jsonl"), [
      {
        action: "finished",
        status: "error",
        runAtMs: Date.parse("2026-05-05T11:45:00.000Z"),
      },
    ]);

    const [classified] = classifyCronJobs(loadCronEvidence({ repoRoot, runtimeHome }), { nowMs });

    expect(classified.classification).toBe("active_failure");
    expect(classified.severity).toBe("critical");
    expect(classified.repairable).toBe(false);
  });

  it("repairs only stale status metadata in jobs-state and verifies reload", () => {
    const { repoRoot, runtimeHome } = fixtureRoot();
    const statePath = path.join(runtimeHome, ".openclaw", "cron", "jobs-state.json");
    const job = {
      id: "health",
      name: "Health Check",
      enabled: true,
      schedule: { kind: "cron", expr: "*/15 * * * *", tz: "America/New_York" },
      payload: { kind: "agentTurn", message: "run" },
    };
    writeCronFixture(repoRoot, runtimeHome, job, {
      lastRunAtMs: 1000,
      lastStatus: "error",
      lastRunStatus: "error",
      consecutiveErrors: 3,
      runningAtMs: 900,
      nextRunAtMs: 2000,
    });

    const result = repairRuntimeCronState({
      statePath,
      stateKind: "jobs-state",
      jobs: [{
        id: "health",
        name: "Health Check",
        enabled: true,
        classification: "stale_error_state",
        evidence: "latest_success_after_error",
        severity: "info",
        repairable: true,
        freshUntil: "2026-05-05T12:00:00.000Z",
        lastRuntimeStatus: "error",
        stateSource: "jobs-state",
        latestSuccessAtMs: 1000,
        latestErrorAtMs: 500,
        semanticDrift: false,
      }],
      reloadGateway: () => true,
      verify: () => [{
        id: "health",
        name: "Health Check",
        enabled: true,
        classification: "healthy",
        evidence: "runtime_state_ok",
        severity: "info",
        repairable: false,
        freshUntil: null,
        lastRuntimeStatus: "ok",
        stateSource: "jobs-state",
        latestSuccessAtMs: 1000,
        latestErrorAtMs: 500,
        semanticDrift: false,
      }],
      nowMs: Date.parse("2026-05-05T12:00:00.000Z"),
    });

    const repaired = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(result.errors).toEqual([]);
    expect(result.repairedJobIds).toEqual(["health"]);
    expect(result.backupPath && fs.existsSync(result.backupPath)).toBe(true);
    expect(result.reloadAttempted).toBe(true);
    expect(result.reloadVerified).toBe(true);
    expect(repaired.jobs.health.state).toEqual({
      lastRunAtMs: 1000,
      lastStatus: "ok",
      lastRunStatus: "ok",
      consecutiveErrors: 0,
      nextRunAtMs: 2000,
    });
  });

  it("derives freshness windows from common cron schedules", () => {
    expect(scheduleIntervalMs({ schedule: { kind: "cron", expr: "*/15 * * * *" } })).toBe(15 * 60 * 1000);
    expect(scheduleIntervalMs({ schedule: { kind: "cron", expr: "7 6-23 * * *" } })).toBe(60 * 60 * 1000);
    expect(scheduleIntervalMs({ schedule: { kind: "cron", expr: "30 7 * * *" } })).toBe(24 * 60 * 60 * 1000);
  });
});
