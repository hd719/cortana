#!/usr/bin/env npx tsx

import fs from "node:fs";
import path from "node:path";
import {
  HEARTBEAT_MAX_AGE_MS,
  HEARTBEAT_QUIET_HOURS,
  isHeartbeatQuietHours,
  type HeartbeatState,
  validateHeartbeatState,
} from "../lib/heartbeat-schema.js";
import { defaultHeartbeatStatePath } from "../lib/paths.js";

export type HeartbeatHealthStatus = "healthy" | "stale" | "invalid" | "missing";

export type HeartbeatHealthResult = {
  ok: boolean;
  status: HeartbeatHealthStatus;
  statePath: string;
  freshnessThresholdMs: number;
  checkedAt: string;
  quietHours: boolean;
  quietHoursGrace: boolean;
  lastHeartbeat?: string;
  lastHeartbeatAgeMs?: number;
  freshnessSource?: string;
  summary: string;
  error?: string;
};

export type RuntimeHeartbeatSignal = {
  timestampMs: number;
  source: string;
};

type Args = {
  json: boolean;
  stateFile: string;
  freshnessThresholdMs: number;
  runtimeSessionFile: string;
  runtimeFallback: boolean;
};

const DEFAULT_FRESHNESS_THRESHOLD_MS = 45 * 60 * 1000;
const DEFAULT_RUNTIME_SESSION_KEY = "agent:main:main";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Args {
  let json = false;
  let stateFile = env.HEARTBEAT_STATE_FILE || defaultHeartbeatStatePath();
  let runtimeSessionFile =
    env.HEARTBEAT_RUNTIME_SESSION_FILE ||
    path.join(
      path.dirname(path.dirname(defaultHeartbeatStatePath())),
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
  let runtimeFallback = env.HEARTBEAT_RUNTIME_SESSION_FALLBACK !== "0";
  let freshnessThresholdMs = parsePositiveInt(
    env.HEARTBEAT_HEALTH_MAX_AGE_MS,
    DEFAULT_FRESHNESS_THRESHOLD_MS,
  );

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--state-file" && argv[i + 1]) {
      stateFile = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--runtime-session-file" && argv[i + 1]) {
      runtimeSessionFile = path.resolve(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--no-runtime-fallback") {
      runtimeFallback = false;
      continue;
    }
    if (arg === "--threshold-ms" && argv[i + 1]) {
      freshnessThresholdMs = parsePositiveInt(argv[i + 1], freshnessThresholdMs);
      i += 1;
    }
  }

  return { json, stateFile, freshnessThresholdMs, runtimeSessionFile, runtimeFallback };
}

function resolveLatestCanonicalHeartbeat(state: HeartbeatState): {
  timestampMs: number;
  source: string;
} {
  let latestMs = state.lastHeartbeat;
  let source = "lastHeartbeat";

  for (const [key, check] of Object.entries(state.lastChecks)) {
    if (check.lastChecked > latestMs) {
      latestMs = check.lastChecked;
      source = `lastChecks.${key}`;
    }
  }

  return {
    timestampMs: latestMs,
    source,
  };
}

function getEtClockMinutes(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: HEARTBEAT_QUIET_HOURS.tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function isHeartbeatQuietHoursGrace(now: Date, freshnessThresholdMs: number): boolean {
  if (isHeartbeatQuietHours(now)) return true;
  const quietEndMinutes = HEARTBEAT_QUIET_HOURS.endHour * 60;
  const elapsedMs = (getEtClockMinutes(now) - quietEndMinutes) * 60 * 1000;
  return elapsedMs >= 0 && elapsedMs <= freshnessThresholdMs;
}

export function evaluateHeartbeatHealth(
  rawState: string | null,
  opts?: {
    nowMs?: number;
    statePath?: string;
    freshnessThresholdMs?: number;
    runtimeHeartbeatSignal?: RuntimeHeartbeatSignal | null;
  },
): HeartbeatHealthResult {
  const nowMs = opts?.nowMs ?? Date.now();
  const statePath = opts?.statePath ?? "heartbeat-state.json";
  const freshnessThresholdMs =
    opts?.freshnessThresholdMs ?? DEFAULT_FRESHNESS_THRESHOLD_MS;
  const checkedAt = new Date(nowMs).toISOString();
  const checkedDate = new Date(nowMs);
  const quietHours = isHeartbeatQuietHours(checkedDate);
  const quietHoursGrace = isHeartbeatQuietHoursGrace(checkedDate, freshnessThresholdMs);
  const runtimeHeartbeatSignal = opts?.runtimeHeartbeatSignal ?? null;

  const runtimeFallbackResult = (): HeartbeatHealthResult | null => {
    if (runtimeHeartbeatSignal == null) return null;
    const runtimeAgeMs = Math.max(0, nowMs - runtimeHeartbeatSignal.timestampMs);
    if (runtimeAgeMs > freshnessThresholdMs) return null;
    return {
      ok: true,
      status: "healthy",
      statePath,
      freshnessThresholdMs,
      checkedAt,
      quietHours,
      quietHoursGrace,
      lastHeartbeat: new Date(runtimeHeartbeatSignal.timestampMs).toISOString(),
      lastHeartbeatAgeMs: runtimeAgeMs,
      freshnessSource: runtimeHeartbeatSignal.source,
      summary: "OpenClaw runtime heartbeat session is fresh; canonical heartbeat state is stale",
    };
  };

  if (rawState == null) {
    return {
      ok: false,
      status: "missing",
      statePath,
      freshnessThresholdMs,
      checkedAt,
      quietHours,
      quietHoursGrace,
      summary: "canonical heartbeat state missing",
      error: "state file not found",
    };
  }

  try {
    const parsed = JSON.parse(rawState) as unknown;
    const state = validateHeartbeatState(parsed, nowMs, HEARTBEAT_MAX_AGE_MS);
    const latestCanonicalHeartbeat = resolveLatestCanonicalHeartbeat(state);
    const lastHeartbeatAgeMs = Math.max(0, nowMs - latestCanonicalHeartbeat.timestampMs);
    const lastHeartbeat = new Date(latestCanonicalHeartbeat.timestampMs).toISOString();

    if (lastHeartbeatAgeMs > freshnessThresholdMs) {
      if (quietHoursGrace) {
        return {
          ok: true,
          status: "healthy",
          statePath,
          freshnessThresholdMs,
          checkedAt,
          quietHours,
          quietHoursGrace,
          lastHeartbeat,
          lastHeartbeatAgeMs,
          freshnessSource: latestCanonicalHeartbeat.source,
          summary: quietHours
            ? "canonical heartbeat state is stale during quiet hours"
            : "canonical heartbeat state is stale during post-quiet grace",
        };
      }

      const fallback = runtimeFallbackResult();
      if (fallback) return fallback;

      return {
        ok: false,
        status: "stale",
        statePath,
        freshnessThresholdMs,
        checkedAt,
        quietHours,
        quietHoursGrace,
        lastHeartbeat,
        lastHeartbeatAgeMs,
        freshnessSource: latestCanonicalHeartbeat.source,
        summary: "canonical heartbeat state is stale",
        error: `lastHeartbeat age ${lastHeartbeatAgeMs}ms exceeds freshness threshold ${freshnessThresholdMs}ms`,
      };
    }

    return {
      ok: true,
      status: "healthy",
      statePath,
      freshnessThresholdMs,
      checkedAt,
      quietHours,
      quietHoursGrace,
      lastHeartbeat,
      lastHeartbeatAgeMs,
      freshnessSource: latestCanonicalHeartbeat.source,
      summary: "canonical heartbeat state is fresh and valid",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: "invalid",
      statePath,
      freshnessThresholdMs,
      checkedAt,
      quietHours,
      quietHoursGrace,
      summary: "canonical heartbeat state is invalid",
      error: message,
    };
  }
}

function readOpenClawRuntimeHeartbeatSignal(
  sessionFile: string,
  nowMs: number,
): RuntimeHeartbeatSignal | null {
  if (!fs.existsSync(sessionFile)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(sessionFile, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const root = parsed as Record<string, unknown>;
    const mainSession = root[DEFAULT_RUNTIME_SESSION_KEY];
    if (!mainSession || typeof mainSession !== "object" || Array.isArray(mainSession)) {
      return null;
    }

    const updatedAt = (mainSession as Record<string, unknown>).updatedAt;
    if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;
    const timestampMs = Math.trunc(updatedAt);
    if (timestampMs <= 0 || timestampMs > nowMs + 5 * 60 * 1000) return null;

    return {
      timestampMs,
      source: `openclawSessions.${DEFAULT_RUNTIME_SESSION_KEY}`,
    };
  } catch {
    return null;
  }
}

export function renderHeartbeatHealth(result: HeartbeatHealthResult): string {
  const agePart =
    result.lastHeartbeatAgeMs == null
      ? ""
      : ` age_ms=${result.lastHeartbeatAgeMs}`;
  const lastHeartbeatPart = result.lastHeartbeat
    ? ` last_heartbeat=${result.lastHeartbeat}`
    : "";
  const sourcePart = result.freshnessSource ? ` source=${result.freshnessSource}` : "";
  const quietHoursPart = ` quiet_hours=${result.quietHours ? "yes" : "no"}`;
  const quietHoursGracePart = ` quiet_hours_grace=${result.quietHoursGrace ? "yes" : "no"}`;
  const errorPart = result.error ? ` error=${JSON.stringify(result.error)}` : "";

  return `${result.ok ? "HEALTHY" : "UNHEALTHY"} heartbeat_state status=${result.status} path=${JSON.stringify(
    result.statePath,
  )}${agePart}${lastHeartbeatPart}${sourcePart}${quietHoursPart}${quietHoursGracePart}${errorPart}`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2), process.env);
  const nowMs = Date.now();
  const rawState = fs.existsSync(args.stateFile)
    ? fs.readFileSync(args.stateFile, "utf8")
    : null;
  const runtimeHeartbeatSignal = args.runtimeFallback
    ? readOpenClawRuntimeHeartbeatSignal(args.runtimeSessionFile, nowMs)
    : null;
  const result = evaluateHeartbeatHealth(rawState, {
    nowMs,
    statePath: args.stateFile,
    freshnessThresholdMs: args.freshnessThresholdMs,
    runtimeHeartbeatSignal,
  });

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderHeartbeatHealth(result));

  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
