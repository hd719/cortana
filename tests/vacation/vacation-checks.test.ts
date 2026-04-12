import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadVacationOpsConfig } from "../../tools/vacation/vacation-config.ts";
import { runSystemCheck } from "../../tools/vacation/vacation-checks.ts";

const config = loadVacationOpsConfig();

function writeRuntimeCron(jobName: string, lastRunAt: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vacation-checks-"));
  const runtimeCronFile = path.join(tempDir, "jobs.json");
  fs.writeFileSync(runtimeCronFile, JSON.stringify({
    jobs: [
      {
        id: "job-1",
        name: jobName,
        enabled: true,
        state: {
          lastRunAtMs: Date.parse(lastRunAt),
          lastStatus: "ok",
          lastRunStatus: "ok",
          lastDeliveryStatus: "ok",
          consecutiveErrors: 0,
        },
      },
    ],
  }), "utf8");
  return runtimeCronFile;
}

function writeRuntimeCronFixture(job: Record<string, unknown>) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vacation-checks-"));
  const runtimeCronFile = path.join(tempDir, "jobs.json");
  const runtimeCronRunsDir = path.join(tempDir, "runs");
  fs.mkdirSync(runtimeCronRunsDir, { recursive: true });
  fs.writeFileSync(runtimeCronFile, JSON.stringify({ jobs: [job] }), "utf8");
  return { tempDir, runtimeCronFile, runtimeCronRunsDir };
}

function writeLanesConfig(dir: string, names: string[]) {
  const lanesConfigFile = path.join(dir, "autonomy-lanes.json");
  fs.writeFileSync(lanesConfigFile, JSON.stringify({ familyCriticalCronNames: names }), "utf8");
  return lanesConfigFile;
}

function writeCronRun(runsDir: string, jobId: string, entry: Record<string, unknown>) {
  fs.writeFileSync(path.join(runsDir, `${jobId}.jsonl`), `${JSON.stringify(entry)}\n`, "utf8");
}

function telegramStatusSpawn() {
  return ((cmd: string, args: string[]) => {
    if (cmd !== "openclaw") return { status: 1, stdout: "", stderr: "unexpected command" } as any;
    if (args[0] === "status" && args[1] === "--json") {
      return {
        status: 0,
        stdout: JSON.stringify({ channelSummary: ["Telegram: configured"] }),
        stderr: "",
      } as any;
    }
    if (args[0] === "status") {
      return {
        status: 0,
        stdout: "Telegram | OK",
        stderr: "",
      } as any;
    }
    return { status: 1, stdout: "", stderr: "unsupported status command" } as any;
  }) as any;
}

function greenBaselineSpawn() {
  return ((cmd: string, args: string[]) => {
    if (cmd !== "bash") return { status: 1, stdout: "", stderr: "unexpected command" } as any;
    if (args[0]?.endsWith("tools/qa/green-baseline.sh") && args.includes("--skip-git")) {
      return { status: 0, stdout: "GREEN_BASELINE=ok\n", stderr: "" } as any;
    }
    return { status: 1, stdout: "", stderr: "missing --skip-git" } as any;
  }) as any;
}

function githubAuthSpawn() {
  return ((cmd: string, args: string[]) => {
    if (cmd !== "gh") return { status: 1, stdout: "", stderr: "unexpected command" } as any;
    if (args.join(" ") === "auth status --show-token") {
      return {
        status: 0,
        stdout: [
          "github.com",
          "  ✓ Logged in to github.com account cortana-hd (/Users/hd/.config/gh/hosts.yml)",
          "  - Active account: true",
          "  - Git operations protocol: ssh",
          "  - Token: gho_ABC123456789XYZ",
          "  - Token scopes: 'admin:public_key', 'gist', 'repo'",
        ].join("\n"),
        stderr: "",
      } as any;
    }
    return { status: 1, stdout: "", stderr: "unsupported gh command" } as any;
  }) as any;
}

function financialServicesSpawn() {
  return ((cmd: string, args: string[]) => {
    if (cmd !== "curl") return { status: 1, stdout: "", stderr: "unexpected command" } as any;
    const url = args[args.length - 1];
    if (url.endsWith("/alpaca/health")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          status: "unhealthy",
          error: "alpaca API error 401: unauthorized",
        }),
        stderr: "",
      } as any;
    }
    if (url.endsWith("/market-data/ops")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          status: "ok",
          providerMode: "schwab_primary",
          providerModeReason: "Ops reporting is reflecting the current primary service lanes.",
          degradedReason: null,
          data: {
            health: {
              providers: {
                coinmarketcap: "configured",
                fred: "configured",
              },
            },
          },
        }),
        stderr: "",
      } as any;
    }
    return { status: 1, stdout: "", stderr: `unexpected url ${url}` } as any;
  }) as any;
}

function writeSessionStore(agentId: string, entries: Record<string, unknown>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `vacation-${agentId}-sessions-`));
  const sessionsDir = path.join(home, ".openclaw", "agents", agentId, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const storePath = path.join(sessionsDir, "sessions.json");
  fs.writeFileSync(storePath, JSON.stringify(entries, null, 2), "utf8");
  return { home, sessionsDir, storePath };
}

describe("vacation market checks", () => {
  it("computes premarket next-open timing from the current session", () => {
    const runtimeCronFile = writeRuntimeCron("📈 Stock Market Brief (daily)", "2026-03-31T12:00:00.000Z");
    const result = runSystemCheck(config, {
      runtimeCronFile,
      now: () => new Date("2026-03-31T13:00:00.000Z"),
    }, "market_scans");

    expect(result.detail.marketHours).toBe(false);
    expect(result.detail.marketPhase).toBe("PREMARKET");
    expect(result.detail.minutesBeforeNextOpen).toBe(30);
  });

  it("marks regular-hours market checks as market-hours instead of pre-open", () => {
    const runtimeCronFile = writeRuntimeCron("📈 Stock Market Brief (daily)", "2026-03-31T14:30:00.000Z");
    const result = runSystemCheck(config, {
      runtimeCronFile,
      now: () => new Date("2026-03-31T15:00:00.000Z"),
    }, "market_scans");

    expect(result.detail.marketHours).toBe(true);
    expect(result.detail.marketPhase).toBe("OPEN");
    expect(result.detail.minutesBeforeNextOpen).toBe(0);
  });
});

describe("vacation tier0 delivery checks", () => {
  it("fails telegram delivery when status is healthy but no delivery ledger verifies a critical lane", () => {
    const jobName = "📅 Calendar reminders → Telegram (ALL calendars)";
    const { tempDir, runtimeCronFile, runtimeCronRunsDir } = writeRuntimeCronFixture({
      id: "job-telegram-1",
      name: jobName,
      enabled: true,
      state: {
        lastRunAtMs: Date.parse("2026-04-11T15:00:00.000Z"),
        lastStatus: "ok",
        lastRunStatus: "ok",
        lastDeliveryStatus: "",
        nextRunAtMs: Date.parse("2026-04-11T16:30:00.000Z"),
        consecutiveErrors: 0,
      },
    });
    const lanesConfigFile = writeLanesConfig(tempDir, [jobName]);

    const result = runSystemCheck(config, {
      runtimeCronFile,
      runtimeCronRunsDir,
      lanesConfigFile,
      spawn: telegramStatusSpawn(),
      now: () => new Date("2026-04-11T16:00:00.000Z"),
    }, "telegram_delivery");

    expect(result.status).toBe("red");
    expect(result.detail.transportConfigured).toBe(true);
    expect((result.detail.deliveryEvidence as any).reason).toBe("critical_cron_delivery_unverified");
  });

  it("passes telegram delivery when a recent critical-lane run ledger records successful delivery", () => {
    const jobName = "📅 Calendar reminders → Telegram (ALL calendars)";
    const { tempDir, runtimeCronFile, runtimeCronRunsDir } = writeRuntimeCronFixture({
      id: "job-telegram-2",
      name: jobName,
      enabled: true,
      state: {
        lastRunAtMs: Date.parse("2026-04-11T14:00:00.000Z"),
        lastStatus: "ok",
        lastRunStatus: "ok",
        lastDeliveryStatus: "",
        nextRunAtMs: Date.parse("2026-04-11T16:30:00.000Z"),
        consecutiveErrors: 0,
      },
    });
    const lanesConfigFile = writeLanesConfig(tempDir, [jobName]);
    writeCronRun(runtimeCronRunsDir, "job-telegram-2", {
      ts: Date.parse("2026-04-11T15:45:00.000Z"),
      action: "finished",
      status: "ok",
      nextRunAtMs: Date.parse("2026-04-11T16:30:00.000Z"),
      deliveryStatus: "ok",
    });

    const result = runSystemCheck(config, {
      runtimeCronFile,
      runtimeCronRunsDir,
      lanesConfigFile,
      spawn: telegramStatusSpawn(),
      now: () => new Date("2026-04-11T16:00:00.000Z"),
    }, "telegram_delivery");

    expect(result.status).toBe("green");
    expect((result.detail.deliveryEvidence as any).evidenceJob.evidenceSource).toBe("run_ledger");
  });

  it("passes telegram delivery when a recent critical-lane run completed cleanly with a no-op not-delivered status", () => {
    const jobName = "⏰ Apple Reminders alerts → Telegram (Monitor)";
    const { tempDir, runtimeCronFile, runtimeCronRunsDir } = writeRuntimeCronFixture({
      id: "job-telegram-3",
      name: jobName,
      enabled: true,
      state: {
        lastRunAtMs: Date.parse("2026-04-11T15:45:00.000Z"),
        lastStatus: "ok",
        lastRunStatus: "ok",
        lastDeliveryStatus: "not-delivered",
        nextRunAtMs: Date.parse("2026-04-11T16:30:00.000Z"),
        consecutiveErrors: 0,
      },
    });
    const lanesConfigFile = writeLanesConfig(tempDir, [jobName]);
    writeCronRun(runtimeCronRunsDir, "job-telegram-3", {
      ts: Date.parse("2026-04-11T15:45:00.000Z"),
      action: "finished",
      status: "ok",
      nextRunAtMs: Date.parse("2026-04-11T16:30:00.000Z"),
      deliveryStatus: "not-delivered",
    });

    const result = runSystemCheck(config, {
      runtimeCronFile,
      runtimeCronRunsDir,
      lanesConfigFile,
      spawn: telegramStatusSpawn(),
      now: () => new Date("2026-04-11T16:00:00.000Z"),
    }, "telegram_delivery");

    expect(result.status).toBe("green");
    expect((result.detail.deliveryEvidence as any).evidenceJob.lastDeliveryStatus).toBe("not-delivered");
  });

  it("fails main-agent delivery when the store entry has no live session artifact", () => {
    const { storePath } = writeSessionStore("main", {
      "agent:main:telegram:direct:1234": {
        updatedAt: "2026-04-11T15:45:00.000Z",
        sessionId: "missing-transcript",
      },
    });

    const result = runSystemCheck(config, {
      mainSessionStore: storePath,
      now: () => new Date("2026-04-11T16:00:00.000Z"),
    }, "main_agent_delivery");

    expect(result.status).toBe("red");
    expect((result.detail.latestSession as any).sessionFileExists).toBe(false);
    expect((result.detail.missingArtifactKeys as string[])).toContain("agent:main:telegram:direct:1234");
  });

  it("passes monitor-agent delivery when a fresh session entry points at a non-empty transcript", () => {
    const { sessionsDir, storePath } = writeSessionStore("monitor", {
      "agent:monitor:main": {
        updatedAt: "2026-04-11T15:50:00.000Z",
        sessionId: "monitor-session-1",
        status: "completed",
      },
    });
    fs.writeFileSync(path.join(sessionsDir, "monitor-session-1.jsonl"), "{\"role\":\"assistant\",\"content\":\"ok\"}\n", "utf8");

    const result = runSystemCheck(config, {
      monitorSessionStore: storePath,
      now: () => new Date("2026-04-11T16:00:00.000Z"),
    }, "monitor_agent_delivery");

    expect(result.status).toBe("green");
    expect((result.detail.verifiedSession as any).sessionFileExists).toBe(true);
    expect((result.detail.verifiedSession as any).sessionFileSizeBytes).toBeGreaterThan(0);
  });

  it("runs green baseline in vacation mode without failing on branch git dirt", () => {
    const result = runSystemCheck(config, {
      spawn: greenBaselineSpawn(),
    }, "green_baseline");

    expect(result.status).toBe("green");
  });
});

describe("vacation structured detail checks", () => {
  it("returns structured github identity detail", () => {
    const result = runSystemCheck(config, {
      spawn: githubAuthSpawn(),
    }, "github_identity");

    expect(result.status).toBe("green");
    expect(result.detail.account).toBe("cortana-hd");
    expect(result.detail.gitProtocol).toBe("ssh");
    expect(String(result.detail.tokenRedacted)).toMatch(/^gho_\*+9XYZ$/);
    expect(result.detail.scopes).toEqual(["admin:public_key", "gist", "repo"]);
  });

  it("returns structured gog headless auth detail", () => {
    const result = runSystemCheck(config, {
      gogAuthList: () => ({
        status: 0,
        stdout: JSON.stringify({
          accounts: [
            {
              email: "hameldesai3@gmail.com",
              client: "default",
              services: ["calendar", "gmail"],
              scopes: ["email", "openid"],
              created_at: "2026-03-10T14:40:47Z",
              auth: "oauth",
            },
          ],
        }),
        stderr: "",
      }),
    }, "gog_headless_auth");

    expect(result.status).toBe("green");
    expect(result.detail.accountCount).toBeGreaterThan(0);
    expect(Array.isArray(result.detail.accounts)).toBe(true);
    expect((result.detail.accounts as any[])[0]?.email).toBe("hameldesai3@gmail.com");
  });

  it("groups financial external services without making degradation a hard failure", () => {
    const result = runSystemCheck(config, {
      spawn: financialServicesSpawn(),
      marketDataBaseUrl: "http://127.0.0.1:3033",
    }, "financial_external_services");

    expect(result.status).toBe("yellow");
    expect(result.detail.summary).toContain("Alpaca");
    expect((result.detail.services as any[]).map((service) => service.key)).toEqual([
      "alpaca",
      "coinmarketcap",
      "fred",
    ]);
    expect((result.detail.services as any[])[0]?.status).toBe("yellow");
    expect((result.detail.services as any[])[1]?.status).toBe("green");
  });
});
