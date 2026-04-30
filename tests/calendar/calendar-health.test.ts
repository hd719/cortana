import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCalendarHealth } from "../../tools/calendar/calendar-health.ts";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}));

const runGogWithEnv = vi.hoisted(() => vi.fn());

vi.mock("node:fs", () => ({
  default: fsMock,
  ...fsMock,
}));

vi.mock("../../tools/gog/gog-with-env.ts", () => ({
  runGogWithEnv,
}));

beforeEach(() => {
  fsMock.existsSync.mockReset();
  fsMock.readdirSync.mockReset();
  fsMock.statSync.mockReset();
  runGogWithEnv.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("calendar health", () => {
  it("stays ok when Gog works and the legacy vdirsyncer token is missing", () => {
    runGogWithEnv.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ events: [{ id: "evt" }] }),
      stderr: "",
    });
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readdirSync.mockImplementation(() => {
      throw new Error("missing mirror");
    });

    const health = buildCalendarHealth({} as NodeJS.ProcessEnv);

    expect(health.status).toBe("ok");
    expect(health.sourceOfTruth).toBe("gog");
    expect(health.gog.ok).toBe(true);
    expect(health.legacyVdirsyncer.status).toBe("missing_token");
    expect(runGogWithEnv).toHaveBeenCalledWith(
      expect.arrayContaining(["calendar", "events"]),
    );
  });

  it("warns on missing vdirsyncer token only when explicitly required", () => {
    runGogWithEnv.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ events: [] }),
      stderr: "",
    });
    fsMock.existsSync.mockReturnValue(false);

    const health = buildCalendarHealth({
      REQUIRE_VDIRSYNCER_CALENDAR: "1",
    } as NodeJS.ProcessEnv);

    expect(health.status).toBe("warn");
    expect(health.legacyVdirsyncer.required).toBe(true);
  });

  it("errors when Gog calendar access fails", () => {
    runGogWithEnv.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "oauth token expired",
    });
    fsMock.existsSync.mockReturnValue(false);

    const health = buildCalendarHealth({} as NodeJS.ProcessEnv);

    expect(health.status).toBe("error");
    expect(health.gog.error).toContain("oauth token expired");
  });
});
