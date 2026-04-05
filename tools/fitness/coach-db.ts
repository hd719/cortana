import { runPsql } from "../lib/db.js";

export type CoachDecisionInput = {
  tsUtc?: string;
  readinessCall: "Green" | "Yellow" | "Red" | "Unknown";
  longevityImpact: "positive" | "neutral" | "negative";
  topRisk: string;
  reasonSummary: string;
  prescribedAction: string;
  actualDayStrain?: number | null;
  sleepPerfPct?: number | null;
  recoveryScore?: number | null;
  complianceStatus?: string | null;
  sourceStateDate?: string | null;
  sourceIsoWeek?: string | null;
  expectedFollowupBy?: string | null;
  decisionKey?: string | null;
  payload?: Record<string, unknown> | null;
};


export type CoachConversationInput = {
  sourceKey: string;
  tsUtc?: string;
  channel: string;
  direction: "inbound" | "outbound";
  messageText: string;
  intent?: string | null;
  tags?: Record<string, unknown> | null;
  linkedStateDate?: string | null;
  linkedDecisionKey?: string | null;
  parsedEntities?: Record<string, unknown> | null;
};

export type CoachWeeklyScoreInput = {
  isoWeek: string;
  weekStart: string;
  weekEnd: string;
  score: number;
  summary?: string | null;
  details?: Record<string, unknown> | null;
};


export type CoachCaffeineInput = {
  sourceKey: string;
  dateLocal: string;
  consumedAtUtc: string;
  amountMg: number;
  source?: string | null;
  notes?: string | null;
};

export type CoachCaffeineDaySummary = {
  date_local: string;
  total_mg: number;
  entries: number;
  latest_consumed_at_utc: string | null;
  latest_local_time: string | null;
  latest_after_cutoff: boolean;
};

export type CoachNutritionInput = {
  dateLocal: string;
  proteinTargetG: number;
  proteinActualG?: number | null;
  hydrationStatus: string;
  notes?: string | null;
};

let schemaEnsured = false;

function esc(value: string): string {
  return value.replace(/'/g, "''");
}

function sqlText(value: string | null | undefined): string {
  if (!value) return "NULL";
  return `'${esc(value)}'`;
}

function sqlJson(value: Record<string, unknown> | null | undefined): string {
  if (!value || typeof value !== "object") return "'{}'::jsonb";
  return `'${esc(JSON.stringify(value))}'::jsonb`;
}

function parseSingleJsonLine<T>(raw: string): T | null {
  const line = String(raw ?? "").trim();
  if (!line) return null;
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

function sqlNum(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "NULL";
  return String(value);
}

export function buildCoachSchemaSql(): string {
  return `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'coach_direction') THEN
    CREATE TYPE coach_direction AS ENUM ('inbound','outbound');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS coach_conversation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text UNIQUE,
  ts_utc timestamptz NOT NULL DEFAULT now(),
  channel text NOT NULL,
  direction coach_direction NOT NULL,
  message_text text NOT NULL,
  intent text,
  tags jsonb NOT NULL DEFAULT '{}'::jsonb,
  linked_state_date date,
  linked_decision_key text,
  parsed_entities jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE coach_conversation_log ADD COLUMN IF NOT EXISTS source_key text;
ALTER TABLE coach_conversation_log ADD COLUMN IF NOT EXISTS linked_state_date date;
ALTER TABLE coach_conversation_log ADD COLUMN IF NOT EXISTS linked_decision_key text;
ALTER TABLE coach_conversation_log ADD COLUMN IF NOT EXISTS parsed_entities jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS idx_coach_conversation_source_key ON coach_conversation_log(source_key);
CREATE INDEX IF NOT EXISTS idx_coach_conversation_state_date ON coach_conversation_log(linked_state_date DESC);
CREATE INDEX IF NOT EXISTS idx_coach_conversation_decision_key ON coach_conversation_log(linked_decision_key);

CREATE TABLE IF NOT EXISTS coach_decision_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts_utc timestamptz NOT NULL DEFAULT now(),
  readiness_call text NOT NULL CHECK (readiness_call IN ('Green','Yellow','Red','Unknown')),
  longevity_impact text NOT NULL CHECK (longevity_impact IN ('positive','neutral','negative')),
  top_risk text NOT NULL,
  reason_summary text NOT NULL,
  prescribed_action text NOT NULL,
  actual_day_strain numeric(6,3),
  sleep_perf_pct numeric(5,2),
  recovery_score numeric(5,2),
  compliance_status text,
  source_state_date date,
  source_iso_week text,
  expected_followup_by timestamptz,
  decision_key text UNIQUE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE coach_decision_log ADD COLUMN IF NOT EXISTS source_state_date date;
ALTER TABLE coach_decision_log ADD COLUMN IF NOT EXISTS source_iso_week text;
ALTER TABLE coach_decision_log ADD COLUMN IF NOT EXISTS expected_followup_by timestamptz;
ALTER TABLE coach_decision_log ADD COLUMN IF NOT EXISTS decision_key text;
ALTER TABLE coach_decision_log ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS idx_coach_decision_key ON coach_decision_log(decision_key);
CREATE INDEX IF NOT EXISTS idx_coach_decision_state_date ON coach_decision_log(source_state_date DESC);
CREATE INDEX IF NOT EXISTS idx_coach_decision_iso_week ON coach_decision_log(source_iso_week);

CREATE TABLE IF NOT EXISTS coach_nutrition_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date_local date NOT NULL UNIQUE,
  protein_target_g int NOT NULL CHECK (protein_target_g > 0),
  protein_actual_g int CHECK (protein_actual_g >= 0),
  hydration_status text NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coach_weekly_score (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  iso_week text NOT NULL UNIQUE,
  week_start date NOT NULL,
  week_end date NOT NULL,
  score int NOT NULL CHECK (score >= 0 AND score <= 100),
  summary text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coach_caffeine_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text UNIQUE,
  date_local date NOT NULL,
  consumed_at_utc timestamptz NOT NULL,
  amount_mg int NOT NULL CHECK (amount_mg > 0 AND amount_mg <= 1200),
  source text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coach_caffeine_date ON coach_caffeine_log(date_local DESC);
CREATE INDEX IF NOT EXISTS idx_coach_caffeine_consumed_at ON coach_caffeine_log(consumed_at_utc DESC);
`;
}

function ensureCoachSchema(): void {
  if (schemaEnsured) return;
  const result = runPsql(buildCoachSchemaSql());
  if (result.status !== 0) {
    throw new Error((result.stderr || "failed to ensure coach schema").trim());
  }
  schemaEnsured = true;
}

export function buildCoachConversationUpsertSql(input: CoachConversationInput): string {
  return `
INSERT INTO coach_conversation_log (
  source_key, ts_utc, channel, direction, message_text, intent, tags, linked_state_date, linked_decision_key, parsed_entities
) VALUES (
  ${sqlText(input.sourceKey)},
  COALESCE(${sqlText(input.tsUtc)}::timestamptz, now()),
  ${sqlText(input.channel)},
  ${sqlText(input.direction)}::coach_direction,
  ${sqlText(input.messageText)},
  ${sqlText(input.intent ?? null)},
  ${sqlJson(input.tags ?? null)},
  ${sqlText(input.linkedStateDate ?? null)}::date,
  ${sqlText(input.linkedDecisionKey ?? null)},
  ${sqlJson(input.parsedEntities ?? null)}
)
ON CONFLICT (source_key) DO UPDATE
SET
  ts_utc = EXCLUDED.ts_utc,
  channel = EXCLUDED.channel,
  direction = EXCLUDED.direction,
  message_text = EXCLUDED.message_text,
  intent = COALESCE(EXCLUDED.intent, coach_conversation_log.intent),
  tags = COALESCE(coach_conversation_log.tags, '{}'::jsonb) || COALESCE(EXCLUDED.tags, '{}'::jsonb),
  linked_state_date = COALESCE(EXCLUDED.linked_state_date, coach_conversation_log.linked_state_date),
  linked_decision_key = COALESCE(EXCLUDED.linked_decision_key, coach_conversation_log.linked_decision_key),
  parsed_entities = COALESCE(coach_conversation_log.parsed_entities, '{}'::jsonb) || COALESCE(EXCLUDED.parsed_entities, '{}'::jsonb);`;
}

export function buildCoachDecisionUpsertSql(input: CoachDecisionInput): string {
  return `
INSERT INTO coach_decision_log (
  ts_utc, readiness_call, longevity_impact, top_risk, reason_summary, prescribed_action,
  actual_day_strain, sleep_perf_pct, recovery_score, compliance_status,
  source_state_date, source_iso_week, expected_followup_by, decision_key, payload
) VALUES (
  COALESCE(${sqlText(input.tsUtc)}::timestamptz, now()),
  ${sqlText(input.readinessCall)},
  ${sqlText(input.longevityImpact)},
  ${sqlText(input.topRisk)},
  ${sqlText(input.reasonSummary)},
  ${sqlText(input.prescribedAction)},
  ${sqlNum(input.actualDayStrain)},
  ${sqlNum(input.sleepPerfPct)},
  ${sqlNum(input.recoveryScore)},
  ${sqlText(input.complianceStatus ?? null)},
  ${sqlText(input.sourceStateDate ?? null)}::date,
  ${sqlText(input.sourceIsoWeek ?? null)},
  ${sqlText(input.expectedFollowupBy ?? null)}::timestamptz,
  ${sqlText(input.decisionKey ?? null)},
  ${sqlJson(input.payload ?? null)}
)
ON CONFLICT (decision_key) DO UPDATE
SET
  ts_utc = EXCLUDED.ts_utc,
  readiness_call = EXCLUDED.readiness_call,
  longevity_impact = EXCLUDED.longevity_impact,
  top_risk = EXCLUDED.top_risk,
  reason_summary = EXCLUDED.reason_summary,
  prescribed_action = EXCLUDED.prescribed_action,
  actual_day_strain = EXCLUDED.actual_day_strain,
  sleep_perf_pct = EXCLUDED.sleep_perf_pct,
  recovery_score = EXCLUDED.recovery_score,
  compliance_status = COALESCE(EXCLUDED.compliance_status, coach_decision_log.compliance_status),
  source_state_date = COALESCE(EXCLUDED.source_state_date, coach_decision_log.source_state_date),
  source_iso_week = COALESCE(EXCLUDED.source_iso_week, coach_decision_log.source_iso_week),
  expected_followup_by = COALESCE(EXCLUDED.expected_followup_by, coach_decision_log.expected_followup_by),
  payload = COALESCE(coach_decision_log.payload, '{}'::jsonb) || COALESCE(EXCLUDED.payload, '{}'::jsonb);`;
}


export function upsertCoachConversation(input: CoachConversationInput): { ok: boolean; error?: string } {
  try {
    ensureCoachSchema();
    const result = runPsql(buildCoachConversationUpsertSql(input));
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || "coach conversation upsert failed").trim() };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function upsertCoachDecision(input: CoachDecisionInput): { ok: boolean; error?: string } {
  try {
    ensureCoachSchema();
    const result = runPsql(buildCoachDecisionUpsertSql(input));
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || "coach decision insert failed").trim() };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}


export function upsertCoachWeeklyScore(input: CoachWeeklyScoreInput): { ok: boolean; error?: string } {
  try {
    ensureCoachSchema();
    const safeScore = Math.max(0, Math.min(100, Math.round(input.score)));
    const sql = `
INSERT INTO coach_weekly_score (
  iso_week, week_start, week_end, score, summary, details
) VALUES (
  ${sqlText(input.isoWeek)},
  ${sqlText(input.weekStart)}::date,
  ${sqlText(input.weekEnd)}::date,
  ${safeScore},
  ${sqlText(input.summary ?? null)},
  ${sqlJson(input.details ?? null)}
)
ON CONFLICT (iso_week) DO UPDATE
SET
  week_start = EXCLUDED.week_start,
  week_end = EXCLUDED.week_end,
  score = EXCLUDED.score,
  summary = COALESCE(EXCLUDED.summary, coach_weekly_score.summary),
  details = COALESCE(EXCLUDED.details, coach_weekly_score.details),
  updated_at = now();`;
    const result = runPsql(sql);
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || "coach weekly score upsert failed").trim() };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}



export function updateLatestDecisionCompliance(input: {
  status: string;
  tsUtc?: string;
  note?: string | null;
}): { ok: boolean; error?: string } {
  try {
    ensureCoachSchema();
    const sql = `
UPDATE coach_decision_log
SET
  compliance_status = ${sqlText(input.status)},
  reason_summary = CASE
    WHEN ${sqlText(input.note ?? null)} IS NULL THEN reason_summary
    ELSE CONCAT(reason_summary, ' | compliance_note: ', ${sqlText(input.note ?? null)})
  END
WHERE id = (SELECT id FROM coach_decision_log ORDER BY ts_utc DESC LIMIT 1);`;
    const result = runPsql(sql);
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || "coach decision compliance update failed").trim() };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function upsertCoachNutrition(input: CoachNutritionInput): { ok: boolean; error?: string } {
  try {
    ensureCoachSchema();
    const sql = `
INSERT INTO coach_nutrition_log (
  date_local, protein_target_g, protein_actual_g, hydration_status, notes
) VALUES (
  ${sqlText(input.dateLocal)}::date,
  ${Math.trunc(input.proteinTargetG)},
  ${input.proteinActualG == null ? "NULL" : Math.max(0, Math.trunc(input.proteinActualG))},
  ${sqlText(input.hydrationStatus)},
  ${sqlText(input.notes ?? null)}
)
ON CONFLICT (date_local) DO UPDATE
SET
  protein_target_g = EXCLUDED.protein_target_g,
  protein_actual_g = COALESCE(EXCLUDED.protein_actual_g, coach_nutrition_log.protein_actual_g),
  hydration_status = COALESCE(NULLIF(EXCLUDED.hydration_status, ''), coach_nutrition_log.hydration_status),
  notes = COALESCE(EXCLUDED.notes, coach_nutrition_log.notes);
`;
    const result = runPsql(sql);
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || "coach nutrition upsert failed").trim() };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function upsertCoachCaffeine(input: CoachCaffeineInput): { ok: boolean; error?: string } {
  try {
    ensureCoachSchema();
    const safeAmount = Math.max(1, Math.min(1200, Math.round(input.amountMg)));
    const sql = `
INSERT INTO coach_caffeine_log (
  source_key, date_local, consumed_at_utc, amount_mg, source, notes
) VALUES (
  ${sqlText(input.sourceKey)},
  ${sqlText(input.dateLocal)}::date,
  ${sqlText(input.consumedAtUtc)}::timestamptz,
  ${safeAmount},
  ${sqlText(input.source ?? null)},
  ${sqlText(input.notes ?? null)}
)
ON CONFLICT (source_key) DO UPDATE
SET
  date_local = EXCLUDED.date_local,
  consumed_at_utc = EXCLUDED.consumed_at_utc,
  amount_mg = EXCLUDED.amount_mg,
  source = COALESCE(EXCLUDED.source, coach_caffeine_log.source),
  notes = COALESCE(EXCLUDED.notes, coach_caffeine_log.notes);`;
    const result = runPsql(sql);
    if (result.status !== 0) {
      return { ok: false, error: (result.stderr || "coach caffeine upsert failed").trim() };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function fetchCoachCaffeineDaySummary(dateLocal: string): CoachCaffeineDaySummary {
  ensureCoachSchema();
  const sql = `
SELECT COALESCE(row_to_json(t)::text, '{}') AS payload
FROM (
  SELECT
    ${sqlText(dateLocal)}::text AS date_local,
    COALESCE(SUM(amount_mg), 0)::int AS total_mg,
    COUNT(*)::int AS entries,
    MAX(consumed_at_utc)::text AS latest_consumed_at_utc,
    to_char(MAX(consumed_at_utc) AT TIME ZONE 'America/New_York', 'HH24:MI') AS latest_local_time,
    COALESCE(MAX(((consumed_at_utc AT TIME ZONE 'America/New_York')::time > TIME '13:00')), FALSE) AS latest_after_cutoff
  FROM coach_caffeine_log
  WHERE date_local = ${sqlText(dateLocal)}::date
) t;`;
  const result = runPsql(sql);
  if (result.status !== 0) {
    return {
      date_local: dateLocal,
      total_mg: 0,
      entries: 0,
      latest_consumed_at_utc: null,
      latest_local_time: null,
      latest_after_cutoff: false,
    };
  }
  const parsed = parseSingleJsonLine<CoachCaffeineDaySummary>(String(result.stdout ?? ""));
  return parsed ?? {
    date_local: dateLocal,
    total_mg: 0,
    entries: 0,
    latest_consumed_at_utc: null,
    latest_local_time: null,
    latest_after_cutoff: false,
  };
}

export function fetchCoachCaffeineWindowSummary(startYmd: string, endYmd: string): {
  days_with_entries: number;
  total_mg: number;
  avg_daily_mg: number | null;
  late_intake_days: number;
} {
  ensureCoachSchema();
  const sql = `
SELECT COALESCE(row_to_json(t)::text, '{}') AS payload
FROM (
  SELECT
    COUNT(DISTINCT date_local)::int AS days_with_entries,
    COALESCE(SUM(amount_mg), 0)::int AS total_mg,
    CASE WHEN COUNT(DISTINCT date_local) = 0 THEN NULL
      ELSE ROUND((SUM(amount_mg)::numeric / COUNT(DISTINCT date_local)), 2)
    END AS avg_daily_mg,
    COUNT(DISTINCT date_local) FILTER (
      WHERE (consumed_at_utc AT TIME ZONE 'America/New_York')::time > TIME '13:00'
    )::int AS late_intake_days
  FROM coach_caffeine_log
  WHERE date_local BETWEEN ${sqlText(startYmd)}::date AND ${sqlText(endYmd)}::date
) t;`;
  const result = runPsql(sql);
  if (result.status !== 0) {
    return { days_with_entries: 0, total_mg: 0, avg_daily_mg: null, late_intake_days: 0 };
  }
  const parsed = parseSingleJsonLine<{ days_with_entries?: number; total_mg?: number; avg_daily_mg?: number | null; late_intake_days?: number }>(
    String(result.stdout ?? ""),
  );
  return {
    days_with_entries: Number(parsed?.days_with_entries ?? 0),
    total_mg: Number(parsed?.total_mg ?? 0),
    avg_daily_mg: parsed?.avg_daily_mg == null ? null : Number(parsed.avg_daily_mg),
    late_intake_days: Number(parsed?.late_intake_days ?? 0),
  };
}
