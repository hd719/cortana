import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushModuleSideEffects, importFresh, mockExit, resetProcess, setArgv, useFixedTime } from "../test-utils";

const readJsonFile = vi.hoisted(() => vi.fn());
const spawnSync = vi.hoisted(() => vi.fn());
const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock("../../tools/lib/json-file.js", () => ({
  readJsonFile,
}));
vi.mock("child_process", () => ({
  spawnSync,
}));
vi.mock("node:fs", () => ({
  default: fsMock,
  ...fsMock,
}));

describe("openai-cron-auth-guard", () => {
  beforeEach(() => {
    readJsonFile.mockReset();
    spawnSync.mockReset();
    fsMock.existsSync.mockReset();
    fsMock.mkdirSync.mockReset();
    fsMock.writeFileSync.mockReset();
    fsMock.renameSync.mockReset();
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_AUTH_PROBE_RETRY_MS = "0";
    process.env.OPENAI_AUTH_PROBE_ATTEMPTS = "2";
    fsMock.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetProcess();
    delete (globalThis as any).fetch;
  });

  it("accepts configured OpenAI model variants and retries transient probe failures before alerting", async () => {
    const exitSpy = mockExit();
    setArgv(["preflight"]);
    useFixedTime("2026-03-10T13:00:00Z");

    readJsonFile.mockImplementation((filePath: string) => {
      if (filePath.includes(".openclaw/cron/jobs.json")) {
        return {
          jobs: [
            {
              id: "job-1",
              name: "☀️ Morning brief (Hamel)",
              enabled: true,
              payload: { model: "openai-codex/gpt-5.1" },
            },
          ],
        };
      }
      if (filePath.includes(".openclaw/openclaw.json")) {
        return {
          models: {
            providers: { openai: { apiKey: "live-key" } },
            available: {
              "openai-codex/gpt-5.1": {},
              "openai-codex/gpt-5.3-codex": {},
            },
          },
        };
      }
      if (filePath.endsWith("config/openclaw.json")) {
        return {
          models: {
            providers: { openai: { apiKey: "__OPENCLAW_REDACTED__" } },
            available: {
              "openai-codex/gpt-5.1": {},
              "openai-codex/gpt-5.3-codex": {},
            },
          },
        };
      }
      if (filePath.includes("provider-fallback-policy.json")) {
        return {
          providers: {
            codex: { fallback_order: ["opus", "sonnet"] },
          },
        };
      }
      return null;
    });
    fsMock.existsSync.mockImplementation((filePath: string) => filePath.includes("provider-fallback-policy.json"));

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "temporary unavailable" })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "ok" });
    (globalThis as any).fetch = fetchMock;

    await importFresh("../../tools/alerting/openai-cron-auth-guard.ts");
    await flushModuleSideEffects();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("does not treat quota-style failures as auth failures during sweep", async () => {
    const exitSpy = mockExit();
    setArgv(["sweep"]);

    readJsonFile.mockImplementation((filePath: string) => {
      if (filePath.includes(".openclaw/cron/jobs.json")) {
        return {
          jobs: [
            {
              id: "job-1",
              name: "☀️ Morning brief (Hamel)",
              enabled: true,
              state: { lastError: "429 quota exceeded from provider" },
            },
          ],
        };
      }
      if (filePath.includes(".openclaw/openclaw.json")) {
        return { models: { providers: { openai: { apiKey: "live-key" } }, available: {} } };
      }
      if (filePath.endsWith("config/openclaw.json")) {
        return { models: { providers: { openai: { apiKey: "test-key" } }, available: {} } };
      }
      if (filePath.includes("provider-fallback-policy.json")) {
        return { providers: { codex: { fallback_order: ["opus", "sonnet"] } } };
      }
      return null;
    });
    fsMock.existsSync.mockImplementation((filePath: string) => filePath.includes("provider-fallback-policy.json"));

    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "ok" });

    await importFresh("../../tools/alerting/openai-cron-auth-guard.ts");
    await flushModuleSideEffects();

    expect(spawnSync).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("refuses to retry critical jobs when fresh auth probe still fails", async () => {
    const exitSpy = mockExit();
    setArgv(["sweep"]);
    useFixedTime("2026-03-10T13:00:00Z");

    readJsonFile.mockImplementation((filePath: string) => {
      if (filePath.includes(".openclaw/cron/jobs.json")) {
        return {
          jobs: [
            {
              id: "job-1",
              name: "☀️ Morning brief (Hamel)",
              enabled: true,
              state: { lastError: "401 unauthorized" },
            },
          ],
        };
      }
      if (filePath.includes(".openclaw/openclaw.json")) {
        return { models: { providers: { openai: { apiKey: "live-key" } }, available: {} } };
      }
      if (filePath.endsWith("config/openclaw.json")) {
        return { models: { providers: { openai: { apiKey: "test-key" } }, available: {} } };
      }
      if (filePath.includes("provider-fallback-policy.json")) {
        return { providers: { codex: { fallback_order: ["opus", "sonnet"] } } };
      }
      return null;
    });
    fsMock.existsSync.mockImplementation((filePath: string) => filePath.includes("provider-fallback-policy.json"));

    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "unauthorized" });

    await importFresh("../../tools/alerting/openai-cron-auth-guard.ts");
    await flushModuleSideEffects();

    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledWith(
      expect.stringContaining("telegram-delivery-guard.sh"),
      expect.arrayContaining([expect.stringContaining("OpenAI auth failures hit critical cron jobs")]),
      expect.objectContaining({ encoding: "utf8" })
    );
    expect(spawnSync).not.toHaveBeenCalledWith(
      "openclaw",
      ["cron", "run", "job-1"],
      expect.anything()
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("skips the probe when the codex provider circuit is not currently attemptable", async () => {
    const exitSpy = mockExit();
    setArgv(["preflight"]);
    useFixedTime("2026-03-10T13:00:00Z");
    const openedAt = Math.floor(Date.parse("2026-03-10T12:58:30Z") / 1000);
    const firstFailureAt = Math.floor(Date.parse("2026-03-10T12:58:30Z") / 1000);
    const secondFailureAt = Math.floor(Date.parse("2026-03-10T12:59:00Z") / 1000);
    const thirdFailureAt = Math.floor(Date.parse("2026-03-10T12:59:30Z") / 1000);

    readJsonFile.mockImplementation((filePath: string) => {
      if (filePath.includes(".openclaw/cron/jobs.json")) {
        return {
          jobs: [
            {
              id: "job-1",
              name: "☀️ Morning brief (Hamel)",
              enabled: true,
              payload: { model: "openai-codex/gpt-5.3-codex" },
            },
          ],
        };
      }
      if (filePath.includes(".openclaw/openclaw.json")) {
        return { models: { providers: { openai: { apiKey: "live-key" } }, available: { "openai-codex/gpt-5.3-codex": {} } } };
      }
      if (filePath.endsWith("config/openclaw.json")) {
        return { models: { providers: { openai: { apiKey: "test-key" } }, available: { "openai-codex/gpt-5.3-codex": {} } } };
      }
      if (filePath.includes("provider-fallback-policy.json")) {
        return { providers: { codex: { fallback_order: ["opus", "sonnet"] } } };
      }
      if (filePath.includes("circuit-breaker-state.json")) {
        return {
          version: 2,
          updated_at: "2026-03-10T13:00:00Z",
          config: {},
          providers: {
            codex: {
              provider: "codex",
              circuit: "open",
              opened_at: openedAt,
              half_open_since: null,
              consecutive_successes: 0,
              needs_human_page: false,
              last_error_code: 503,
              last_error_kind: "retryable",
              last_trip_reason: "retryable_threshold",
              last_trip_at: "2026-03-10T12:55:00Z",
              error_burst: {
                active: true,
                count: 3,
                threshold: 3,
                window_seconds: 120,
                started_at: firstFailureAt,
                last_error_at: thirdFailureAt,
                last_status_code: 429,
                last_triggered_at: "2026-03-10T12:59:30Z",
              },
              updated_at: "2026-03-10T12:55:00Z",
              metrics: { total: 3, retryable: 3, retryable_rate: 1, non_retryable: 0, fatal: 0, success: 0, non_retryable_rate: 0 },
              window: [
                { ts: firstFailureAt, status_code: 503, kind: "retryable" },
                { ts: secondFailureAt, status_code: 503, kind: "retryable" },
                { ts: thirdFailureAt, status_code: 429, kind: "retryable" },
              ],
            },
          },
        };
      }
      return null;
    });
    fsMock.existsSync.mockImplementation((filePath: string) =>
      filePath.includes("provider-fallback-policy.json") || filePath.includes("circuit-breaker-state.json")
    );

    const fetchMock = vi.fn();
    (globalThis as any).fetch = fetchMock;

    await importFresh("../../tools/alerting/openai-cron-auth-guard.ts");
    await flushModuleSideEffects();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledWith(
      expect.stringContaining("telegram-delivery-guard.sh"),
      expect.arrayContaining([
        expect.stringContaining("OpenAI provider circuit"),
        expect.stringContaining("probe skipped"),
        expect.stringContaining("error burst 3/3 in 120s"),
      ]),
      expect.objectContaining({ encoding: "utf8" })
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("bypasses a stale fatal_auth circuit and clears it after a successful live probe", async () => {
    const exitSpy = mockExit();
    setArgv(["preflight"]);
    useFixedTime("2026-04-10T13:20:00Z");
    const openedAt = Math.floor(Date.parse("2026-04-10T13:00:00Z") / 1000);

    readJsonFile.mockImplementation((filePath: string) => {
      if (filePath.includes(".openclaw/cron/jobs.json")) {
        return {
          jobs: [
            {
              id: "job-1",
              name: "☀️ Morning brief (Hamel)",
              enabled: true,
              payload: { model: "openai-codex/gpt-5.1" },
            },
          ],
        };
      }
      if (filePath.includes(".openclaw/openclaw.json")) {
        return {
          models: {
            providers: { openai: { apiKey: "live-key" } },
            available: {
              "openai-codex/gpt-5.1": {},
              "openai-codex/gpt-5.3-codex": {},
            },
          },
        };
      }
      if (filePath.endsWith("config/openclaw.json")) {
        return {
          models: {
            providers: { openai: { apiKey: "REDACTED_USE_LIVE_CONFIG" } },
            available: {},
          },
        };
      }
      if (filePath.includes("provider-fallback-policy.json")) {
        return { providers: { codex: { fallback_order: ["opus", "sonnet"] } } };
      }
      if (filePath.includes("circuit-breaker-state.json")) {
        return {
          version: 2,
          updated_at: "2026-04-10T13:19:00Z",
          config: {},
          providers: {
            codex: {
              provider: "codex",
              circuit: "open",
              opened_at: openedAt,
              half_open_since: null,
              consecutive_successes: 0,
              needs_human_page: true,
              last_error_code: 401,
              last_error_kind: "fatal",
              last_trip_reason: "fatal_auth",
              last_trip_at: "2026-04-10T13:00:00Z",
              error_burst: {
                active: false,
                count: 1,
                threshold: 3,
                window_seconds: 120,
                started_at: openedAt,
                last_error_at: openedAt,
                last_status_code: 401,
                last_triggered_at: null,
              },
              updated_at: "2026-04-10T13:00:00Z",
              metrics: { total: 1, retryable: 0, retryable_rate: 0, non_retryable: 0, fatal: 1, success: 0, non_retryable_rate: 0 },
              window: [{ ts: openedAt, status_code: 401, kind: "fatal" }],
            },
          },
        };
      }
      return null;
    });
    fsMock.existsSync.mockImplementation((filePath: string) =>
      filePath.includes("provider-fallback-policy.json") || filePath.includes("circuit-breaker-state.json")
    );

    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "ok" });
    (globalThis as any).fetch = fetchMock;

    await importFresh("../../tools/alerting/openai-cron-auth-guard.ts");
    await flushModuleSideEffects();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(fsMock.writeFileSync).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
