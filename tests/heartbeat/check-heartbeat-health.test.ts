import { describe, expect, it } from "vitest";
import {
  evaluateHeartbeatHealth,
  renderHeartbeatHealth,
} from "../../tools/heartbeat/check-heartbeat-health";
import { defaultHeartbeatState } from "../../tools/lib/heartbeat-schema";

describe("check-heartbeat-health", () => {
  it("reports healthy when the canonical state is valid and fresh", () => {
    const now = Date.parse("2026-03-13T20:00:00Z");
    const state = defaultHeartbeatState(now - 60_000);

    const result = evaluateHeartbeatHealth(JSON.stringify(state), {
      nowMs: now,
      statePath: "/tmp/heartbeat-state.json",
      freshnessThresholdMs: 45 * 60 * 1000,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("healthy");
    expect(result.lastHeartbeatAgeMs).toBe(60_000);
    expect(result.freshnessSource).toBe("lastHeartbeat");
    expect(renderHeartbeatHealth(result)).toContain("HEALTHY heartbeat_state");
  });

  it("uses the freshest canonical signal across lastHeartbeat and lastChecks", () => {
    const now = Date.parse("2026-03-13T20:00:00Z");
    const state = defaultHeartbeatState(now - 10 * 60_000);
    state.lastHeartbeat = now - 2 * 60 * 60_000;
    state.lastChecks.cronDelivery.lastChecked = now - 30_000;

    const result = evaluateHeartbeatHealth(JSON.stringify(state), {
      nowMs: now,
      statePath: "/tmp/heartbeat-state.json",
      freshnessThresholdMs: 45 * 60 * 1000,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("healthy");
    expect(result.lastHeartbeatAgeMs).toBe(30_000);
    expect(result.freshnessSource).toBe("lastChecks.cronDelivery");
    expect(renderHeartbeatHealth(result)).toContain("source=lastChecks.cronDelivery");
  });

  it("reports stale when lastHeartbeat exceeds the freshness threshold", () => {
    const now = Date.parse("2026-03-13T20:00:00Z");
    const state = defaultHeartbeatState(now - 46 * 60 * 1000);

    const result = evaluateHeartbeatHealth(JSON.stringify(state), {
      nowMs: now,
      statePath: "/tmp/heartbeat-state.json",
      freshnessThresholdMs: 45 * 60 * 1000,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("stale");
    expect(result.error).toContain("exceeds freshness threshold");
  });

  it("treats stale state as healthy during overnight quiet hours", () => {
    const now = Date.parse("2026-05-01T09:20:00Z");
    const state = defaultHeartbeatState(Date.parse("2026-05-01T02:34:45.061Z"));

    const result = evaluateHeartbeatHealth(JSON.stringify(state), {
      nowMs: now,
      statePath: "/tmp/heartbeat-state.json",
      freshnessThresholdMs: 45 * 60 * 1000,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("healthy");
    expect(result.quietHours).toBe(true);
    expect(result.quietHoursGrace).toBe(true);
    expect(result.summary).toContain("quiet hours");
  });

  it("allows stale state during the first freshness window after quiet hours", () => {
    const now = Date.parse("2026-05-01T10:20:00Z");
    const state = defaultHeartbeatState(Date.parse("2026-05-01T02:34:45.061Z"));

    const result = evaluateHeartbeatHealth(JSON.stringify(state), {
      nowMs: now,
      statePath: "/tmp/heartbeat-state.json",
      freshnessThresholdMs: 45 * 60 * 1000,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("healthy");
    expect(result.quietHours).toBe(false);
    expect(result.quietHoursGrace).toBe(true);
    expect(result.summary).toContain("post-quiet grace");
  });

  it("reports stale after post-quiet grace expires", () => {
    const now = Date.parse("2026-05-01T10:50:00Z");
    const state = defaultHeartbeatState(Date.parse("2026-05-01T02:34:45.061Z"));

    const result = evaluateHeartbeatHealth(JSON.stringify(state), {
      nowMs: now,
      statePath: "/tmp/heartbeat-state.json",
      freshnessThresholdMs: 45 * 60 * 1000,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("stale");
    expect(result.quietHours).toBe(false);
    expect(result.quietHoursGrace).toBe(false);
  });

  it("reports invalid when the state fails schema validation", () => {
    const now = Date.parse("2026-03-13T20:00:00Z");

    const result = evaluateHeartbeatHealth('{"version":2,"lastHeartbeat":0}', {
      nowMs: now,
      statePath: "/tmp/heartbeat-state.json",
      freshnessThresholdMs: 45 * 60 * 1000,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("invalid");
    expect(result.error).toContain("lastChecks");
  });

  it("reports missing when the canonical state file is absent", () => {
    const now = Date.parse("2026-03-13T20:00:00Z");

    const result = evaluateHeartbeatHealth(null, {
      nowMs: now,
      statePath: "/tmp/heartbeat-state.json",
      freshnessThresholdMs: 45 * 60 * 1000,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("missing");
    expect(result.error).toContain("not found");
  });
});
