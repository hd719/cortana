import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultState, providerState, recordRequest, routeFor } from "../../tools/guardrails/provider-health.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("provider-health error burst detection", () => {
  it("marks a provider burst active after clustered failures inside the burst window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T13:00:00Z"));

    const state = defaultState({
      circuit_breaker: {
        error_burst_window_sec: 120,
        error_burst_count: 3,
      },
      providers: {
        codex: { fallback_order: ["opus", "sonnet"] },
      },
    });

    recordRequest(state, "codex", 503);
    vi.advanceTimersByTime(30_000);
    recordRequest(state, "codex", 429);
    vi.advanceTimersByTime(30_000);
    const provider = recordRequest(state, "codex", 504);
    const route = routeFor("codex", 504, state, {
      providers: { codex: { fallback_order: ["opus", "sonnet"] } },
    });

    expect(provider.error_burst.active).toBe(true);
    expect(provider.error_burst.count).toBe(3);
    expect(provider.error_burst.threshold).toBe(3);
    expect(provider.error_burst.window_seconds).toBe(120);
    expect(provider.error_burst.last_status_code).toBe(504);
    expect(route.error_burst_active).toBe(true);
    expect(route.error_burst.count).toBe(3);
  });

  it("ages out a burst after the window elapses while preserving the last trigger timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T13:00:00Z"));

    const state = defaultState({
      circuit_breaker: {
        error_burst_window_sec: 60,
        error_burst_count: 3,
      },
    });

    recordRequest(state, "codex", 503);
    vi.advanceTimersByTime(10_000);
    recordRequest(state, "codex", 503);
    vi.advanceTimersByTime(10_000);
    recordRequest(state, "codex", 503);

    const burstActive = providerState(state, "codex");
    expect(burstActive.error_burst.active).toBe(true);
    const lastTriggeredAt = burstActive.error_burst.last_triggered_at;

    vi.advanceTimersByTime(61_000);
    const agedOut = providerState(state, "codex");

    expect(agedOut.error_burst.active).toBe(false);
    expect(agedOut.error_burst.count).toBe(0);
    expect(agedOut.error_burst.last_triggered_at).toBe(lastTriggeredAt);
  });
});
