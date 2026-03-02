import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_MAX_AGE_MS,
  HEARTBEAT_REQUIRED_CHECKS,
  defaultHeartbeatState,
  isHeartbeatQuietHours,
  shouldSendHeartbeatAlert,
  touchHeartbeat,
  validateHeartbeatState,
} from "../../tools/lib/heartbeat-schema.js";

describe("heartbeat schema", () => {
  it("accepts valid state", () => {
    const now = Date.now();
    const state = defaultHeartbeatState(now);
    const parsed = validateHeartbeatState(state, now, HEARTBEAT_MAX_AGE_MS);
    expect(parsed.version).toBe(2);
    expect(Object.keys(parsed.lastChecks)).toEqual(HEARTBEAT_REQUIRED_CHECKS);
  });

  it("rejects missing required checks", () => {
    const now = Date.now();
    const state = defaultHeartbeatState(now);
    delete state.lastChecks.weather;
    expect(() => validateHeartbeatState(state, now, HEARTBEAT_MAX_AGE_MS)).toThrow(/missing required check/);
  });

  it("rejects stale timestamps", () => {
    const now = Date.now();
    const state = defaultHeartbeatState(now);
    state.lastChecks.email.lastChecked = now - HEARTBEAT_MAX_AGE_MS - 1000;
    expect(() => validateHeartbeatState(state, now, HEARTBEAT_MAX_AGE_MS)).toThrow(/timestamp stale/);
  });

  it("detects quiet hours in ET", () => {
    expect(isHeartbeatQuietHours(new Date("2026-03-02T04:30:00-05:00"))).toBe(true);
    expect(isHeartbeatQuietHours(new Date("2026-03-02T12:00:00-05:00"))).toBe(false);
  });

  it("suppresses non-urgent alerts during quiet hours but allows urgent", () => {
    const quiet = new Date("2026-03-02T01:15:00-05:00");
    expect(shouldSendHeartbeatAlert(false, quiet)).toBe(false);
    expect(shouldSendHeartbeatAlert(true, quiet)).toBe(true);
  });

  it("updates lastHeartbeat when touched", () => {
    const now = 1772410000000;
    const state = defaultHeartbeatState(now - 60_000);
    touchHeartbeat(state, now);
    expect(state.lastHeartbeat).toBe(now);
  });
});
