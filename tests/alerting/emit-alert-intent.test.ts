import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureConsole,
  captureStdout,
  importFresh,
  mockExit,
  resetProcess,
  setArgv,
  useFixedTime,
} from "../test-utils";

const runPsql = vi.hoisted(() => vi.fn());

vi.mock("../../tools/lib/db.js", () => ({
  runPsql,
  withPostgresPath: (env: NodeJS.ProcessEnv) => env,
}));
vi.mock("../../tools/lib/paths.js", () => ({
  PSQL_BIN: "/usr/bin/psql",
}));
vi.mock("crypto", () => ({
  randomUUID: () => "uuid-1234",
}));

beforeEach(() => {
  runPsql.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetProcess();
});

describe("emit-alert-intent", () => {
  it("exits when psql is missing", async () => {
    const exitSpy = mockExit();
    const consoleCapture = captureConsole();
    setArgv(["heartbeat"]);
    runPsql.mockReturnValueOnce({ status: 1, error: true });

    await expect(importFresh("../../tools/alerting/emit-alert-intent.ts")).rejects.toThrow(
      "process.exit:1"
    );
    expect(consoleCapture.errors.join(" ")).toContain("psql not found");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("generates intent id and expected delivery time when missing", async () => {
    useFixedTime("2025-01-01T00:00:00Z");
    process.env.ALERT_EXPECTED_DELIVERY_SECONDS = "60";
    setArgv(["status"]);
    runPsql.mockReturnValue({ status: 0 });

    const stdout = captureStdout();
    await importFresh("../../tools/alerting/emit-alert-intent.ts");

    const payload = JSON.parse(stdout.writes.join(""));
    expect(payload.intent_id).toBe("uuid-1234");
    expect(payload.alert_type).toBe("status");
    expect(payload.expected_delivery_time).toBe("2025-01-01T00:01:00Z");
    stdout.restore();
  });

  it("honors provided arguments", async () => {
    setArgv(["deploy", "sms", "2025-02-01T00:00:00Z", "intent-77"]);
    runPsql.mockReturnValue({ status: 0 });

    const stdout = captureStdout();
    await importFresh("../../tools/alerting/emit-alert-intent.ts");

    const payload = JSON.parse(stdout.writes.join(""));
    expect(payload.alert_type).toBe("deploy");
    expect(payload.target_channel).toBe("sms");
    expect(payload.intent_id).toBe("intent-77");
    expect(payload.expected_delivery_time).toBe("2025-02-01T00:00:00Z");
    stdout.restore();
  });
});
