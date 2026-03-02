import crypto from "node:crypto";

export type LastCheck = { lastChecked: number };

export type HeartbeatState = {
  version: number;
  lastHeartbeat: number;
  lastChecks: Record<string, LastCheck>;
  lastRemediationAt: number;
  subagentWatchdog: { lastRun: number; lastLogged: Record<string, number> };
  lastSnapshotAt?: number;
};

export const HEARTBEAT_REQUIRED_CHECKS = [
  "email",
  "calendar",
  "watchlist",
  "tasks",
  "portfolio",
  "marketIntel",
  "techNews",
  "weather",
  "fitness",
  "apiBudget",
  "mission",
  "cronDelivery",
] as const;

const FUTURE_SKEW_MS = 5 * 60 * 1000;
export const HEARTBEAT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const HEARTBEAT_QUIET_HOURS = {
  tz: "America/New_York",
  startHour: 23,
  endHour: 6,
} as const;

function getEtHour(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: HEARTBEAT_QUIET_HOURS.tz,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hourPart = parts.find((p) => p.type === "hour")?.value ?? "0";
  return Number(hourPart);
}

export function isHeartbeatQuietHours(now: Date = new Date()): boolean {
  const hour = getEtHour(now);
  return hour >= HEARTBEAT_QUIET_HOURS.startHour || hour < HEARTBEAT_QUIET_HOURS.endHour;
}

export function shouldSendHeartbeatAlert(isUrgent: boolean, now: Date = new Date()): boolean {
  if (isUrgent) return true;
  return !isHeartbeatQuietHours(now);
}

function parseTs(value: unknown, allowZero = false): number {
  if (value == null) throw new Error("timestamp missing");
  if (typeof value === "boolean") throw new Error("invalid bool timestamp");
  if (typeof value === "number") {
    let n = Math.trunc(value);
    if (n === 0 && allowZero) return 0;
    if (n < 1_000_000_000_000) {
      if (n < 1_000_000_000) throw new Error("numeric timestamp too small");
      n *= 1000;
    }
    return n;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) throw new Error("empty timestamp string");
    if (/^\d+$/.test(s)) return parseTs(Number(s), allowZero);
    const ms = Date.parse(s.replace("Z", "+00:00"));
    if (Number.isNaN(ms)) throw new Error("invalid iso timestamp");
    return ms;
  }
  throw new Error(`unsupported timestamp type: ${typeof value}`);
}

function assertTimestampSanity(label: string, ts: number, nowMs: number, maxAgeMs: number, allowZero = false): void {
  if (allowZero && ts === 0) return;
  if (ts > nowMs + FUTURE_SKEW_MS) throw new Error(`${label} timestamp in future`);
  if (nowMs - ts > maxAgeMs) throw new Error(`${label} timestamp stale`);
}

export function defaultHeartbeatState(nowMs = Date.now()): HeartbeatState {
  return {
    version: 2,
    lastHeartbeat: nowMs,
    lastChecks: Object.fromEntries(
      HEARTBEAT_REQUIRED_CHECKS.map((k) => [k, { lastChecked: nowMs }])
    ),
    lastRemediationAt: nowMs,
    subagentWatchdog: { lastRun: nowMs, lastLogged: {} },
  };
}

export function validateHeartbeatState(raw: unknown, nowMs = Date.now(), maxAgeMs = HEARTBEAT_MAX_AGE_MS): HeartbeatState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("state root must be object");
  }
  const root = raw as Record<string, unknown>;

  const version = Number(root.version);
  if (!Number.isFinite(version) || Math.trunc(version) < 2) {
    throw new Error("version must be >= 2");
  }

  const lastHeartbeat = parseTs(root.lastHeartbeat ?? nowMs, true);
  assertTimestampSanity("lastHeartbeat", lastHeartbeat, nowMs, maxAgeMs, true);

  const checksRaw = root.lastChecks;
  if (!checksRaw || typeof checksRaw !== "object" || Array.isArray(checksRaw)) {
    throw new Error("lastChecks must be object");
  }

  const normalizedChecks: Record<string, LastCheck> = {};
  for (const key of HEARTBEAT_REQUIRED_CHECKS) {
    if (!(key in (checksRaw as Record<string, unknown>))) throw new Error(`missing required check: ${key}`);
    const val = (checksRaw as Record<string, unknown>)[key];
    const tsSrc = val && typeof val === "object" && !Array.isArray(val) ? (val as Record<string, unknown>).lastChecked : val;
    const ts = parseTs(tsSrc);
    assertTimestampSanity(key, ts, nowMs, maxAgeMs);
    normalizedChecks[key] = { lastChecked: ts };
  }

  const subRaw = root.subagentWatchdog;
  if (!subRaw || typeof subRaw !== "object" || Array.isArray(subRaw)) {
    throw new Error("subagentWatchdog must be object");
  }
  const sub = subRaw as Record<string, unknown>;

  const lastLoggedRaw = sub.lastLogged ?? {};
  if (!lastLoggedRaw || typeof lastLoggedRaw !== "object" || Array.isArray(lastLoggedRaw)) {
    throw new Error("subagentWatchdog.lastLogged must be object");
  }

  const normalizedLastLogged: Record<string, number> = {};
  for (const [k, v] of Object.entries(lastLoggedRaw as Record<string, unknown>)) {
    const ts = parseTs(v, true);
    assertTimestampSanity(`subagentWatchdog.lastLogged.${k}`, ts, nowMs, maxAgeMs, true);
    normalizedLastLogged[String(k)] = ts;
  }

  const lastRemediationAt = parseTs(root.lastRemediationAt ?? nowMs, true);
  assertTimestampSanity("lastRemediationAt", lastRemediationAt, nowMs, maxAgeMs, true);

  const lastRun = parseTs(sub.lastRun ?? nowMs, true);
  assertTimestampSanity("subagentWatchdog.lastRun", lastRun, nowMs, maxAgeMs, true);

  const out: HeartbeatState = {
    version: Math.trunc(version),
    lastHeartbeat,
    lastChecks: normalizedChecks,
    lastRemediationAt,
    subagentWatchdog: {
      lastRun,
      lastLogged: normalizedLastLogged,
    },
  };

  if ("lastSnapshotAt" in root) {
    const snapshot = parseTs(root.lastSnapshotAt, true);
    assertTimestampSanity("lastSnapshotAt", snapshot, nowMs, maxAgeMs, true);
    out.lastSnapshotAt = snapshot;
  }

  return out;
}

export function touchHeartbeat(state: HeartbeatState, nowMs = Date.now()): HeartbeatState {
  state.lastHeartbeat = nowMs;
  return state;
}

export function hashHeartbeatState(state: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
