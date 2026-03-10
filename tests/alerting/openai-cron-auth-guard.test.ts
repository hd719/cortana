import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushModuleSideEffects, importFresh, mockExit, resetProcess, setArgv, useFixedTime } from "../test-utils";

const readJsonFile = vi.hoisted(() => vi.fn());
const spawnSync = vi.hoisted(() => vi.fn());

vi.mock("../../tools/lib/json-file.js", () => ({
  readJsonFile,
}));
vi.mock("child_process", () => ({
  spawnSync,
}));

describe("openai-cron-auth-guard", () => {
  beforeEach(() => {
    readJsonFile.mockReset();
    spawnSync.mockReset();
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_AUTH_PROBE_RETRY_MS = "0";
    process.env.OPENAI_AUTH_PROBE_ATTEMPTS = "2";
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
      return null;
    });

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
      if (filePath.endsWith("config/openclaw.json")) {
        return { models: { providers: { openai: { apiKey: "test-key" } }, available: {} } };
      }
      return null;
    });

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
      if (filePath.endsWith("config/openclaw.json")) {
        return { models: { providers: { openai: { apiKey: "test-key" } }, available: {} } };
      }
      return null;
    });

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
});
