#!/usr/bin/env npx tsx

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HEARTBEAT_MAX_AGE_MS,
  isHeartbeatQuietHours,
  type HeartbeatState,
  validateHeartbeatState,
} from "../lib/heartbeat-schema.js";

export type HeartbeatHealthStatus = "healthy" | "stale" | "invalid" | "missing";

export type HeartbeatHealthResult = {
  ok: boolean;
  status: HeartbeatHealthStatus;
  statePath: string;
  freshnessThresholdMs: number;
  checkedAt: string;
  quietHours: boolean;
  lastHeartbeat?: string;
  lastHeartbeatAgeMs?: number;
  freshnessSource?: string;
  summary: string;
  error?: string;
};

type Args = {
  json: boolean;
  stateFile: string;
  freshnessThresholdMs: number;
};

const DEFAULT_FRESHNESS_THRESHOLD_MS = 45 * 60 * 1000;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Args {
  let json = false;
  let stateFile =
    env.HEARTBEAT_STATE_FILE ||
    path.join(os.homedir(), ".openclaw", "memory", "heartbeat-state.json");
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
    if (arg === "--threshold-ms" && argv[i + 1]) {
      freshnessThresholdMs = parsePositiveInt(argv[i + 1], freshnessThresholdMs);
      i += 1;
    }
  }

  return { json, stateFile, freshnessThresholdMs };
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

export function evaluateHeartbeatHealth(
  rawState: string | null,
  opts?: {
    nowMs?: number;
    statePath?: string;
    freshnessThresholdMs?: number;
  },
): HeartbeatHealthResult {
  const nowMs = opts?.nowMs ?? Date.now();
  const statePath = opts?.statePath ?? "heartbeat-state.json";
  const freshnessThresholdMs =
    opts?.freshnessThresholdMs ?? DEFAULT_FRESHNESS_THRESHOLD_MS;
  const checkedAt = new Date(nowMs).toISOString();
  const quietHours = isHeartbeatQuietHours(new Date(nowMs));

  if (rawState == null) {
    return {
      ok: false,
      status: "missing",
      statePath,
      freshnessThresholdMs,
      checkedAt,
      quietHours,
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
      return {
        ok: false,
        status: "stale",
        statePath,
        freshnessThresholdMs,
        checkedAt,
        quietHours,
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
      summary: "canonical heartbeat state is invalid",
      error: message,
    };
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
  const errorPart = result.error ? ` error=${JSON.stringify(result.error)}` : "";

  return `${result.ok ? "HEALTHY" : "UNHEALTHY"} heartbeat_state status=${result.status} path=${JSON.stringify(
    result.statePath,
  )}${agePart}${lastHeartbeatPart}${sourcePart}${quietHoursPart}${errorPart}`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2), process.env);
  const rawState = fs.existsSync(args.stateFile)
    ? fs.readFileSync(args.stateFile, "utf8")
    : null;
  const result = evaluateHeartbeatHealth(rawState, {
    nowMs: Date.now(),
    statePath: args.stateFile,
    freshnessThresholdMs: args.freshnessThresholdMs,
  });

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderHeartbeatHealth(result));

  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
