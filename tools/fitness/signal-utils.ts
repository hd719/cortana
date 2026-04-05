import { resolveTonalMovement, type TonalMovementResolution } from "./tonal-movement-map.js";

type JsonObject = Record<string, unknown>;

export type ReadinessBand = "green" | "yellow" | "red" | "unknown";

export type RecoveryEntry = {
  date: string;
  createdAt: string | null;
  recoveryScore: number | null;
  hrv: number | null;
  rhr: number | null;
};

export type SleepEntry = {
  date: string;
  createdAt: string | null;
  sleepPerformance: number | null;
  sleepEfficiency: number | null;
  sleepHours: number | null;
};

export type WorkoutEntry = {
  date: string;
  start: string | null;
  sport: string;
  strain: number | null;
  avgHr: number | null;
};

export type DailyStepSummary = {
  stepCount: number | null;
  source: "cycle" | "workouts_sum" | "steps_collection" | null;
};

export type TrendSnapshot = {
  latest: number | null;
  baseline7: number | null;
  delta: number | null;
  deltaPct: number | null;
};

export type ReadinessSignal = {
  band: ReadinessBand;
  confidence: number;
  reason: string;
  hardTruth: string;
  action: string;
  riskFlags: string[];
};

export type WhoopWeeklySummary = {
  daysWithRecovery: number;
  avgRecovery: number | null;
  avgHrv: number | null;
  avgRhr: number | null;
  daysWithSleep: number;
  avgSleepPerformance: number | null;
  avgSleepEfficiency: number | null;
  avgSleepHours: number | null;
  workouts: number;
  avgStrain: number | null;
  totalStrain: number | null;
  lowRecoveryDays: number;
};

export type TonalWorkoutSummary = {
  id: string;
  time: string;
  volume: number | null;
  durationMinutes: number | null;
  title: string | null;
};

export type TonalLoadBucket = "unknown" | "light" | "moderate" | "heavy" | "very_heavy";
export type TonalRepBucket = "unknown" | "very_low" | "low" | "moderate" | "high";

export type TonalSetActivity = {
  sourcePath: string;
  workoutId: string | null;
  setId: string | null;
  movementId: string | null;
  movementTitle: string | null;
  reps: number | null;
  load: number | null;
  volume: number | null;
  loadBucket: TonalLoadBucket;
  repBucket: TonalRepBucket;
  muscleGroup: TonalMovementResolution["muscleGroup"];
  pattern: TonalMovementResolution["pattern"];
  confidence: number;
  mapped: boolean;
  unmappedReason: string | null;
  raw: JsonObject;
};

export type TonalWeeklySummary = {
  workouts: number;
  totalVolume: number | null;
  avgVolume: number | null;
  avgDurationMinutes: number | null;
};

function toObj(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function toArr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.+-]/g, "");
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toIsoDate(time: string | null, timeZone = "America/New_York"): string {
  if (!time) return "";
  const d = new Date(time);
  if (Number.isNaN(d.getTime())) return String(time).slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function safeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const ts = new Date(value);
  if (Number.isNaN(ts.getTime())) return null;
  return value;
}

export function localYmd(timeZone = "America/New_York", now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function daysAgoYmd(days: number, timeZone = "America/New_York", now = new Date()): string {
  const d = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return localYmd(timeZone, d);
}

function average(values: Array<number | null>): number | null {
  const nums = values.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  if (!nums.length) return null;
  const total = nums.reduce((sum, n) => sum + n, 0);
  return Number((total / nums.length).toFixed(2));
}

function safeDelta(latest: number | null, baseline: number | null): number | null {
  if (latest == null || baseline == null) return null;
  return Number((latest - baseline).toFixed(2));
}

function safeDeltaPct(latest: number | null, baseline: number | null): number | null {
  if (latest == null || baseline == null || baseline === 0) return null;
  return Number((((latest - baseline) / baseline) * 100).toFixed(2));
}

function filterRecentByDate<T extends { date: string }>(rows: T[], sinceYmd: string): T[] {
  return rows.filter((row) => row.date >= sinceYmd);
}

function uniqueLatestByDate<T extends { date: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (seen.has(row.date)) continue;
    seen.add(row.date);
    out.push(row);
  }
  return out;
}

export function computeTrend(values: Array<number | null>): TrendSnapshot {
  const latest = values.length > 0 ? values[0] ?? null : null;
  const baselineWindow = values.slice(1, 8);
  const baseline7 = average(baselineWindow);
  return {
    latest,
    baseline7,
    delta: safeDelta(latest, baseline7),
    deltaPct: safeDeltaPct(latest, baseline7),
  };
}

export function dataFreshnessHours(timestamp: string | null, nowMs = Date.now()): number | null {
  if (!timestamp) return null;
  const ts = new Date(timestamp).getTime();
  if (Number.isNaN(ts)) return null;
  return Number(((nowMs - ts) / (1000 * 60 * 60)).toFixed(2));
}

export function extractRecoveryEntries(payload: unknown, timeZone = "America/New_York"): RecoveryEntry[] {
  const root = toObj(payload);
  return toArr(root.recovery)
    .map((item) => {
      const row = toObj(item);
      const score = toObj(row.score);
      const createdAt = safeTimestamp(row.created_at);
      return {
        date: toIsoDate(createdAt, timeZone),
        createdAt,
        recoveryScore: toNumber(score.recovery_score),
        hrv: toNumber(score.hrv_rmssd_milli),
        rhr: toNumber(score.resting_heart_rate),
      };
    })
    .filter((row) => row.date.length > 0)
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

export function extractSleepEntries(payload: unknown, timeZone = "America/New_York"): SleepEntry[] {
  const root = toObj(payload);
  return toArr(root.sleep)
    .map((item) => {
      const row = toObj(item);
      const score = toObj(row.score);
      const stage = toObj(score.stage_summary);
      const createdAt = safeTimestamp(row.created_at);
      const totalSleepMs = toNumber(stage.total_light_sleep_time_milli) ?? 0;
      const remMs = toNumber(stage.total_rem_sleep_time_milli) ?? 0;
      const deepMs = toNumber(stage.total_slow_wave_sleep_time_milli) ?? 0;
      const sleepHours = (totalSleepMs + remMs + deepMs) > 0 ? (totalSleepMs + remMs + deepMs) / 3_600_000 : null;
      return {
        date: toIsoDate(createdAt, timeZone),
        createdAt,
        sleepPerformance: toNumber(score.sleep_performance_percentage),
        sleepEfficiency: toNumber(score.sleep_efficiency_percentage),
        sleepHours: sleepHours == null ? null : Number(sleepHours.toFixed(2)),
      };
    })
    .filter((row) => row.date.length > 0)
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

export function extractWhoopWorkouts(payload: unknown, timeZone = "America/New_York"): WorkoutEntry[] {
  const root = toObj(payload);
  return toArr(root.workouts)
    .map((item) => {
      const row = toObj(item);
      const score = toObj(row.score);
      const start = safeTimestamp(row.start);
      return {
        date: toIsoDate(start, timeZone),
        start,
        sport: String(row.sport_name ?? "activity"),
        strain: toNumber(score.strain),
        avgHr: toNumber(score.average_heart_rate),
      };
    })
    .filter((row) => row.date.length > 0)
    .sort((a, b) => String(b.start ?? "").localeCompare(String(a.start ?? "")));
}

function toRoundedInt(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

function sumNumbers(values: Array<number | null>): number | null {
  const nums = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!nums.length) return null;
  return nums.reduce((total, value) => total + value, 0);
}

function firstString(...values: Array<unknown>): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text.length > 0) return text;
  }
  return null;
}

function coalesceNumber(...values: Array<unknown>): number | null {
  for (const value of values) {
    const num = toNumber(value);
    if (num != null) return num;
  }
  return null;
}

function isSetLike(row: JsonObject): boolean {
  const hasMovementIdentity = row.movementId != null || row.movementTitle != null || row.movementName != null || row.exerciseName != null || row.exerciseTitle != null;
  const hasSetIdentity = row.setId != null || row.reps != null || row.repCount != null || row.prescribedReps != null;
  const hasLoadSignal =
    row.baseWeight != null
    || row.avgWeight != null
    || row.volume != null
    || row.totalVolume != null
    || row.weight != null
    || row.weightAtMaxConPower != null
    || row.oneRepMax != null;
  return (
    row.setId != null
    || row.movementId != null
    || row.repCount != null
    || row.reps != null
    || (hasMovementIdentity && (hasSetIdentity || hasLoadSignal))
  );
}

function collectTonalSetCandidates(value: unknown, sourcePath: string[], out: Array<{ path: string; raw: JsonObject }>): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectTonalSetCandidates(item, [...sourcePath, String(index)], out);
    });
    return;
  }
  if (!value || typeof value !== "object") return;

  const row = value as JsonObject;
  if (isSetLike(row)) {
    out.push({ path: sourcePath.join("."), raw: row });
  }

  for (const [key, child] of Object.entries(row)) {
    if (!child || typeof child !== "object") continue;
    collectTonalSetCandidates(child, [...sourcePath, key], out);
  }
}

export function tonalLoadBucket(load: number | null): TonalLoadBucket {
  if (load == null || !Number.isFinite(load)) return "unknown";
  if (load < 20) return "light";
  if (load < 40) return "moderate";
  if (load < 60) return "heavy";
  return "very_heavy";
}

export function tonalRepBucket(reps: number | null): TonalRepBucket {
  if (reps == null || !Number.isFinite(reps)) return "unknown";
  if (reps <= 4) return "very_low";
  if (reps <= 8) return "low";
  if (reps <= 12) return "moderate";
  return "high";
}

export function resolveTonalMovementToMuscle(input: {
  movementId?: string | number | null;
  movementTitle?: string | null;
  title?: string | null;
  name?: string | null;
}): TonalMovementResolution {
  return resolveTonalMovement(input);
}

export function extractTonalSetActivities(payload: unknown): TonalSetActivity[] {
  const root = toObj(payload);
  const candidates: Array<{ path: string; raw: JsonObject }> = [];
  collectTonalSetCandidates(root, [], candidates);

  const seen = new Set<string>();
  const out: TonalSetActivity[] = [];

  for (const candidate of candidates) {
    const raw = candidate.raw;
    const movementId = firstString(raw.movementId);
    const movementTitle = firstString(raw.movementTitle, raw.movementName, raw.title, raw.name, raw.exerciseName, raw.exerciseTitle);
    const workoutId = firstString(raw.workoutId, raw.workoutActivityID, raw.workoutActivityId, raw.activityId);
    const setId = firstString(raw.setId, raw.id);
    const repCount = coalesceNumber(raw.repCount, raw.reps, raw.prescribedReps, raw.durationBasedRepGoal);
    const load = coalesceNumber(raw.avgWeight, raw.baseWeight, raw.weight, raw.weightAtMaxConPower, raw.maxWeight, raw.suggestedWeight);
    const volume = coalesceNumber(raw.totalVolume, raw.volume) ?? (load != null && repCount != null ? Number((load * repCount).toFixed(2)) : null);
    const resolution = resolveTonalMovementToMuscle({
      movementId,
      movementTitle,
      title: movementTitle,
      name: movementTitle,
    });
    const dedupeKey = [candidate.path, setId ?? "", movementId ?? "", movementTitle ?? "", String(raw.beginTime ?? ""), String(raw.round ?? ""), String(raw.repetition ?? "")].join("|");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    out.push({
      sourcePath: candidate.path,
      workoutId,
      setId,
      movementId,
      movementTitle,
      reps: repCount,
      load,
      volume,
      loadBucket: tonalLoadBucket(load),
      repBucket: tonalRepBucket(repCount),
      muscleGroup: resolution.muscleGroup,
      pattern: resolution.pattern,
      confidence: resolution.confidence,
      mapped: resolution.mapped,
      unmappedReason: resolution.mapped ? null : resolution.reason,
      raw,
    });
  }

  return out;
}

export function extractDailyStepCount(payload: unknown, today = localYmd(), timeZone = "America/New_York"): DailyStepSummary {
  const root = toObj(payload);

  const stepsCollection = toArr(root.steps)
    .map((item) => {
      const row = toObj(item);
      const ts =
        safeTimestamp(row.timestamp) ??
        safeTimestamp(row.created_at) ??
        safeTimestamp(row.updated_at) ??
        safeTimestamp(row.start) ??
        (typeof row.date === "string" ? `${row.date}T12:00:00-05:00` : null);
      return {
        date: ts ? toIsoDate(ts, timeZone) : "",
        steps: toNumber(row.steps) ?? toNumber(row.step_count) ?? toNumber(row.total_steps) ?? toNumber(row.count),
      };
    })
    .filter((row) => row.date === today);
  const stepsCollectionSum = sumNumbers(stepsCollection.map((row) => row.steps));
  if (stepsCollectionSum != null) {
    return {
      stepCount: toRoundedInt(stepsCollectionSum),
      source: "steps_collection",
    };
  }

  const cycles = toArr(root.cycles)
    .map((item) => {
      const row = toObj(item);
      const score = toObj(row.score);
      const ts = safeTimestamp(row.start) ?? safeTimestamp(row.created_at) ?? safeTimestamp(row.updated_at);
      return {
        date: ts ? toIsoDate(ts, timeZone) : "",
        updated: safeTimestamp(row.updated_at) ?? safeTimestamp(row.created_at) ?? safeTimestamp(row.start) ?? "",
        steps: toNumber(score.steps) ?? toNumber(row.steps) ?? toNumber(row.step_count) ?? toNumber(row.total_steps),
      };
    })
    .filter((row) => row.date === today)
    .sort((a, b) => b.updated.localeCompare(a.updated));
  const cycleStep = cycles.find((row) => row.steps != null)?.steps ?? null;
  if (cycleStep != null) {
    return {
      stepCount: toRoundedInt(cycleStep),
      source: "cycle",
    };
  }

  const workouts = toArr(root.workouts)
    .map((item) => {
      const row = toObj(item);
      const score = toObj(row.score);
      const ts = safeTimestamp(row.start);
      return {
        date: ts ? toIsoDate(ts, timeZone) : "",
        steps: toNumber(score.steps) ?? toNumber(row.steps) ?? toNumber(row.step_count) ?? toNumber(row.total_steps),
      };
    })
    .filter((row) => row.date === today);
  const workoutStepSum = sumNumbers(workouts.map((row) => row.steps));
  if (workoutStepSum != null) {
    return {
      stepCount: toRoundedInt(workoutStepSum),
      source: "workouts_sum",
    };
  }

  return {
    stepCount: null,
    source: null,
  };
}

export function tonalWorkoutsFromPayload(payload: unknown): Array<Record<string, unknown>> {
  const root = toObj(payload);
  const workouts = root.workouts;
  if (Array.isArray(workouts)) {
    return workouts.map((item) => toObj(item)).filter((item) => Object.keys(item).length > 0);
  }
  if (workouts && typeof workouts === "object") {
    return Object.entries(workouts as Record<string, unknown>).map(([id, item]) => ({
      id,
      ...toObj(item),
    }));
  }
  return [];
}

export function tonalTodayWorkouts(payload: unknown, today = localYmd(), timeZone = "America/New_York"): TonalWorkoutSummary[] {
  return tonalWorkoutsFromPayload(payload)
    .map((item) => {
      const stats = toObj(item.stats);
      const detail = toObj(item.detail);
      const time = typeof item.beginTime === "string" ? item.beginTime : "";
      return {
        id: String(item.id ?? item.activityId ?? ""),
        time,
        volume: toNumber(stats.totalVolume) ?? toNumber(item.totalVolume),
        durationMinutes: (() => {
          const seconds = toNumber(item.duration);
          if (seconds == null) return null;
          return Math.round(seconds / 60);
        })(),
        title: typeof detail.title === "string" ? detail.title : null,
      };
    })
    .filter((item) => toIsoDate(item.time, timeZone) === today)
    .sort((a, b) => a.time.localeCompare(b.time));
}

export function summarizeWhoopWeekly(payload: unknown, today = localYmd(), timeZone = "America/New_York"): WhoopWeeklySummary {
  const anchor = new Date(`${today}T12:00:00Z`);
  const weekStart = daysAgoYmd(6, timeZone, Number.isNaN(anchor.getTime()) ? new Date() : anchor);
  const recoveries = uniqueLatestByDate(filterRecentByDate(extractRecoveryEntries(payload, timeZone), weekStart));
  const sleeps = uniqueLatestByDate(filterRecentByDate(extractSleepEntries(payload, timeZone), weekStart));
  const workouts = filterRecentByDate(extractWhoopWorkouts(payload, timeZone), weekStart);
  const strains = workouts.map((item) => item.strain);
  const totalStrain = strains.reduce((sum, n) => sum + (n ?? 0), 0);

  return {
    daysWithRecovery: new Set(recoveries.map((item) => item.date)).size,
    avgRecovery: average(recoveries.map((item) => item.recoveryScore)),
    avgHrv: average(recoveries.map((item) => item.hrv)),
    avgRhr: average(recoveries.map((item) => item.rhr)),
    daysWithSleep: new Set(sleeps.map((item) => item.date)).size,
    avgSleepPerformance: average(sleeps.map((item) => item.sleepPerformance)),
    avgSleepEfficiency: average(sleeps.map((item) => item.sleepEfficiency)),
    avgSleepHours: average(sleeps.map((item) => item.sleepHours)),
    workouts: workouts.length,
    avgStrain: average(strains),
    totalStrain: strains.length > 0 ? Number(totalStrain.toFixed(2)) : null,
    lowRecoveryDays: new Set(recoveries.filter((item) => (item.recoveryScore ?? 100) < 45).map((item) => item.date)).size,
  };
}

export function summarizeTonalWeekly(payload: unknown, timeZone = "America/New_York"): TonalWeeklySummary {
  const normalized = tonalWorkoutsFromPayload(payload)
    .map((item) => {
      const stats = toObj(item.stats);
      return {
        date: toIsoDate(typeof item.beginTime === "string" ? item.beginTime : null, timeZone),
        volume: toNumber(stats.totalVolume) ?? toNumber(item.totalVolume),
        durationMinutes: (() => {
          const seconds = toNumber(item.duration);
          if (seconds == null) return null;
          return Math.round(seconds / 60);
        })(),
      };
    })
    .filter((item) => item.date.length > 0);

  const latestDate = normalized.reduce((max, item) => (item.date > max ? item.date : max), "");
  const anchor = latestDate ? new Date(`${latestDate}T12:00:00Z`) : new Date();
  const weekStart = daysAgoYmd(6, timeZone, Number.isNaN(anchor.getTime()) ? new Date() : anchor);
  const workouts = normalized.filter((item) => item.date >= weekStart);

  const totalVolume = workouts.reduce((sum, item) => sum + (item.volume ?? 0), 0);
  return {
    workouts: workouts.length,
    totalVolume: workouts.length > 0 ? Number(totalVolume.toFixed(2)) : null,
    avgVolume: average(workouts.map((item) => item.volume)),
    avgDurationMinutes: average(workouts.map((item) => item.durationMinutes)),
  };
}

export function overreachFlags(opts: { recoveryScore: number | null; totalStrainToday: number; yesterdayStrain: number }): string[] {
  const flags: string[] = [];
  if (opts.totalStrainToday >= 15 && (opts.recoveryScore ?? 100) <= 55) {
    flags.push("high_strain_with_non_green_recovery");
  }
  if (opts.totalStrainToday >= 16 && opts.yesterdayStrain >= 14) {
    flags.push("back_to_back_heavy_strain");
  }
  if ((opts.recoveryScore ?? 100) <= 40 && opts.totalStrainToday >= 10) {
    flags.push("strain_above_recovery_tolerance");
  }
  return flags;
}

export function buildReadinessSignal(opts: {
  recoveryTrend: TrendSnapshot;
  hrvTrend: TrendSnapshot;
  rhrTrend: TrendSnapshot;
  sleepPerformance: number | null;
  freshnessHours: number | null;
  totalStrainToday: number;
  yesterdayStrain: number;
}): ReadinessSignal {
  const riskFlags: string[] = [];
  const recovery = opts.recoveryTrend.latest;
  const sleep = opts.sleepPerformance;
  const hrvDrop = opts.hrvTrend.deltaPct != null && opts.hrvTrend.deltaPct < -10;
  const rhrRise = opts.rhrTrend.delta != null && opts.rhrTrend.delta > 2;
  const staleData = opts.freshnessHours != null && opts.freshnessHours > 18;
  const overload = overreachFlags({
    recoveryScore: recovery,
    totalStrainToday: opts.totalStrainToday,
    yesterdayStrain: opts.yesterdayStrain,
  });
  riskFlags.push(...overload);
  if (staleData) riskFlags.push("stale_whoop_data");
  if ((sleep ?? 100) < 75) riskFlags.push("suboptimal_sleep_performance");
  if (hrvDrop) riskFlags.push("hrv_down_vs_baseline");
  if (rhrRise) riskFlags.push("rhr_up_vs_baseline");
  if ((recovery ?? 100) < 45) riskFlags.push("low_recovery");

  if (recovery == null) {
    return {
      band: "unknown",
      confidence: 0.35,
      reason: "Recovery signal unavailable; defaulting conservative.",
      hardTruth: "You do not have enough reliable recovery data to justify a hard session today.",
      action: "Run technique or Zone 2 only, then re-check readiness once data refreshes.",
      riskFlags,
    };
  }

  if (recovery < 45 || (sleep != null && sleep < 72) || overload.length > 0) {
    return {
      band: "red",
      confidence: staleData ? 0.62 : 0.8,
      reason: "Recovery-risk profile is below training tolerance for high intensity.",
      hardTruth: "Pushing intensity today is more likely to dig fatigue than build adaptation.",
      action: "Cap effort to recovery work, mobility, and low-intensity conditioning.",
      riskFlags,
    };
  }

  if (recovery < 70 || (sleep != null && sleep < 82) || hrvDrop || rhrRise) {
    return {
      band: "yellow",
      confidence: staleData ? 0.64 : 0.84,
      reason: "Moderate readiness: training is viable only with controlled intensity.",
      hardTruth: "You can train today, but volume or ego intensity will likely cost tomorrow.",
      action: "Keep intensity controlled and prioritize quality reps over volume.",
      riskFlags,
    };
  }

  return {
    band: "green",
    confidence: staleData ? 0.65 : 0.9,
    reason: "Recovery and supporting signals are in a stable range for progressive work.",
    hardTruth: "Green does not mean unlimited volume; execution quality still decides adaptation.",
    action: "Execute planned progression, then stop once quality drops.",
    riskFlags,
  };
}

export function buildTomorrowOutlook(opts: {
  readiness: ReadinessSignal;
  totalStrainToday: number;
  sleepPerformance: number | null;
}): { expectedBand: ReadinessBand; rationale: string; action: string } {
  if (opts.readiness.band === "red" || opts.totalStrainToday >= 16) {
    return {
      expectedBand: "yellow",
      rationale: "Today’s load/recovery mix is likely to suppress tomorrow unless sleep quality rebounds.",
      action: "Target an early sleep window and plan a controlled session tomorrow morning.",
    };
  }
  if (opts.readiness.band === "yellow") {
    return {
      expectedBand: "yellow",
      rationale: "Moderate readiness usually persists unless sleep is exceptionally strong tonight.",
      action: "Keep tomorrow flexible: progress only if morning recovery clears green.",
    };
  }
  if ((opts.sleepPerformance ?? 0) < 80) {
    return {
      expectedBand: "yellow",
      rationale: "Sleep quality is the limiter; tomorrow depends on better recovery overnight.",
      action: "Protect sleep consistency tonight and avoid late high-stress activity.",
    };
  }
  return {
    expectedBand: "green",
    rationale: "Current signals support another productive day if recovery hygiene stays consistent.",
    action: "Proceed with planned training and keep post-session recovery disciplined.",
  };
}
