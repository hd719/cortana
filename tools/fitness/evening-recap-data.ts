#!/usr/bin/env npx tsx

import fs from "node:fs";
import { spawnSync } from "node:child_process";

type JsonObject = Record<string, any>;

type TonalWorkoutSummary = {
  id: string;
  time: string;
  volume: number | null;
  duration_minutes: number | null;
  title: string | null;
};

function curlJson(url: string, timeoutSec: number): unknown {
  const r = spawnSync("curl", ["-s", "--max-time", String(timeoutSec), url], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if ((r.status ?? 1) !== 0) return {};
  try {
    return JSON.parse((r.stdout ?? "").trim() || "{}");
  } catch {
    return {};
  }
}

function toObj(v: unknown): JsonObject {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : {};
}

export function tonalWorkoutsFromPayload(payload: unknown): JsonObject[] {
  const tonal = toObj(payload);
  const raw = tonal.workouts;
  if (Array.isArray(raw)) {
    return raw.map((x) => toObj(x)).filter((x) => Object.keys(x).length > 0);
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([id, value]) => {
      const obj = toObj(value);
      return { id, ...obj };
    });
  }
  return [];
}

function localTodayYmd(timeZone = "America/New_York"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function tonalTodayWorkouts(payload: unknown, today = localTodayYmd()): TonalWorkoutSummary[] {
  return tonalWorkoutsFromPayload(payload)
    .filter((workout) => String(workout.beginTime ?? "").slice(0, 10) === today)
    .sort((a, b) => String(a.beginTime ?? "").localeCompare(String(b.beginTime ?? "")))
    .map((workout) => {
      const stats = toObj(workout.stats);
      const detail = toObj(workout.detail);
      return {
        id: String(workout.id ?? workout.activityId ?? ""),
        time: String(workout.beginTime ?? ""),
        volume: Number.isFinite(Number(stats.totalVolume))
          ? Number(stats.totalVolume)
          : Number.isFinite(Number(workout.totalVolume))
            ? Number(workout.totalVolume)
            : null,
        duration_minutes: Number.isFinite(Number(workout.duration)) ? Math.round(Number(workout.duration) / 60) : null,
        title: typeof detail.title === "string" ? detail.title : null,
      };
    });
}

function main(): void {
  const tonal = curlJson("http://127.0.0.1:3033/tonal/data", 10);
  const today = localTodayYmd();
  const todayWorkouts = tonalTodayWorkouts(tonal, today);
  const out = {
    timestamp: new Date().toISOString(),
    tonal_health: { status: "unknown" },
    whoop_recovery_latest: null,
    whoop_sleep_latest: null,
    whoop_today_workouts: [],
    tonal_today_workouts: todayWorkouts,
    whoop_weekly: null,
    tonal_weekly: null,
    pending_health_insights: [],
    errors: [],
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
