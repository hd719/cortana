import { runPsql } from "../lib/db.js";

export type TrainingRecommendationScope = "daily" | "weekly";

export type TrainingStateWeeklyInput = {
  isoWeek: string;
  weekStart: string;
  weekEnd: string;
  phaseMode?: string | null;
  athleteStateDays?: number | null;
  mappedTrainingDays?: number | null;
  readinessAvg?: number | null;
  sleepHoursAvg?: number | null;
  strainTotal?: number | null;
  tonalSessions?: number | null;
  tonalVolume?: number | null;
  fatigueScore?: number | null;
  progressionScore?: number | null;
  interferenceRiskScore?: number | null;
  confidence?: number | null;
  underdosedMuscles?: Record<string, unknown> | null;
  adequatelyDosedMuscles?: Record<string, unknown> | null;
  overdosedMuscles?: Record<string, unknown> | null;
  cardioContext?: Record<string, unknown> | null;
  recommendationSummary?: Record<string, unknown> | null;
  qualityFlags?: Record<string, unknown> | null;
  raw?: Record<string, unknown> | null;
};

export type TrainingStateWeeklyRow = {
  iso_week: string;
  week_start: string;
  week_end: string;
  phase_mode: string | null;
  athlete_state_days: number | null;
  mapped_training_days: number | null;
  readiness_avg: number | null;
  sleep_hours_avg: number | null;
  strain_total: number | null;
  tonal_sessions: number | null;
  tonal_volume: number | null;
  fatigue_score: number | null;
  progression_score: number | null;
  interference_risk_score: number | null;
  confidence: number | null;
  underdosed_muscles: Record<string, unknown>;
  adequately_dosed_muscles: Record<string, unknown>;
  overdosed_muscles: Record<string, unknown>;
  cardio_context: Record<string, unknown>;
  recommendation_summary: Record<string, unknown>;
  quality_flags: Record<string, unknown>;
  raw: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type RecommendationLogInput = {
  recommendationKey: string;
  recommendationScope: TrainingRecommendationScope;
  stateDate?: string | null;
  isoWeek?: string | null;
  mode: string;
  confidence?: number | null;
  rationale: string;
  inputs?: Record<string, unknown> | null;
  outputs?: Record<string, unknown> | null;
};

export type RecommendationLogRow = {
  id: string;
  recommendation_key: string;
  recommendation_scope: TrainingRecommendationScope;
  state_date: string | null;
  iso_week: string | null;
  mode: string;
  confidence: number | null;
  rationale: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  created_at: string;
};

let schemaEnsured = false;
const TRAINING_INTELLIGENCE_SCHEMA_LOCK_KEY = 732041907;

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

export function buildTrainingIntelligenceSchemaSql(): string {
  return `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS cortana_fitness_training_state_weekly (
  iso_week TEXT PRIMARY KEY,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  phase_mode TEXT,
  athlete_state_days INT,
  mapped_training_days INT,
  readiness_avg NUMERIC(6,2),
  sleep_hours_avg NUMERIC(6,2),
  strain_total NUMERIC(8,2),
  tonal_sessions INT,
  tonal_volume NUMERIC(12,2),
  fatigue_score NUMERIC(6,2),
  progression_score NUMERIC(6,2),
  interference_risk_score NUMERIC(6,2),
  confidence NUMERIC(4,3),
  underdosed_muscles JSONB NOT NULL DEFAULT '{}'::jsonb,
  adequately_dosed_muscles JSONB NOT NULL DEFAULT '{}'::jsonb,
  overdosed_muscles JSONB NOT NULL DEFAULT '{}'::jsonb,
  cardio_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommendation_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  quality_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cortana_fitness_recommendation_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_key TEXT UNIQUE,
  recommendation_scope TEXT NOT NULL,
  state_date DATE,
  iso_week TEXT,
  mode TEXT NOT NULL,
  confidence NUMERIC(4,3),
  rationale TEXT NOT NULL,
  inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
  outputs JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_training_state_weekly_range ON cortana_fitness_training_state_weekly(week_start DESC, week_end DESC);
CREATE INDEX IF NOT EXISTS idx_recommendation_log_scope ON cortana_fitness_recommendation_log(recommendation_scope, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendation_log_week ON cortana_fitness_recommendation_log(iso_week);
CREATE INDEX IF NOT EXISTS idx_recommendation_log_date ON cortana_fitness_recommendation_log(state_date DESC);
`;
}

function ensureTrainingIntelligenceSchema(): void {
  if (schemaEnsured) return;
  const result = runPsql(`
SELECT pg_advisory_lock(${TRAINING_INTELLIGENCE_SCHEMA_LOCK_KEY});
${buildTrainingIntelligenceSchemaSql()}
SELECT pg_advisory_unlock(${TRAINING_INTELLIGENCE_SCHEMA_LOCK_KEY});
`);
  if (result.status !== 0) {
    throw new Error((result.stderr || "failed to ensure training-intelligence schema").trim());
  }
  schemaEnsured = true;
}

export function buildUpsertTrainingStateWeeklySql(input: TrainingStateWeeklyInput): string {
  return `
INSERT INTO cortana_fitness_training_state_weekly (
  iso_week, week_start, week_end, phase_mode, athlete_state_days, mapped_training_days,
  readiness_avg, sleep_hours_avg, strain_total, tonal_sessions, tonal_volume,
  fatigue_score, progression_score, interference_risk_score, confidence,
  underdosed_muscles, adequately_dosed_muscles, overdosed_muscles, cardio_context,
  recommendation_summary, quality_flags, raw
) VALUES (
  ${sqlText(input.isoWeek)},
  ${sqlText(input.weekStart)}::date,
  ${sqlText(input.weekEnd)}::date,
  ${sqlText(input.phaseMode ?? null)},
  ${sqlInt(input.athleteStateDays)},
  ${sqlInt(input.mappedTrainingDays)},
  ${sqlNum(input.readinessAvg)},
  ${sqlNum(input.sleepHoursAvg)},
  ${sqlNum(input.strainTotal)},
  ${sqlInt(input.tonalSessions)},
  ${sqlNum(input.tonalVolume)},
  ${sqlNum(input.fatigueScore)},
  ${sqlNum(input.progressionScore)},
  ${sqlNum(input.interferenceRiskScore)},
  ${sqlNum(input.confidence)},
  ${sqlJson(input.underdosedMuscles ?? null)},
  ${sqlJson(input.adequatelyDosedMuscles ?? null)},
  ${sqlJson(input.overdosedMuscles ?? null)},
  ${sqlJson(input.cardioContext ?? null)},
  ${sqlJson(input.recommendationSummary ?? null)},
  ${sqlJson(input.qualityFlags ?? null)},
  ${sqlJson(input.raw ?? null)}
)
ON CONFLICT (iso_week) DO UPDATE
SET
  week_start = EXCLUDED.week_start,
  week_end = EXCLUDED.week_end,
  phase_mode = COALESCE(EXCLUDED.phase_mode, cortana_fitness_training_state_weekly.phase_mode),
  athlete_state_days = COALESCE(EXCLUDED.athlete_state_days, cortana_fitness_training_state_weekly.athlete_state_days),
  mapped_training_days = COALESCE(EXCLUDED.mapped_training_days, cortana_fitness_training_state_weekly.mapped_training_days),
  readiness_avg = COALESCE(EXCLUDED.readiness_avg, cortana_fitness_training_state_weekly.readiness_avg),
  sleep_hours_avg = COALESCE(EXCLUDED.sleep_hours_avg, cortana_fitness_training_state_weekly.sleep_hours_avg),
  strain_total = COALESCE(EXCLUDED.strain_total, cortana_fitness_training_state_weekly.strain_total),
  tonal_sessions = COALESCE(EXCLUDED.tonal_sessions, cortana_fitness_training_state_weekly.tonal_sessions),
  tonal_volume = COALESCE(EXCLUDED.tonal_volume, cortana_fitness_training_state_weekly.tonal_volume),
  fatigue_score = COALESCE(EXCLUDED.fatigue_score, cortana_fitness_training_state_weekly.fatigue_score),
  progression_score = COALESCE(EXCLUDED.progression_score, cortana_fitness_training_state_weekly.progression_score),
  interference_risk_score = COALESCE(EXCLUDED.interference_risk_score, cortana_fitness_training_state_weekly.interference_risk_score),
  confidence = COALESCE(EXCLUDED.confidence, cortana_fitness_training_state_weekly.confidence),
  underdosed_muscles = COALESCE(EXCLUDED.underdosed_muscles, '{}'::jsonb),
  adequately_dosed_muscles = COALESCE(EXCLUDED.adequately_dosed_muscles, '{}'::jsonb),
  overdosed_muscles = COALESCE(EXCLUDED.overdosed_muscles, '{}'::jsonb),
  cardio_context = COALESCE(EXCLUDED.cardio_context, '{}'::jsonb),
  recommendation_summary = COALESCE(EXCLUDED.recommendation_summary, '{}'::jsonb),
  quality_flags = COALESCE(EXCLUDED.quality_flags, '{}'::jsonb),
  raw = COALESCE(EXCLUDED.raw, '{}'::jsonb),
  updated_at = NOW();
`;
}

export function buildUpsertRecommendationLogSql(input: RecommendationLogInput): string {
  return `
INSERT INTO cortana_fitness_recommendation_log (
  recommendation_key, recommendation_scope, state_date, iso_week, mode, confidence, rationale, inputs, outputs
) VALUES (
  ${sqlText(input.recommendationKey)},
  ${sqlText(input.recommendationScope)},
  ${sqlText(input.stateDate ?? null)}::date,
  ${sqlText(input.isoWeek ?? null)},
  ${sqlText(input.mode)},
  ${sqlNum(input.confidence)},
  ${sqlText(input.rationale)},
  ${sqlJson(input.inputs ?? null)},
  ${sqlJson(input.outputs ?? null)}
)
ON CONFLICT (recommendation_key) DO UPDATE
SET
  recommendation_scope = EXCLUDED.recommendation_scope,
  state_date = COALESCE(EXCLUDED.state_date, cortana_fitness_recommendation_log.state_date),
  iso_week = COALESCE(EXCLUDED.iso_week, cortana_fitness_recommendation_log.iso_week),
  mode = EXCLUDED.mode,
  confidence = COALESCE(EXCLUDED.confidence, cortana_fitness_recommendation_log.confidence),
  rationale = EXCLUDED.rationale,
  inputs = COALESCE(EXCLUDED.inputs, '{}'::jsonb),
  outputs = COALESCE(EXCLUDED.outputs, '{}'::jsonb);
`;
}

export function buildFetchTrainingStateWeeklySql(isoWeek: string): string {
  return `
SELECT COALESCE(row_to_json(t)::text, '{}') AS payload
FROM (
  SELECT * FROM cortana_fitness_training_state_weekly
  WHERE iso_week = ${sqlText(isoWeek)}
) t;
`;
}

export function buildFetchLatestTrainingStateWeeklySql(): string {
  return `
SELECT COALESCE(row_to_json(t)::text, '{}') AS payload
FROM (
  SELECT * FROM cortana_fitness_training_state_weekly
  ORDER BY week_start DESC, iso_week DESC
  LIMIT 1
) t;
`;
}

export function buildFetchRecommendationLogsSql(scope: TrainingRecommendationScope, ref: string): string {
  const whereClause = scope === "weekly"
    ? `recommendation_scope = 'weekly' AND iso_week = ${sqlText(ref)}`
    : `recommendation_scope = 'daily' AND state_date = ${sqlText(ref)}::date`;
  return `
SELECT COALESCE(json_agg(t ORDER BY created_at DESC)::text, '[]') AS payload
FROM (
  SELECT * FROM cortana_fitness_recommendation_log
  WHERE ${whereClause}
  ORDER BY created_at DESC
) t;
`;
}

export function upsertTrainingStateWeekly(input: TrainingStateWeeklyInput): { ok: boolean; error?: string } {
  try {
    ensureTrainingIntelligenceSchema();
    const result = runPsql(buildUpsertTrainingStateWeeklySql(input));
    if (result.status !== 0) return { ok: false, error: (result.stderr || "training state weekly upsert failed").trim() };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function upsertRecommendationLog(input: RecommendationLogInput): { ok: boolean; error?: string } {
  try {
    ensureTrainingIntelligenceSchema();
    const result = runPsql(buildUpsertRecommendationLogSql(input));
    if (result.status !== 0) return { ok: false, error: (result.stderr || "recommendation log upsert failed").trim() };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function fetchTrainingStateWeekly(isoWeek: string): TrainingStateWeeklyRow | null {
  ensureTrainingIntelligenceSchema();
  const result = runPsql(buildFetchTrainingStateWeeklySql(isoWeek));
  if (result.status !== 0) return null;
  const payload = parseJsonValue<Record<string, unknown>>(String(result.stdout ?? ""), {});
  return Object.keys(payload).length > 0 ? (payload as TrainingStateWeeklyRow) : null;
}

export function fetchLatestTrainingStateWeekly(): TrainingStateWeeklyRow | null {
  ensureTrainingIntelligenceSchema();
  const result = runPsql(buildFetchLatestTrainingStateWeeklySql());
  if (result.status !== 0) return null;
  const payload = parseJsonValue<Record<string, unknown>>(String(result.stdout ?? ""), {});
  return Object.keys(payload).length > 0 ? (payload as TrainingStateWeeklyRow) : null;
}

export function fetchRecommendationLogs(scope: TrainingRecommendationScope, ref: string): RecommendationLogRow[] {
  ensureTrainingIntelligenceSchema();
  const result = runPsql(buildFetchRecommendationLogsSql(scope, ref));
  if (result.status !== 0) return [];
  return parseJsonValue<RecommendationLogRow[]>(String(result.stdout ?? ""), []);
}
