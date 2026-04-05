import { runPsql } from "../lib/db.js";

export type AthleteStatePhaseMode = "maintenance" | "lean_gain" | "gentle_cut" | "aggressive_cut" | "unknown";
export type AthleteStateRecommendationMode = "push" | "controlled_train" | "zone2_technique" | "recover";

export type AthleteStateDailyInput = {
  stateDate: string;
  generatedAt?: string | null;
  readinessScore?: number | null;
  readinessBand?: "green" | "yellow" | "red" | "unknown" | null;
  readinessConfidence?: number | null;
  sleepHours?: number | null;
  sleepPerformance?: number | null;
  hrv?: number | null;
  rhr?: number | null;
  whoopStrain?: number | null;
  whoopWorkouts?: number | null;
  stepCount?: number | null;
  stepSource?: string | null;
  tonalSessions?: number | null;
  tonalVolume?: number | null;
  cardioMinutes?: number | null;
  cardioSummary?: Record<string, unknown> | null;
  bodyWeightKg?: number | null;
  bodyWeightSource?: string | null;
  bodyWeightConfidence?: number | null;
  activeEnergyKcal?: number | null;
  restingEnergyKcal?: number | null;
  walkingRunningDistanceKm?: number | null;
  bodyFatPct?: number | null;
  leanMassKg?: number | null;
  healthSourceConfidence?: number | null;
  healthContext?: Record<string, unknown> | null;
  phaseMode?: AthleteStatePhaseMode | null;
  targetWeightDeltaPctWeek?: number | null;
  fatigueDebt?: number | null;
  sleepDebt?: number | null;
  progressionMomentum?: number | null;
  trainingContext?: Record<string, unknown> | null;
  proteinG?: number | null;
  proteinTargetG?: number | null;
  caloriesKcal?: number | null;
  carbsG?: number | null;
  fatG?: number | null;
  hydrationLiters?: number | null;
  nutritionConfidence?: "high" | "medium" | "low" | null;
  recommendationMode?: AthleteStateRecommendationMode | null;
  recommendationConfidence?: number | null;
  qualityFlags?: Record<string, unknown> | null;
  sourceRefs?: Record<string, unknown> | null;
  raw?: Record<string, unknown> | null;
};

export type MuscleVolumeDailyInput = {
  stateDate: string;
  muscleGroup: string;
  directSets?: number | null;
  indirectSets?: number | null;
  hardSets?: number | null;
  sessions?: number | null;
  loadBucketSummary?: Record<string, unknown> | null;
  repBucketSummary?: Record<string, unknown> | null;
  rirEstimateAvg?: number | null;
  sourceConfidence?: number | null;
  weeklyRollupSets?: number | null;
  weeklyStatus?: string | null;
  targetSetsMin?: number | null;
  targetSetsMax?: number | null;
  notes?: Record<string, unknown> | null;
};

export type AthleteStateDailyRow = {
  state_date: string;
  generated_at: string;
  readiness_score: number | null;
  readiness_band: string | null;
  readiness_confidence: number | null;
  sleep_hours: number | null;
  sleep_performance: number | null;
  hrv: number | null;
  rhr: number | null;
  whoop_strain: number | null;
  whoop_workouts: number | null;
  step_count: number | null;
  step_source: string | null;
  tonal_sessions: number | null;
  tonal_volume: number | null;
  cardio_minutes: number | null;
  cardio_summary: Record<string, unknown>;
  body_weight_kg: number | null;
  body_weight_source: string | null;
  body_weight_confidence: number | null;
  active_energy_kcal: number | null;
  resting_energy_kcal: number | null;
  walking_running_distance_km: number | null;
  body_fat_pct: number | null;
  lean_mass_kg: number | null;
  health_source_confidence: number | null;
  health_context: Record<string, unknown>;
  phase_mode: string | null;
  target_weight_delta_pct_week: number | null;
  fatigue_debt: number | null;
  sleep_debt: number | null;
  progression_momentum: number | null;
  training_context: Record<string, unknown>;
  protein_g: number | null;
  protein_target_g: number | null;
  calories_kcal: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  hydration_liters: number | null;
  nutrition_confidence: string | null;
  recommendation_mode: string | null;
  recommendation_confidence: number | null;
  quality_flags: Record<string, unknown>;
  source_refs: Record<string, unknown>;
  raw: Record<string, unknown>;
};

export type MuscleVolumeDailyRow = {
  state_date: string;
  muscle_group: string;
  direct_sets: number | null;
  indirect_sets: number | null;
  hard_sets: number | null;
  sessions: number | null;
  load_bucket_summary: Record<string, unknown>;
  rep_bucket_summary: Record<string, unknown>;
  rir_estimate_avg: number | null;
  source_confidence: number | null;
  weekly_rollup_sets: number | null;
  weekly_status: string | null;
  target_sets_min: number | null;
  target_sets_max: number | null;
  notes: Record<string, unknown>;
};

type UpsertResult = {
  ok: boolean;
  error?: string;
};

let schemaEnsured = false;
const ATHLETE_STATE_SCHEMA_LOCK_KEY = 732041905;

function esc(value: string): string {
  return value.replace(/'/g, "''");
}

function sqlText(value: string | null | undefined): string {
  if (value == null || value.length === 0) return "NULL";
  return `'${esc(value)}'`;
}

function sqlNum(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "NULL";
  return String(value);
}

function sqlInt(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "NULL";
  return String(Math.trunc(value));
}

function sqlJson(value: Record<string, unknown> | null | undefined): string {
  if (!value || typeof value !== "object") return "'{}'::jsonb";
  return `'${esc(JSON.stringify(value))}'::jsonb`;
}

function parseJsonValue<T>(raw: string, fallback: T): T {
  const text = String(raw ?? "").trim();
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function buildAthleteStateSchemaSql(): string {
  return `
CREATE TABLE IF NOT EXISTS cortana_fitness_athlete_state_daily (
  state_date DATE PRIMARY KEY,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  readiness_score NUMERIC(6,2),
  readiness_band TEXT,
  readiness_confidence NUMERIC(4,3),
  sleep_hours NUMERIC(6,2),
  sleep_performance NUMERIC(6,2),
  hrv NUMERIC(8,2),
  rhr NUMERIC(8,2),
  whoop_strain NUMERIC(8,2),
  whoop_workouts INT,
  step_count INT,
  step_source TEXT,
  tonal_sessions INT,
  tonal_volume NUMERIC(12,2),
  cardio_minutes NUMERIC(8,2),
  cardio_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  body_weight_kg NUMERIC(6,2),
  body_weight_source TEXT,
  body_weight_confidence NUMERIC(4,3),
  active_energy_kcal NUMERIC(8,2),
  resting_energy_kcal NUMERIC(8,2),
  walking_running_distance_km NUMERIC(8,2),
  body_fat_pct NUMERIC(6,3),
  lean_mass_kg NUMERIC(8,2),
  health_source_confidence NUMERIC(4,3),
  health_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  phase_mode TEXT,
  target_weight_delta_pct_week NUMERIC(6,3),
  fatigue_debt NUMERIC(6,2),
  sleep_debt NUMERIC(6,2),
  progression_momentum NUMERIC(6,2),
  training_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  protein_g NUMERIC(8,2),
  protein_target_g NUMERIC(8,2),
  calories_kcal NUMERIC(8,2),
  carbs_g NUMERIC(8,2),
  fat_g NUMERIC(8,2),
  hydration_liters NUMERIC(8,3),
  nutrition_confidence TEXT,
  recommendation_mode TEXT,
  recommendation_confidence NUMERIC(4,3),
  quality_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_refs JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_athlete_state_generated_at ON cortana_fitness_athlete_state_daily(generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_athlete_state_phase_mode ON cortana_fitness_athlete_state_daily(phase_mode);

ALTER TABLE cortana_fitness_athlete_state_daily ADD COLUMN IF NOT EXISTS fatigue_debt NUMERIC(6,2);
ALTER TABLE cortana_fitness_athlete_state_daily ADD COLUMN IF NOT EXISTS sleep_debt NUMERIC(6,2);
ALTER TABLE cortana_fitness_athlete_state_daily ADD COLUMN IF NOT EXISTS progression_momentum NUMERIC(6,2);
ALTER TABLE cortana_fitness_athlete_state_daily ADD COLUMN IF NOT EXISTS training_context JSONB NOT NULL DEFAULT '{}'::jsonb;
`;
}

export function buildMuscleVolumeSchemaSql(): string {
  return `
CREATE TABLE IF NOT EXISTS cortana_fitness_muscle_volume_daily (
  state_date DATE NOT NULL,
  muscle_group TEXT NOT NULL,
  direct_sets NUMERIC(6,2),
  indirect_sets NUMERIC(6,2),
  hard_sets NUMERIC(6,2),
  sessions INT,
  load_bucket_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  rep_bucket_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  rir_estimate_avg NUMERIC(4,2),
  source_confidence NUMERIC(4,3),
  weekly_rollup_sets NUMERIC(6,2),
  weekly_status TEXT,
  target_sets_min NUMERIC(6,2),
  target_sets_max NUMERIC(6,2),
  notes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (state_date, muscle_group)
);

CREATE INDEX IF NOT EXISTS idx_muscle_volume_state_date ON cortana_fitness_muscle_volume_daily(state_date DESC);
CREATE INDEX IF NOT EXISTS idx_muscle_volume_group ON cortana_fitness_muscle_volume_daily(muscle_group);

ALTER TABLE cortana_fitness_muscle_volume_daily ADD COLUMN IF NOT EXISTS weekly_rollup_sets NUMERIC(6,2);
ALTER TABLE cortana_fitness_muscle_volume_daily ADD COLUMN IF NOT EXISTS weekly_status TEXT;
ALTER TABLE cortana_fitness_muscle_volume_daily ADD COLUMN IF NOT EXISTS target_sets_min NUMERIC(6,2);
ALTER TABLE cortana_fitness_muscle_volume_daily ADD COLUMN IF NOT EXISTS target_sets_max NUMERIC(6,2);
`;
}

function ensureAthleteStateSchema(): void {
  if (schemaEnsured) return;
  const result = runPsql(`
SELECT pg_advisory_lock(${ATHLETE_STATE_SCHEMA_LOCK_KEY});
${buildAthleteStateSchemaSql()}
${buildMuscleVolumeSchemaSql()}
SELECT pg_advisory_unlock(${ATHLETE_STATE_SCHEMA_LOCK_KEY});
`);
  if (result.status !== 0) {
    throw new Error((result.stderr || "failed to ensure athlete-state schema").trim());
  }
  schemaEnsured = true;
}

export function buildUpsertAthleteStateSql(input: AthleteStateDailyInput): string {
  return `
INSERT INTO cortana_fitness_athlete_state_daily (
  state_date, generated_at, readiness_score, readiness_band, readiness_confidence,
  sleep_hours, sleep_performance, hrv, rhr, whoop_strain, whoop_workouts, step_count,
  step_source, tonal_sessions, tonal_volume, cardio_minutes, cardio_summary, body_weight_kg,
  body_weight_source, body_weight_confidence, active_energy_kcal, resting_energy_kcal,
  walking_running_distance_km, body_fat_pct, lean_mass_kg, health_source_confidence, health_context,
  phase_mode, target_weight_delta_pct_week, fatigue_debt, sleep_debt, progression_momentum, training_context,
  protein_g, protein_target_g, calories_kcal, carbs_g,
  fat_g, hydration_liters, nutrition_confidence, recommendation_mode, recommendation_confidence,
  quality_flags, source_refs, raw
) VALUES (
  ${sqlText(input.stateDate)}::date,
  COALESCE(${sqlText(input.generatedAt ?? null)}::timestamptz, NOW()),
  ${sqlNum(input.readinessScore)},
  ${sqlText(input.readinessBand ?? null)},
  ${sqlNum(input.readinessConfidence)},
  ${sqlNum(input.sleepHours)},
  ${sqlNum(input.sleepPerformance)},
  ${sqlNum(input.hrv)},
  ${sqlNum(input.rhr)},
  ${sqlNum(input.whoopStrain)},
  ${sqlInt(input.whoopWorkouts)},
  ${sqlInt(input.stepCount)},
  ${sqlText(input.stepSource ?? null)},
  ${sqlInt(input.tonalSessions)},
  ${sqlNum(input.tonalVolume)},
  ${sqlNum(input.cardioMinutes)},
  ${sqlJson(input.cardioSummary ?? null)},
  ${sqlNum(input.bodyWeightKg)},
  ${sqlText(input.bodyWeightSource ?? null)},
  ${sqlNum(input.bodyWeightConfidence)},
  ${sqlNum(input.activeEnergyKcal)},
  ${sqlNum(input.restingEnergyKcal)},
  ${sqlNum(input.walkingRunningDistanceKm)},
  ${sqlNum(input.bodyFatPct)},
  ${sqlNum(input.leanMassKg)},
  ${sqlNum(input.healthSourceConfidence)},
  ${sqlJson(input.healthContext ?? null)},
  ${sqlText(input.phaseMode ?? null)},
  ${sqlNum(input.targetWeightDeltaPctWeek)},
  ${sqlNum(input.fatigueDebt)},
  ${sqlNum(input.sleepDebt)},
  ${sqlNum(input.progressionMomentum)},
  ${sqlJson(input.trainingContext ?? null)},
  ${sqlNum(input.proteinG)},
  ${sqlNum(input.proteinTargetG)},
  ${sqlNum(input.caloriesKcal)},
  ${sqlNum(input.carbsG)},
  ${sqlNum(input.fatG)},
  ${sqlNum(input.hydrationLiters)},
  ${sqlText(input.nutritionConfidence ?? null)},
  ${sqlText(input.recommendationMode ?? null)},
  ${sqlNum(input.recommendationConfidence)},
  ${sqlJson(input.qualityFlags ?? null)},
  ${sqlJson(input.sourceRefs ?? null)},
  ${sqlJson(input.raw ?? null)}
)
ON CONFLICT (state_date) DO UPDATE
SET
  generated_at = EXCLUDED.generated_at,
  readiness_score = COALESCE(EXCLUDED.readiness_score, cortana_fitness_athlete_state_daily.readiness_score),
  readiness_band = COALESCE(EXCLUDED.readiness_band, cortana_fitness_athlete_state_daily.readiness_band),
  readiness_confidence = COALESCE(EXCLUDED.readiness_confidence, cortana_fitness_athlete_state_daily.readiness_confidence),
  sleep_hours = COALESCE(EXCLUDED.sleep_hours, cortana_fitness_athlete_state_daily.sleep_hours),
  sleep_performance = COALESCE(EXCLUDED.sleep_performance, cortana_fitness_athlete_state_daily.sleep_performance),
  hrv = COALESCE(EXCLUDED.hrv, cortana_fitness_athlete_state_daily.hrv),
  rhr = COALESCE(EXCLUDED.rhr, cortana_fitness_athlete_state_daily.rhr),
  whoop_strain = COALESCE(EXCLUDED.whoop_strain, cortana_fitness_athlete_state_daily.whoop_strain),
  whoop_workouts = COALESCE(EXCLUDED.whoop_workouts, cortana_fitness_athlete_state_daily.whoop_workouts),
  step_count = COALESCE(EXCLUDED.step_count, cortana_fitness_athlete_state_daily.step_count),
  step_source = COALESCE(EXCLUDED.step_source, cortana_fitness_athlete_state_daily.step_source),
  tonal_sessions = COALESCE(EXCLUDED.tonal_sessions, cortana_fitness_athlete_state_daily.tonal_sessions),
  tonal_volume = COALESCE(EXCLUDED.tonal_volume, cortana_fitness_athlete_state_daily.tonal_volume),
  cardio_minutes = COALESCE(EXCLUDED.cardio_minutes, cortana_fitness_athlete_state_daily.cardio_minutes),
  cardio_summary = COALESCE(cortana_fitness_athlete_state_daily.cardio_summary, '{}'::jsonb) || COALESCE(EXCLUDED.cardio_summary, '{}'::jsonb),
  body_weight_kg = COALESCE(EXCLUDED.body_weight_kg, cortana_fitness_athlete_state_daily.body_weight_kg),
  body_weight_source = COALESCE(EXCLUDED.body_weight_source, cortana_fitness_athlete_state_daily.body_weight_source),
  body_weight_confidence = COALESCE(EXCLUDED.body_weight_confidence, cortana_fitness_athlete_state_daily.body_weight_confidence),
  active_energy_kcal = COALESCE(EXCLUDED.active_energy_kcal, cortana_fitness_athlete_state_daily.active_energy_kcal),
  resting_energy_kcal = COALESCE(EXCLUDED.resting_energy_kcal, cortana_fitness_athlete_state_daily.resting_energy_kcal),
  walking_running_distance_km = COALESCE(EXCLUDED.walking_running_distance_km, cortana_fitness_athlete_state_daily.walking_running_distance_km),
  body_fat_pct = COALESCE(EXCLUDED.body_fat_pct, cortana_fitness_athlete_state_daily.body_fat_pct),
  lean_mass_kg = COALESCE(EXCLUDED.lean_mass_kg, cortana_fitness_athlete_state_daily.lean_mass_kg),
  health_source_confidence = COALESCE(EXCLUDED.health_source_confidence, cortana_fitness_athlete_state_daily.health_source_confidence),
  health_context = COALESCE(cortana_fitness_athlete_state_daily.health_context, '{}'::jsonb) || COALESCE(EXCLUDED.health_context, '{}'::jsonb),
  phase_mode = COALESCE(EXCLUDED.phase_mode, cortana_fitness_athlete_state_daily.phase_mode),
  target_weight_delta_pct_week = COALESCE(EXCLUDED.target_weight_delta_pct_week, cortana_fitness_athlete_state_daily.target_weight_delta_pct_week),
  fatigue_debt = COALESCE(EXCLUDED.fatigue_debt, cortana_fitness_athlete_state_daily.fatigue_debt),
  sleep_debt = COALESCE(EXCLUDED.sleep_debt, cortana_fitness_athlete_state_daily.sleep_debt),
  progression_momentum = COALESCE(EXCLUDED.progression_momentum, cortana_fitness_athlete_state_daily.progression_momentum),
  training_context = COALESCE(cortana_fitness_athlete_state_daily.training_context, '{}'::jsonb) || COALESCE(EXCLUDED.training_context, '{}'::jsonb),
  protein_g = COALESCE(EXCLUDED.protein_g, cortana_fitness_athlete_state_daily.protein_g),
  protein_target_g = COALESCE(EXCLUDED.protein_target_g, cortana_fitness_athlete_state_daily.protein_target_g),
  calories_kcal = COALESCE(EXCLUDED.calories_kcal, cortana_fitness_athlete_state_daily.calories_kcal),
  carbs_g = COALESCE(EXCLUDED.carbs_g, cortana_fitness_athlete_state_daily.carbs_g),
  fat_g = COALESCE(EXCLUDED.fat_g, cortana_fitness_athlete_state_daily.fat_g),
  hydration_liters = COALESCE(EXCLUDED.hydration_liters, cortana_fitness_athlete_state_daily.hydration_liters),
  nutrition_confidence = COALESCE(EXCLUDED.nutrition_confidence, cortana_fitness_athlete_state_daily.nutrition_confidence),
  recommendation_mode = COALESCE(EXCLUDED.recommendation_mode, cortana_fitness_athlete_state_daily.recommendation_mode),
  recommendation_confidence = COALESCE(EXCLUDED.recommendation_confidence, cortana_fitness_athlete_state_daily.recommendation_confidence),
  quality_flags = COALESCE(cortana_fitness_athlete_state_daily.quality_flags, '{}'::jsonb) || COALESCE(EXCLUDED.quality_flags, '{}'::jsonb),
  source_refs = COALESCE(cortana_fitness_athlete_state_daily.source_refs, '{}'::jsonb) || COALESCE(EXCLUDED.source_refs, '{}'::jsonb),
  raw = COALESCE(cortana_fitness_athlete_state_daily.raw, '{}'::jsonb) || COALESCE(EXCLUDED.raw, '{}'::jsonb),
  updated_at = NOW();
`;
}

export function buildReplaceMuscleVolumeSql(stateDate: string, rows: MuscleVolumeDailyInput[]): string {
  const statements = [`DELETE FROM cortana_fitness_muscle_volume_daily WHERE state_date = ${sqlText(stateDate)}::date;`];
  for (const row of rows) {
    statements.push(`
INSERT INTO cortana_fitness_muscle_volume_daily (
  state_date, muscle_group, direct_sets, indirect_sets, hard_sets, sessions,
  load_bucket_summary, rep_bucket_summary, rir_estimate_avg, source_confidence,
  weekly_rollup_sets, weekly_status, target_sets_min, target_sets_max, notes
) VALUES (
  ${sqlText(row.stateDate)}::date,
  ${sqlText(row.muscleGroup)},
  ${sqlNum(row.directSets)},
  ${sqlNum(row.indirectSets)},
  ${sqlNum(row.hardSets)},
  ${sqlInt(row.sessions)},
  ${sqlJson(row.loadBucketSummary ?? null)},
  ${sqlJson(row.repBucketSummary ?? null)},
  ${sqlNum(row.rirEstimateAvg)},
  ${sqlNum(row.sourceConfidence)},
  ${sqlNum(row.weeklyRollupSets)},
  ${sqlText(row.weeklyStatus ?? null)},
  ${sqlNum(row.targetSetsMin)},
  ${sqlNum(row.targetSetsMax)},
  ${sqlJson(row.notes ?? null)}
);`);
  }
  return statements.join("\n");
}

export function buildFetchAthleteStateRowSql(stateDate: string): string {
  return `
SELECT COALESCE(row_to_json(t)::text, '{}') AS payload
FROM (
  SELECT * FROM cortana_fitness_athlete_state_daily
  WHERE state_date = ${sqlText(stateDate)}::date
) t;
`;
}

export function buildFetchAthleteStateWindowSql(startYmd: string, endYmd: string): string {
  return `
SELECT COALESCE(json_agg(t ORDER BY t.state_date)::text, '[]') AS payload
FROM (
  SELECT * FROM cortana_fitness_athlete_state_daily
  WHERE state_date BETWEEN ${sqlText(startYmd)}::date AND ${sqlText(endYmd)}::date
  ORDER BY state_date
) t;
`;
}

export function buildFetchMuscleVolumeWindowSql(startYmd: string, endYmd: string): string {
  return `
SELECT COALESCE(json_agg(t ORDER BY t.state_date, t.muscle_group)::text, '[]') AS payload
FROM (
  SELECT * FROM cortana_fitness_muscle_volume_daily
  WHERE state_date BETWEEN ${sqlText(startYmd)}::date AND ${sqlText(endYmd)}::date
  ORDER BY state_date, muscle_group
) t;
`;
}

export function upsertAthleteStateDaily(input: AthleteStateDailyInput): UpsertResult {
  try {
    ensureAthleteStateSchema();
    const result = runPsql(buildUpsertAthleteStateSql(input));
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || "athlete state upsert failed").trim() };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function replaceMuscleVolumeDaily(stateDate: string, rows: MuscleVolumeDailyInput[]): UpsertResult {
  try {
    ensureAthleteStateSchema();
    const result = runPsql(buildReplaceMuscleVolumeSql(stateDate, rows));
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || "muscle volume replace failed").trim() };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function fetchAthleteStateRow(stateDate: string): AthleteStateDailyRow | null {
  ensureAthleteStateSchema();
  const result = runPsql(buildFetchAthleteStateRowSql(stateDate));
  if (result.status !== 0) return null;
  const payload = parseJsonValue<Record<string, unknown>>(String(result.stdout ?? ""), {});
  return Object.keys(payload).length > 0 ? (payload as AthleteStateDailyRow) : null;
}

export function fetchAthleteStateRows(startYmd: string, endYmd: string): AthleteStateDailyRow[] {
  ensureAthleteStateSchema();
  const result = runPsql(buildFetchAthleteStateWindowSql(startYmd, endYmd));
  if (result.status !== 0) return [];
  return parseJsonValue<AthleteStateDailyRow[]>(String(result.stdout ?? ""), []);
}

export function fetchMuscleVolumeRows(startYmd: string, endYmd: string): MuscleVolumeDailyRow[] {
  ensureAthleteStateSchema();
  const result = runPsql(buildFetchMuscleVolumeWindowSql(startYmd, endYmd));
  if (result.status !== 0) return [];
  return parseJsonValue<MuscleVolumeDailyRow[]>(String(result.stdout ?? ""), []);
}
