import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushModuleSideEffects, captureConsole, importFresh, mockExit, resetProcess, setArgv, useFixedTime } from "../test-utils";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));
const readJsonFile = vi.hoisted(() => vi.fn());

vi.mock("node:fs", () => ({
  default: fsMock,
  ...fsMock,
}));
vi.mock("../../tools/lib/json-file.js", () => ({
  readJsonFile,
}));

beforeEach(() => {
  fsMock.existsSync.mockReset();
  fsMock.mkdirSync.mockReset();
  fsMock.writeFileSync.mockReset();
  fsMock.renameSync.mockReset();
  readJsonFile.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetProcess();
});

describe("circuit-breaker", () => {
  it("records a request and writes state", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    useFixedTime("2025-01-01T00:00:00Z");
    setArgv(["--record", "opus", "500", "--cooldown", "0"]);
    fsMock.existsSync.mockImplementation((p: string) => p.includes("provider-fallback-policy.json"));
    readJsonFile.mockImplementation((p: string) => {
      if (p.includes("provider-fallback-policy.json")) {
        return {
          providers: {
            opus: { fallback_order: ["codex", "sonnet"] },
          },
        };
      }
      return {};
    });

    await importFresh("../../tools/guardrails/circuit-breaker.ts");
    await flushModuleSideEffects();
    const output = JSON.parse(consoleCapture.logs.join("\n"));
    expect(output.classification).toBe("retryable");
    expect(output.circuit).toBeDefined();
    expect(output.route_policy.action).toBe("fallback");
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(fsMock.writeFileSync).toHaveBeenCalled();
  });

  it("opens immediately on fatal auth failures and pages human", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv(["--record", "codex", "401"]);
    fsMock.existsSync.mockImplementation((p: string) => p.includes("provider-fallback-policy.json"));
    readJsonFile.mockImplementation((p: string) => {
      if (p.includes("provider-fallback-policy.json")) {
        return {
          providers: {
            codex: { fallback_order: ["opus", "sonnet"] },
          },
        };
      }
      return {};
    });

    await importFresh("../../tools/guardrails/circuit-breaker.ts");
    await flushModuleSideEffects();
    const output = JSON.parse(consoleCapture.logs.join("\n"));
    expect(output.circuit).toBe("open");
    expect(output.needs_human_page).toBe(true);
    expect(output.last_trip_reason).toBe("fatal_auth");
    expect(output.route_policy.action).toBe("page_human");
    expect(output.route_policy.provider_available).toBe(false);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("prints status with ordered providers", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv(["--status"]);
    fsMock.existsSync.mockImplementation(() => true);
    readJsonFile.mockImplementation((p: string) => {
      if (p.includes("provider-fallback-policy.json")) return { providers: {} };
      return {
        version: 1,
        updated_at: "2025-01-01T00:00:00Z",
        config: {},
        providers: {
          sonnet: { provider: "sonnet", circuit: "closed", window: [], metrics: { success: 1 } },
          opus: { provider: "opus", circuit: "closed", window: [], metrics: { success: 2 } },
        },
      };
    });

    await importFresh("../../tools/guardrails/circuit-breaker.ts");
    await flushModuleSideEffects();
    const payload = JSON.parse(consoleCapture.logs.join("\n"));
    expect(payload.providers[0].name).toBe("codex");
    expect(payload.providers[1].name).toBe("opus");
    expect(payload.providers[2].name).toBe("sonnet");
    expect(payload.recommendation.recommended_provider).toBe("opus");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("recommends null when no providers exist", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv([]);
    fsMock.existsSync.mockReturnValue(false);

    await importFresh("../../tools/guardrails/circuit-breaker.ts");
    await flushModuleSideEffects();
    const payload = JSON.parse(consoleCapture.logs.join("\n"));
    expect(payload.recommended_provider).toBe("codex");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("routes by provider-aware policy table", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv(["--route", "codex", "429"]);
    fsMock.existsSync.mockImplementation(() => true);
    readJsonFile.mockImplementation((p: string) => {
      if (p.includes("provider-fallback-policy.json")) {
        return {
          providers: {
            codex: {
              fallback_order: ["opus", "sonnet"],
              rate_limit: "fallback",
            },
          },
        };
      }
      return {
        version: 1,
        updated_at: "2025-01-01T00:00:00Z",
        config: {},
        providers: {
          opus: { provider: "opus", circuit: "closed", window: [], metrics: { success: 1 } },
        },
      };
    });

    await importFresh("../../tools/guardrails/circuit-breaker.ts");
    await flushModuleSideEffects();
    const payload = JSON.parse(consoleCapture.logs.join("\n"));
    expect(payload.failure_type).toBe("rate_limit");
    expect(payload.action).toBe("fallback");
    expect(payload.fallback_provider).toBe("opus");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("trips on repeated retryable failures and routes to a healthy fallback", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv(["--record", "codex", "503"]);
    fsMock.existsSync.mockImplementation(() => true);
    readJsonFile.mockImplementation((p: string) => {
      if (p.includes("provider-fallback-policy.json")) {
        return {
          providers: {
            codex: { fallback_order: ["opus", "sonnet"] },
          },
        };
      }
      return {
        version: 2,
        updated_at: "2025-01-01T00:00:00Z",
        config: {},
        providers: {
          codex: {
            provider: "codex",
            circuit: "closed",
            opened_at: null,
            half_open_since: null,
            consecutive_successes: 0,
            needs_human_page: false,
            last_error_code: 429,
            last_error_kind: "retryable",
            last_trip_reason: null,
            last_trip_at: null,
            updated_at: "2025-01-01T00:00:00Z",
            metrics: {},
            window: [
              { ts: 1735689600, status_code: 429, kind: "retryable" },
              { ts: 1735689601, status_code: 504, kind: "retryable" },
            ],
          },
          opus: {
            provider: "opus",
            circuit: "closed",
            opened_at: null,
            half_open_since: null,
            consecutive_successes: 0,
            needs_human_page: false,
            last_error_code: null,
            last_error_kind: null,
            last_trip_reason: null,
            last_trip_at: null,
            updated_at: "2025-01-01T00:00:00Z",
            metrics: { total: 1, retryable: 0, retryable_rate: 0, non_retryable: 0, fatal: 0, success: 1, non_retryable_rate: 0 },
            window: [{ ts: 1735689602, status_code: 200, kind: "success" }],
          },
        },
      };
    });

    await importFresh("../../tools/guardrails/circuit-breaker.ts");
    await flushModuleSideEffects();
    const output = JSON.parse(consoleCapture.logs.join("\n"));
    expect(output.circuit).toBe("open");
    expect(output.last_trip_reason).toBe("retryable_threshold");
    expect(output.metrics.retryable).toBe(3);
    expect(output.route_policy.action).toBe("fallback");
    expect(output.route_policy.fallback_provider).toBe("opus");
    expect(output.route_policy.provider_available).toBe(false);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
