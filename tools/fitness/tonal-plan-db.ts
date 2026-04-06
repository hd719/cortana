import { runPsql } from "../lib/db.js";
import type { TonalProgramTemplate } from "./tonal-template-library.js";

export type TonalLibrarySnapshotInput = {
  snapshotDate: string;
  generatedAt?: string | null;
  userId?: string | null;
  workoutsSeen?: number | null;
  movementsSeen?: number | null;
  strengthScoresPresent?: boolean | null;
  programSummary?: Record<string, unknown> | null;
  movementSummary?: Record<string, unknown> | null;
  qualityFlags?: Record<string, unknown> | null;
  raw?: Record<string, unknown> | null;
};

export type PlannedSessionInput = {
  id?: string;
  stateDate?: string | null;
  isoWeek?: string | null;
  planType: string;
  sourceTemplateId: string;
  confidence: number;
  targetDurationMinutes: number;
  targetMuscles?: Record<string, unknown> | null;
  sessionBlocks?: Record<string, unknown> | null;
  constraints?: Record<string, unknown> | null;
  rationale?: Record<string, unknown> | null;
  artifactPath?: string | null;
};

export type PlannedSessionRow = {
  id: string;
  state_date: string | null;
  iso_week: string | null;
  plan_type: string;
  source_template_id: string;
  confidence: number;
  target_duration_minutes: number;
  target_muscles: Record<string, unknown>;
  session_blocks: Record<string, unknown>;
  constraints: Record<string, unknown>;
  rationale: Record<string, unknown>;
  artifact_path: string | null;
  created_at: string;
};

type UpsertResult<T = unknown> = {
  ok: boolean;
  error?: string;
  row?: T | null;
};

let schemaEnsured = false;
const TONAL_PLAN_SCHEMA_LOCK_KEY = 732041908;

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

function sqlBool(value: boolean | null | undefined): string {
  if (value == null) return "NULL";
  return value ? "TRUE" : "FALSE";
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

export function buildTonalPlanSchemaSql(): string {
  return `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS cortana_fitness_tonal_library_snapshot (
  snapshot_date DATE PRIMARY KEY,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id TEXT,
  workouts_seen INT,
  movements_seen INT,
  strength_scores_present BOOLEAN,
  program_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  movement_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  quality_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cortana_fitness_program_template (
  template_id TEXT PRIMARY KEY,
  version INT NOT NULL,
  goal_mode TEXT NOT NULL,
  split_type TEXT NOT NULL,
  duration_minutes INT NOT NULL,
  tonal_required BOOLEAN,
  template_body JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cortana_fitness_planned_session (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_date DATE,
  iso_week TEXT,
  plan_type TEXT NOT NULL,
  source_template_id TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL,
  target_duration_minutes INT NOT NULL,
  target_muscles JSONB NOT NULL DEFAULT '{}'::jsonb,
  session_blocks JSONB NOT NULL DEFAULT '{}'::jsonb,
  constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
  rationale JSONB NOT NULL DEFAULT '{}'::jsonb,
  artifact_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

WITH ranked_planned_sessions AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY plan_type, state_date, iso_week
      ORDER BY created_at DESC, id DESC
    ) AS duplicate_rank
  FROM cortana_fitness_planned_session
)
DELETE FROM cortana_fitness_planned_session
WHERE id IN (
  SELECT id
  FROM ranked_planned_sessions
  WHERE duplicate_rank > 1
);

ALTER TABLE cortana_fitness_recommendation_log ADD COLUMN IF NOT EXISTS planner_session_id UUID;
ALTER TABLE cortana_fitness_recommendation_log ADD COLUMN IF NOT EXISTS planner_context JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_tonal_library_snapshot_generated_at ON cortana_fitness_tonal_library_snapshot(generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_program_template_active ON cortana_fitness_program_template(active, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_planned_session_state_date ON cortana_fitness_planned_session(state_date DESC);
CREATE INDEX IF NOT EXISTS idx_planned_session_iso_week ON cortana_fitness_planned_session(iso_week);
CREATE UNIQUE INDEX IF NOT EXISTS idx_planned_session_unique ON cortana_fitness_planned_session(plan_type, state_date, iso_week) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS idx_recommendation_log_planner_session ON cortana_fitness_recommendation_log(planner_session_id);
`;
}

function ensureTonalPlanSchema(): void {
  if (schemaEnsured) return;
  const result = runPsql(`
SELECT pg_advisory_lock(${TONAL_PLAN_SCHEMA_LOCK_KEY});
${buildTonalPlanSchemaSql()}
SELECT pg_advisory_unlock(${TONAL_PLAN_SCHEMA_LOCK_KEY});
`);
  if (result.status !== 0) {
    throw new Error((result.stderr || "failed to ensure tonal-plan schema").trim());
  }
  schemaEnsured = true;
}

export function buildUpsertTonalLibrarySnapshotSql(input: TonalLibrarySnapshotInput): string {
  return `
INSERT INTO cortana_fitness_tonal_library_snapshot (
  snapshot_date, generated_at, user_id, workouts_seen, movements_seen, strength_scores_present,
  program_summary, movement_summary, quality_flags, raw
) VALUES (
  ${sqlText(input.snapshotDate)}::date,
  COALESCE(${sqlText(input.generatedAt ?? null)}::timestamptz, NOW()),
  ${sqlText(input.userId ?? null)},
  ${sqlInt(input.workoutsSeen)},
  ${sqlInt(input.movementsSeen)},
  ${sqlBool(input.strengthScoresPresent)},
  ${sqlJson(input.programSummary ?? null)},
  ${sqlJson(input.movementSummary ?? null)},
  ${sqlJson(input.qualityFlags ?? null)},
  ${sqlJson(input.raw ?? null)}
)
ON CONFLICT (snapshot_date) DO UPDATE
SET
  generated_at = EXCLUDED.generated_at,
  user_id = COALESCE(EXCLUDED.user_id, cortana_fitness_tonal_library_snapshot.user_id),
  workouts_seen = COALESCE(EXCLUDED.workouts_seen, cortana_fitness_tonal_library_snapshot.workouts_seen),
  movements_seen = COALESCE(EXCLUDED.movements_seen, cortana_fitness_tonal_library_snapshot.movements_seen),
  strength_scores_present = COALESCE(EXCLUDED.strength_scores_present, cortana_fitness_tonal_library_snapshot.strength_scores_present),
  program_summary = COALESCE(EXCLUDED.program_summary, '{}'::jsonb),
  movement_summary = COALESCE(EXCLUDED.movement_summary, '{}'::jsonb),
  quality_flags = COALESCE(EXCLUDED.quality_flags, '{}'::jsonb),
  raw = COALESCE(EXCLUDED.raw, '{}'::jsonb);
`;
}

export function buildUpsertProgramTemplateSql(template: TonalProgramTemplate): string {
  return `
INSERT INTO cortana_fitness_program_template (
  template_id, version, goal_mode, split_type, duration_minutes, tonal_required, template_body, tags, active
) VALUES (
  ${sqlText(template.templateId)},
  ${sqlInt(template.version)},
  ${sqlText(template.goalMode)},
  ${sqlText(template.splitType)},
  ${sqlInt(template.durationMinutes)},
  ${sqlBool(template.tonalRequired)},
  ${sqlJson(template.templateBody as unknown as Record<string, unknown>)},
  '${esc(JSON.stringify(template.tags))}'::jsonb,
  ${sqlBool(template.active)}
)
ON CONFLICT (template_id) DO UPDATE
SET
  version = EXCLUDED.version,
  goal_mode = EXCLUDED.goal_mode,
  split_type = EXCLUDED.split_type,
  duration_minutes = EXCLUDED.duration_minutes,
  tonal_required = EXCLUDED.tonal_required,
  template_body = EXCLUDED.template_body,
  tags = EXCLUDED.tags,
  active = EXCLUDED.active,
  updated_at = NOW();
`;
}

export function buildUpsertPlannedSessionSql(input: PlannedSessionInput): string {
  return `
WITH upserted AS (
  INSERT INTO cortana_fitness_planned_session (
    ${input.id ? "id," : ""} state_date, iso_week, plan_type, source_template_id, confidence, target_duration_minutes,
    target_muscles, session_blocks, constraints, rationale, artifact_path
  ) VALUES (
    ${input.id ? `${sqlText(input.id)}::uuid,` : ""} ${sqlText(input.stateDate ?? null)}::date,
    ${sqlText(input.isoWeek ?? null)},
    ${sqlText(input.planType)},
    ${sqlText(input.sourceTemplateId)},
    ${sqlNum(input.confidence)},
    ${sqlInt(input.targetDurationMinutes)},
    ${sqlJson(input.targetMuscles ?? null)},
    ${sqlJson(input.sessionBlocks ?? null)},
    ${sqlJson(input.constraints ?? null)},
    ${sqlJson(input.rationale ?? null)},
    ${sqlText(input.artifactPath ?? null)}
  )
  ON CONFLICT (plan_type, state_date, iso_week) DO UPDATE
  SET
    source_template_id = EXCLUDED.source_template_id,
    confidence = EXCLUDED.confidence,
    target_duration_minutes = EXCLUDED.target_duration_minutes,
    target_muscles = EXCLUDED.target_muscles,
    session_blocks = EXCLUDED.session_blocks,
    constraints = EXCLUDED.constraints,
    rationale = EXCLUDED.rationale,
    artifact_path = EXCLUDED.artifact_path
  RETURNING *
)
SELECT COALESCE(row_to_json(upserted)::text, '{}') AS payload
FROM upserted;
`;
}

export function buildLinkPlannerSessionToRecommendationSql(
  recommendationKey: string,
  plannerSessionId: string,
  plannerContext?: Record<string, unknown> | null,
): string {
  return `
UPDATE cortana_fitness_recommendation_log
SET
  planner_session_id = ${sqlText(plannerSessionId)}::uuid,
  planner_context = COALESCE(planner_context, '{}'::jsonb) || COALESCE(${sqlJson(plannerContext ?? null)}, '{}'::jsonb)
WHERE recommendation_key = ${sqlText(recommendationKey)};
`;
}

export function buildFetchLatestTonalLibrarySnapshotSql(): string {
  return `
SELECT COALESCE(row_to_json(t)::text, '{}') AS payload
FROM (
  SELECT * FROM cortana_fitness_tonal_library_snapshot
  ORDER BY snapshot_date DESC
  LIMIT 1
) t;
`;
}

export function buildFetchPlannedSessionsSql(limit = 10): string {
  return `
SELECT COALESCE(json_agg(t ORDER BY t.created_at DESC)::text, '[]') AS payload
FROM (
  SELECT * FROM cortana_fitness_planned_session
  ORDER BY created_at DESC
  LIMIT ${Math.max(1, Math.trunc(limit))}
) t;
`;
}

export function upsertTonalLibrarySnapshot(input: TonalLibrarySnapshotInput): UpsertResult {
  try {
    ensureTonalPlanSchema();
    const result = runPsql(buildUpsertTonalLibrarySnapshotSql(input));
    if (result.status !== 0) return { ok: false, error: (result.stderr || "tonal library snapshot upsert failed").trim() };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function upsertProgramTemplate(template: TonalProgramTemplate): UpsertResult {
  try {
    ensureTonalPlanSchema();
    const result = runPsql(buildUpsertProgramTemplateSql(template));
    if (result.status !== 0) return { ok: false, error: (result.stderr || "program template upsert failed").trim() };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function upsertProgramTemplates(templates: TonalProgramTemplate[]): UpsertResult {
  try {
    ensureTonalPlanSchema();
    const sql = templates.map((template) => buildUpsertProgramTemplateSql(template)).join("\n");
    const result = runPsql(sql);
    if (result.status !== 0) return { ok: false, error: (result.stderr || "program templates upsert failed").trim() };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function upsertPlannedSession(input: PlannedSessionInput): UpsertResult<PlannedSessionRow> {
  try {
    ensureTonalPlanSchema();
    const result = runPsql(buildUpsertPlannedSessionSql(input));
    if (result.status !== 0) return { ok: false, error: (result.stderr || "planned session insert failed").trim() };
    const row = parseJsonValue<PlannedSessionRow>(String(result.stdout ?? ""), {} as PlannedSessionRow);
    return { ok: true, row };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function linkPlannerSessionToRecommendation(
  recommendationKey: string,
  plannerSessionId: string,
  plannerContext?: Record<string, unknown> | null,
): UpsertResult {
  try {
    ensureTonalPlanSchema();
    const result = runPsql(buildLinkPlannerSessionToRecommendationSql(recommendationKey, plannerSessionId, plannerContext));
    if (result.status !== 0) return { ok: false, error: (result.stderr || "recommendation planner link failed").trim() };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function fetchLatestTonalLibrarySnapshot(): Record<string, unknown> | null {
  ensureTonalPlanSchema();
  const result = runPsql(buildFetchLatestTonalLibrarySnapshotSql());
  if (result.status !== 0) return null;
  const payload = parseJsonValue<Record<string, unknown>>(String(result.stdout ?? ""), {});
  return Object.keys(payload).length > 0 ? payload : null;
}

export function fetchPlannedSessions(limit = 10): PlannedSessionRow[] {
  ensureTonalPlanSchema();
  const result = runPsql(buildFetchPlannedSessionsSql(limit));
  if (result.status !== 0) return [];
  return parseJsonValue<PlannedSessionRow[]>(String(result.stdout ?? ""), []);
}
