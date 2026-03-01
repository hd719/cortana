import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureConsole,
  importFresh,
  mockExit,
  resetProcess,
  setArgv,
  useFixedTime,
} from "../test-utils";

const fsMock = vi.hoisted(() => ({
  constants: { X_OK: 1 },
  accessSync: vi.fn(),
}));
const spawnSync = vi.hoisted(() => vi.fn());
const readJsonFile = vi.hoisted(() => vi.fn());

vi.mock("fs", () => ({
  default: fsMock,
  ...fsMock,
}));
vi.mock("child_process", () => ({
  spawnSync,
}));
vi.mock("../../tools/lib/json-file.js", () => ({
  readJsonFile,
}));
vi.mock("../../tools/lib/paths.js", () => ({
  resolveHomePath: (...parts: string[]) => `/home/${parts.join("/")}`,
  PSQL_BIN: "/usr/bin/psql",
}));
vi.mock("../../tools/lib/db.js", () => ({
  withPostgresPath: (env: NodeJS.ProcessEnv) => env,
}));

beforeEach(() => {
  fsMock.accessSync.mockReset();
  spawnSync.mockReset();
  readJsonFile.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetProcess();
});

describe("check-cron-delivery", () => {
  it("exits cleanly when there are no failures", async () => {
    const exitSpy = mockExit();
    setArgv([]);
    readJsonFile.mockReturnValue({ jobs: [] });

    await expect(importFresh("../../tools/alerting/check-cron-delivery.ts")).rejects.toThrow("process.exit:0");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("logs failures but skips psql when executable missing", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    useFixedTime("2025-01-01T00:00:00Z");
    setArgv([]);

    readJsonFile.mockReturnValue({
      jobs: [
        {
          name: "daily",
          enabled: true,
          delivery: { mode: "telegram" },
          state: { lastStatus: "ok", lastDelivered: false, lastRunAtMs: Date.now() - 1000 },
        },
      ],
    });
    fsMock.accessSync.mockImplementation(() => {
      throw new Error("missing");
    });

    await expect(importFresh("../../tools/alerting/check-cron-delivery.ts")).rejects.toThrow("process.exit:1");
    expect(spawnSync).not.toHaveBeenCalled();
    expect(consoleCapture.logs.join(" ")).toContain("daily");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("inserts events when failures found and psql is executable", async () => {
    const exitSpy = mockExit();
    useFixedTime("2025-01-01T00:00:00Z");
    setArgv([]);
    readJsonFile.mockReturnValue({
      jobs: [
        {
          name: "daily",
          enabled: true,
          delivery: { mode: "telegram" },
          state: { lastStatus: "ok", lastDelivered: "false", lastRunAtMs: Date.now() - 1000 },
        },
      ],
    });
    fsMock.accessSync.mockImplementation(() => undefined);
    spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" } as any);

    await expect(importFresh("../../tools/alerting/check-cron-delivery.ts")).rejects.toThrow("process.exit:1");
    expect(spawnSync).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
