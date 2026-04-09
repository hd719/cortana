import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("mission-control-feedback-signal", () => {
  const fetchMock = vi.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("skips when no explicit base url is configured under test", async () => {
    const { reconcileMissionControlFeedbackSignal } = await import("../../tools/feedback/mission-control-feedback-signal.ts");
    const result = await reconcileMissionControlFeedbackSignal(
      {
        category: "ops.test",
        severity: "medium",
        summary: "test",
        recurrenceKey: "ops:test",
        signalState: "active",
      },
      { NODE_ENV: "test" },
    );

    expect(result).toEqual(expect.objectContaining({ ok: true, skipped: true }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to Mission Control feedback ingest when base url is configured", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "fb-1", state: "created" }),
    });

    const { reconcileMissionControlFeedbackSignal } = await import("../../tools/feedback/mission-control-feedback-signal.ts");
    const result = await reconcileMissionControlFeedbackSignal(
      {
        category: "ops.test",
        severity: "medium",
        summary: "test",
        recurrenceKey: "ops:test",
        signalState: "active",
      },
      { MISSION_CONTROL_BASE_URL: "http://127.0.0.1:3000", MISSION_CONTROL_API_TOKEN: "secret" },
    );

    expect(result).toEqual(expect.objectContaining({ ok: true, id: "fb-1", state: "created" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/api/feedback/ingest",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-api-key": "secret",
        }),
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          producer_kind: "signal",
        }),
      }),
    );
  });
});
