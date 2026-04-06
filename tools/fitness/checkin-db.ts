import { runPsql } from "../lib/db.js";

export type CoachCheckinInput = {
  sourceKey: string;
  tsUtc: string;
  dateLocal: string;
  checkinType: "midday" | "post_workout" | "evening" | "ad_hoc";
  complianceStatus?: "completed" | "missed" | "pending" | "unknown" | null;
  sorenessScore?: number | null;
  painFlag?: boolean | null;
  motivationScore?: number | null;
  scheduleConstraint?: string | null;
  rawText: string;
  parsed?: Record<string, unknown> | null;
};

export type CoachAlertInput = {
  alertKey: string;
  tsUtc: string;
  alertType: string;
  severity: "info" | "warning" | "high";
  delivered: boolean;
  deliveredAt?: string | null;
  context?: Record<string, unknown> | null;
};

export type CoachOutcomeEvalWeeklyInput = {
  isoWeek: string;
  weekStart: string;
  weekEnd: string;
  overallScore: number;
  adherenceScore: number;
  recoveryAlignmentScore: number;
  nutritionAlignmentScore: number;
  riskManagementScore: number;
  performanceAlignmentScore: number;
  explanation?: Record<string, unknown> | null;
  evidence?: Record<string, unknown> | null;
};

export type CoachCheckinWindowSummary = {
  days_with_checkins: number;
  completed_days: number;
  missed_days: number;
  pain_days: number;
  schedule_conflict_days: number;
  avg_soreness_score: number | null;
  avg_motivation_score: number | null;
};

export type CoachAlertWindowSummary = {
  total_alerts: number;
  freshness_alerts: number;
  recovery_risk_alerts: number;
  overreach_alerts: number;
  protein_miss_alerts: number;
  pain_alerts: number;
  schedule_conflict_alerts: number;
};

export type CoachCheckinDaySignals = {
  checkin_count: number;
  pain_flag: boolean;
  soreness_score: number | null;
  schedule_constraint: string | null;
};

type UpsertResult = {
  ok: boolean;
  error?: string;
};

function esc(value: string): string {
  return value.replace(/'/g, "''");
}

function sqlText(value: string | null | undefined): string {
  if (value == null || value.length === 0) return "NULL";
  return `'${esc(value)}'`;
}

function sqlBool(value: boolean | null | undefined): string {
  if (value == null) return "NULL";
  return value ? "TRUE" : "FALSE";
}

function sqlNum(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "NULL";
  return String(value);
}

function sqlJson(value: Record<string, unknown> | null | undefined): string {
  if (!value || typeof value !== "object") return "'{}'::jsonb";
  return `'${esc(JSON.stringify(value))}'::jsonb`;
}

export function buildCoachCheckinSchemaSql(): string {
  return `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS coach_checkin_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text UNIQUE NOT NULL,
  ts_utc timestamptz NOT NULL,
  date_local date NOT NULL,
  checkin_type text NOT NULL CHECK (checkin_type IN ('midday', 'post_workout', 'evening', 'ad_hoc')),
  compliance_status text CHECK (compliance_status IS NULL OR compliance_status IN ('completed', 'missed', 'pending')),
  soreness_score numeric(4,2),
  pain_flag boolean,
  motivation_score numeric(4,2),
  schedule_constraint text,
  raw_text text NOT NULL,
  parsed jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coach_checkin_date_local ON coach_checkin_log(date_local DESC);
CREATE INDEX IF NOT EXISTS idx_coach_checkin_type ON coach_checkin_log(checkin_type);
CREATE INDEX IF NOT EXISTS idx_coach_checkin_ts_utc ON coach_checkin_log(ts_utc DESC);
`;
}

export function buildCoachAlertSchemaSql(): string {
  return `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS coach_alert_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_key text UNIQUE NOT NULL,
  ts_utc timestamptz NOT NULL,
  alert_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'high')),
  delivered boolean NOT NULL DEFAULT FALSE,
  delivered_at timestamptz,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coach_alert_type ON coach_alert_log(alert_type);
CREATE INDEX IF NOT EXISTS idx_coach_alert_ts_utc ON coach_alert_log(ts_utc DESC);
`;
}

export function buildCoachOutcomeEvalWeeklySchemaSql(): string {
  return `
CREATE TABLE IF NOT EXISTS coach_outcome_eval_weekly (
  iso_week text PRIMARY KEY,
  week_start date NOT NULL,
  week_end date NOT NULL,
  overall_score int NOT NULL CHECK (overall_score >= 0 AND overall_score <= 100),
  adherence_score int,
  recovery_alignment_score int,
  nutrition_alignment_score int,
  risk_management_score int,
  performance_alignment_score int,
  explanation jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coach_outcome_eval_week_start ON coach_outcome_eval_weekly(week_start DESC);
`;
}

export function buildCoachCheckinUpsertSql(input: CoachCheckinInput): string {
  const complianceStatus = input.complianceStatus == null || input.complianceStatus === "unknown" ? null : input.complianceStatus;
  return `
INSERT INTO coach_checkin_log (
  source_key, ts_utc, date_local, checkin_type, compliance_status, soreness_score, pain_flag,
  motivation_score, schedule_constraint, raw_text, parsed
) VALUES (
  ${sqlText(input.sourceKey)},
  ${sqlText(input.tsUtc)}::timestamptz,
  ${sqlText(input.dateLocal)}::date,
  ${sqlText(input.checkinType)},
  ${sqlText(complianceStatus)},
  ${sqlNum(input.sorenessScore ?? null)},
  ${sqlBool(input.painFlag ?? null)},
  ${sqlNum(input.motivationScore ?? null)},
  ${sqlText(input.scheduleConstraint ?? null)},
  ${sqlText(input.rawText)},
  ${sqlJson(input.parsed ?? null)}
)
ON CONFLICT (source_key) DO UPDATE
SET
  ts_utc = EXCLUDED.ts_utc,
  date_local = EXCLUDED.date_local,
  checkin_type = EXCLUDED.checkin_type,
  compliance_status = EXCLUDED.compliance_status,
  soreness_score = EXCLUDED.soreness_score,
  pain_flag = EXCLUDED.pain_flag,
  motivation_score = EXCLUDED.motivation_score,
  schedule_constraint = EXCLUDED.schedule_constraint,
  raw_text = EXCLUDED.raw_text,
  parsed = COALESCE(coach_checkin_log.parsed, '{}'::jsonb) || COALESCE(EXCLUDED.parsed, '{}'::jsonb);
`;
}

export function buildCoachAlertUpsertSql(input: CoachAlertInput): string {
  return `
INSERT INTO coach_alert_log (
  alert_key, ts_utc, alert_type, severity, delivered, delivered_at, context
) VALUES (
  ${sqlText(input.alertKey)},
  ${sqlText(input.tsUtc)}::timestamptz,
  ${sqlText(input.alertType)},
  ${sqlText(input.severity)},
  ${sqlBool(input.delivered)},
  ${sqlText(input.deliveredAt ?? null)}::timestamptz,
  ${sqlJson(input.context ?? null)}
)
ON CONFLICT (alert_key) DO UPDATE
SET
  ts_utc = EXCLUDED.ts_utc,
  alert_type = EXCLUDED.alert_type,
  severity = EXCLUDED.severity,
  delivered = EXCLUDED.delivered,
  delivered_at = EXCLUDED.delivered_at,
  context = COALESCE(coach_alert_log.context, '{}'::jsonb) || COALESCE(EXCLUDED.context, '{}'::jsonb);
`;
}

export function buildCoachOutcomeEvalWeeklyUpsertSql(input: CoachOutcomeEvalWeeklyInput): string {
  const clampScore = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));
  return `
INSERT INTO coach_outcome_eval_weekly (
  iso_week, week_start, week_end, overall_score, adherence_score, recovery_alignment_score,
  nutrition_alignment_score, risk_management_score, performance_alignment_score, explanation, evidence
) VALUES (
  ${sqlText(input.isoWeek)},
  ${sqlText(input.weekStart)}::date,
  ${sqlText(input.weekEnd)}::date,
  ${clampScore(input.overallScore)},
  ${clampScore(input.adherenceScore)},
  ${clampScore(input.recoveryAlignmentScore)},
  ${clampScore(input.nutritionAlignmentScore)},
  ${clampScore(input.riskManagementScore)},
  ${clampScore(input.performanceAlignmentScore)},
  ${sqlJson(input.explanation ?? null)},
  ${sqlJson(input.evidence ?? null)}
)
ON CONFLICT (iso_week) DO UPDATE
SET
  week_start = EXCLUDED.week_start,
  week_end = EXCLUDED.week_end,
  overall_score = EXCLUDED.overall_score,
  adherence_score = EXCLUDED.adherence_score,
  recovery_alignment_score = EXCLUDED.recovery_alignment_score,
  nutrition_alignment_score = EXCLUDED.nutrition_alignment_score,
  risk_management_score = EXCLUDED.risk_management_score,
  performance_alignment_score = EXCLUDED.performance_alignment_score,
  explanation = COALESCE(coach_outcome_eval_weekly.explanation, '{}'::jsonb) || COALESCE(EXCLUDED.explanation, '{}'::jsonb),
  evidence = COALESCE(coach_outcome_eval_weekly.evidence, '{}'::jsonb) || COALESCE(EXCLUDED.evidence, '{}'::jsonb),
  updated_at = now();
`;
}

let schemaEnsured = false;

function parseSingleJsonLine<T>(raw: string): T | null {
  const line = String(raw ?? "").trim();
  if (!line) return null;
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

function ensureCoachCheckinSchema(): void {
  if (schemaEnsured) return;
  const sql = `${buildCoachCheckinSchemaSql()}\n${buildCoachAlertSchemaSql()}\n${buildCoachOutcomeEvalWeeklySchemaSql()}`;
  const result = runPsql(sql);
  if (result.status !== 0) {
    throw new Error((result.stderr || "failed to ensure coaching loop tables").trim());
  }
  schemaEnsured = true;
}

export function upsertCoachCheckin(input: CoachCheckinInput): UpsertResult {
  try {
    ensureCoachCheckinSchema();
    const result = runPsql(buildCoachCheckinUpsertSql(input));
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || "coach checkin upsert failed").trim() };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function upsertCoachAlert(input: CoachAlertInput): UpsertResult {
  try {
    ensureCoachCheckinSchema();
    const result = runPsql(buildCoachAlertUpsertSql(input));
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || "coach alert upsert failed").trim() };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function upsertCoachOutcomeEvalWeekly(input: CoachOutcomeEvalWeeklyInput): UpsertResult {
  try {
    ensureCoachCheckinSchema();
    const result = runPsql(buildCoachOutcomeEvalWeeklyUpsertSql(input));
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || "coach outcome eval weekly upsert failed").trim() };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function markCoachAlertDelivered(alertKey: string, deliveredAtUtc = new Date().toISOString()): UpsertResult {
  try {
    ensureCoachCheckinSchema();
    const result = runPsql(`
UPDATE coach_alert_log
SET delivered = TRUE,
    delivered_at = COALESCE(${sqlText(deliveredAtUtc)}::timestamptz, now())
WHERE alert_key = ${sqlText(alertKey)};
`);
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || "coach alert delivery mark failed").trim() };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function fetchCoachCheckinWindowSummary(startYmd: string, endYmd: string): CoachCheckinWindowSummary {
  ensureCoachCheckinSchema();
  const sql = `
SELECT COALESCE(row_to_json(t)::text, '{}') AS payload
FROM (
  SELECT
    COUNT(DISTINCT date_local)::int AS days_with_checkins,
    COUNT(DISTINCT date_local) FILTER (WHERE compliance_status = 'completed')::int AS completed_days,
    COUNT(DISTINCT date_local) FILTER (WHERE compliance_status = 'missed')::int AS missed_days,
    COUNT(DISTINCT date_local) FILTER (WHERE pain_flag IS TRUE)::int AS pain_days,
    COUNT(DISTINCT date_local) FILTER (
      WHERE schedule_constraint IS NOT NULL AND btrim(schedule_constraint) <> ''
    )::int AS schedule_conflict_days,
    ROUND(AVG(soreness_score)::numeric, 2) AS avg_soreness_score,
    ROUND(AVG(motivation_score)::numeric, 2) AS avg_motivation_score
  FROM coach_checkin_log
  WHERE date_local BETWEEN ${sqlText(startYmd)}::date AND ${sqlText(endYmd)}::date
) t;`;
  const result = runPsql(sql);
  const parsed = result.status === 0
    ? parseSingleJsonLine<Partial<CoachCheckinWindowSummary>>(String(result.stdout ?? ""))
    : null;
  return {
    days_with_checkins: Number(parsed?.days_with_checkins ?? 0),
    completed_days: Number(parsed?.completed_days ?? 0),
    missed_days: Number(parsed?.missed_days ?? 0),
    pain_days: Number(parsed?.pain_days ?? 0),
    schedule_conflict_days: Number(parsed?.schedule_conflict_days ?? 0),
    avg_soreness_score: parsed?.avg_soreness_score == null ? null : Number(parsed.avg_soreness_score),
    avg_motivation_score: parsed?.avg_motivation_score == null ? null : Number(parsed.avg_motivation_score),
  };
}

export function fetchCoachAlertWindowSummary(startYmd: string, endYmd: string): CoachAlertWindowSummary {
  ensureCoachCheckinSchema();
  const sql = `
SELECT COALESCE(row_to_json(t)::text, '{}') AS payload
FROM (
  SELECT
    COUNT(*)::int AS total_alerts,
    COUNT(*) FILTER (WHERE alert_type = 'freshness')::int AS freshness_alerts,
    COUNT(*) FILTER (WHERE alert_type = 'recovery_risk')::int AS recovery_risk_alerts,
    COUNT(*) FILTER (WHERE alert_type = 'overreach')::int AS overreach_alerts,
    COUNT(*) FILTER (WHERE alert_type = 'protein_miss')::int AS protein_miss_alerts,
    COUNT(*) FILTER (WHERE alert_type = 'pain')::int AS pain_alerts,
    COUNT(*) FILTER (WHERE alert_type = 'schedule_conflict')::int AS schedule_conflict_alerts
  FROM coach_alert_log
  WHERE (ts_utc AT TIME ZONE 'America/New_York')::date BETWEEN ${sqlText(startYmd)}::date AND ${sqlText(endYmd)}::date
) t;`;
  const result = runPsql(sql);
  const parsed = result.status === 0
    ? parseSingleJsonLine<Partial<CoachAlertWindowSummary>>(String(result.stdout ?? ""))
    : null;
  return {
    total_alerts: Number(parsed?.total_alerts ?? 0),
    freshness_alerts: Number(parsed?.freshness_alerts ?? 0),
    recovery_risk_alerts: Number(parsed?.recovery_risk_alerts ?? 0),
    overreach_alerts: Number(parsed?.overreach_alerts ?? 0),
    protein_miss_alerts: Number(parsed?.protein_miss_alerts ?? 0),
    pain_alerts: Number(parsed?.pain_alerts ?? 0),
    schedule_conflict_alerts: Number(parsed?.schedule_conflict_alerts ?? 0),
  };
}

export function fetchCoachCheckinDaySignals(dateLocal: string): CoachCheckinDaySignals {
  ensureCoachCheckinSchema();
  const sql = `
SELECT COALESCE(row_to_json(t)::text, '{}') AS payload
FROM (
  SELECT
    COUNT(*)::int AS checkin_count,
    COALESCE(BOOL_OR(pain_flag), FALSE) AS pain_flag,
    ROUND(MAX(soreness_score)::numeric, 2) AS soreness_score,
    (
      ARRAY_AGG(schedule_constraint ORDER BY ts_utc DESC)
      FILTER (WHERE schedule_constraint IS NOT NULL AND btrim(schedule_constraint) <> '')
    )[1]::text AS schedule_constraint
  FROM coach_checkin_log
  WHERE date_local = ${sqlText(dateLocal)}::date
) t;`;
  const result = runPsql(sql);
  const parsed = result.status === 0
    ? parseSingleJsonLine<Partial<CoachCheckinDaySignals>>(String(result.stdout ?? ""))
    : null;
  return {
    checkin_count: Number(parsed?.checkin_count ?? 0),
    pain_flag: Boolean(parsed?.pain_flag ?? false),
    soreness_score: parsed?.soreness_score == null ? null : Number(parsed.soreness_score),
    schedule_constraint: typeof parsed?.schedule_constraint === "string" ? parsed.schedule_constraint : null,
  };
}
