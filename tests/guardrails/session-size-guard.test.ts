import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { captureStdout, resetProcess } from "../test-utils";

const execSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execSync }));

afterEach(() => {
  vi.restoreAllMocks();
  resetProcess();
  execSync.mockReset();
});

function makeSessionFile(base: string, agent: string, fileName: string, sizeBytes: number): string {
  const sessionsDir = join(base, agent, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const file = join(sessionsDir, fileName);
  writeFileSync(file, "x".repeat(sizeBytes));
  return file;
}

describe("session-size-guard", () => {
  it("finds oversized files", async () => {
    const root = mkdtempSync(join(tmpdir(), "session-size-guard-"));
    makeSessionFile(root, "alpha", "small.jsonl", 200 * 1024);
    const oversized = makeSessionFile(root, "alpha", "big.jsonl", 1300 * 1024);

    const mod = await import("../../tools/guardrails/session-size-guard");
    const files = mod.getSessionFiles(root);
    const results = mod.evaluateFiles(files, { warningThresholdKb: 1024, alertThresholdKb: 2048 });

    expect(results).toHaveLength(1);
    expect(results[0]?.sessionFile).toBe(oversized);
    expect(results[0]?.severity).toBe("warning");
  });

  it("applies warning/alert threshold logic", async () => {
    const root = mkdtempSync(join(tmpdir(), "session-size-guard-"));
    makeSessionFile(root, "alpha", "warn.jsonl", 1200 * 1024);
    makeSessionFile(root, "beta", "alert.jsonl", 2500 * 1024);

    const mod = await import("../../tools/guardrails/session-size-guard");
    const files = mod.getSessionFiles(root);
    const results = mod.evaluateFiles(files, { warningThresholdKb: 1024, alertThresholdKb: 2048 });

    expect(results.map((r: any) => r.severity).sort()).toEqual(["alert", "warning"]);
  });

  it("prints JSON summary when oversized sessions exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "session-size-guard-"));
    makeSessionFile(root, "gamma", "oversized.jsonl", 1100 * 1024);

    const mod = await import("../../tools/guardrails/session-size-guard");
    const stdout = captureStdout();

    const code = mod.run([], root);

    expect(code).toBe(0);
    expect(stdout.writes.length).toBe(1);
    const payload = JSON.parse(stdout.writes[0] ?? "{}");
    expect(payload.source).toBe("session-size-guard");
    expect(payload.totalOversized).toBe(1);
    expect(payload.sessions[0].agent).toBe("gamma");
    expect(payload.sessions[0].severity).toBe("warning");
  });

  it("supports namespaced env vars for thresholds", async () => {
    process.env.SESSION_SIZE_WARNING_THRESHOLD_KB = "512";
    process.env.SESSION_SIZE_ALERT_THRESHOLD_KB = "1024";
    process.env.SESSION_SIZE_ALERT_COOLDOWN_SECONDS = "60";

    const mod = await import("../../tools/guardrails/session-size-guard");
    const cfg = mod.getConfig([]);
    expect(cfg.warningThresholdKb).toBe(512);
    expect(cfg.alertThresholdKb).toBe(1024);
    expect(cfg.alertCooldownSeconds).toBe(60);
  });

  it("suppresses duplicate alerts within cooldown window", async () => {
    const mod = await import("../../tools/guardrails/session-size-guard");
    const stateFile = join(tmpdir(), `session-size-guard-${randomUUID()}.json`);
    const record = {
      agent: "alpha",
      sessionFile: "/tmp/alpha/sessions/oversized.jsonl",
      sizeBytes: 3 * 1024 * 1024,
      sizeKb: 3072,
      severity: "alert",
    } as const;

    const first = mod.filterByCooldown([record], 300, 1000, stateFile);
    const second = mod.filterByCooldown([record], 300, 1200, stateFile);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });
});
