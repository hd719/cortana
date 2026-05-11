#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { runPsql } from "../lib/db.js";

type JsonRecord = Record<string, unknown>;

export type SpartanWhoopCoachingLane = "post_workout" | "wake_recovery" | "audit_only";

export type WhoopEventAnalysisCandidate = {
  trace_id: string;
  event_type: string;
  resource_id: string | null;
  whoop_user_id: string | null;
  observed_at: string | null;
  artifact: JsonRecord;
  created_at: string;
};

const CLAIM_WINDOW_MINUTES = 15;
const DEFAULT_LOOKBACK_MINUTES = 180;
const TIME_ZONE = "America/New_York";

function esc(value: string): string {
  return value.replace(/'/g, "''");
}

function sqlText(value: string | null | undefined): string {
  if (!value) return "NULL";
  return `'${esc(value)}'`;
}

function sqlJson(value: JsonRecord): string {
  return `'${esc(JSON.stringify(value))}'::jsonb`;
}

function toObject(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function parseJsonArray<T>(raw: string): T[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

export function whoopEventLookbackMinutes(env = process.env): number {
  const raw = env.SPARTAN_WHOOP_EVENT_LOOKBACK_MINUTES;
  if (!raw) return DEFAULT_LOOKBACK_MINUTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LOOKBACK_MINUTES;
}

function runJsonScript(scriptPath: string): JsonRecord {
  const result = spawnSync("npx", ["tsx", scriptPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 24 * 1024 * 1024,
  });
  if ((result.status ?? 1) !== 0) {
    return {
      error: (result.stderr || `script failed: ${scriptPath}`).trim(),
    };
  }
  const text = String(result.stdout ?? "").trim();
  if (!text) return {};
  try {
    return toObject(JSON.parse(text));
  } catch (error) {
    return {
      error: `invalid_json_from:${scriptPath}:${error instanceof Error ? error.message : String(error)}`,
      raw_preview: text.slice(0, 500),
    };
  }
}

export function coachingLaneForWhoopEvent(eventType: string): SpartanWhoopCoachingLane {
  if (eventType === "workout.updated") return "post_workout";
  if (eventType === "sleep.updated" || eventType === "recovery.updated") return "wake_recovery";
  return "audit_only";
}

export function localDateForEvent(observedAt: string | null | undefined, timeZone = TIME_ZONE): string {
  const date = observedAt ? new Date(observedAt) : new Date();
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(safe);
}

export function buildWhoopCoachingIdempotencyKey(input: {
  eventType: string;
  resourceId?: string | null;
  observedAt?: string | null;
  whoopUserId?: string | null;
}): string | null {
  const lane = coachingLaneForWhoopEvent(input.eventType);
  if (lane === "post_workout") {
    const resource = input.resourceId?.trim();
    return resource ? `whoop:workout:${input.whoopUserId ?? "default"}:${resource}` : null;
  }
  if (lane === "wake_recovery") {
    return `whoop:wake-recovery:${input.whoopUserId ?? "default"}:${localDateForEvent(input.observedAt)}`;
  }
  return null;
}

export function buildSpartanCoachingReason(input: {
  lane: SpartanWhoopCoachingLane;
  eventType: string;
  artifact: JsonRecord;
}): string {
  const summary = toObject(input.artifact.summary);
  const headline = typeof summary.headline === "string" ? summary.headline : input.eventType;
  if (input.lane === "post_workout") return `${headline}; use latest load and recovery context for post-workout coaching.`;
  if (input.lane === "wake_recovery") return `${headline}; use latest sleep/recovery context for wake-up coaching.`;
  return `${headline}; retained for audit only.`;
}

export function buildSpartanEventCoachingSchemaSql(): string {
  return `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS spartan_event_coaching_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text UNIQUE NOT NULL,
  lane text NOT NULL CHECK (lane IN ('post_workout','wake_recovery')),
  source text NOT NULL DEFAULT 'whoop_webhook',
  trace_id text NOT NULL,
  event_type text NOT NULL,
  resource_id text,
  status text NOT NULL CHECK (status IN ('claimed','delivered','failed')),
  artifact jsonb NOT NULL DEFAULT '{}'::jsonb,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spartan_event_coaching_status ON spartan_event_coaching_log(status, claimed_at DESC);
CREATE INDEX IF NOT EXISTS idx_spartan_event_coaching_trace ON spartan_event_coaching_log(trace_id);
`;
}

function ensureSchema(): void {
  const result = runPsql(buildSpartanEventCoachingSchemaSql());
  if (result.status !== 0) {
    throw new Error((result.stderr || "failed to ensure spartan event coaching schema").trim());
  }
}

function fetchRecentCandidates(): WhoopEventAnalysisCandidate[] {
  const result = runPsql(`
SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)::text
FROM (
  SELECT
    a.trace_id,
    a.artifact,
    COALESCE(a.artifact->>'event_type', e.event_type) AS event_type,
    COALESCE(a.artifact->>'resource_id', e.resource_id) AS resource_id,
    e.whoop_user_id,
    COALESCE(a.artifact->>'observed_at', e.received_at::text) AS observed_at,
    a.created_at::text AS created_at
  FROM whoop_event_analysis a
  JOIN whoop_webhook_events e ON e.trace_id = a.trace_id
  WHERE a.notification_status = 'sent'
    AND COALESCE(a.artifact->'policy'->>'decision', '') = 'SEND'
    AND a.created_at >= now() - interval '${whoopEventLookbackMinutes()} minutes'
  ORDER BY a.created_at ASC
) t;
`);
  if (result.status !== 0) {
    throw new Error((result.stderr || "failed to fetch whoop event analysis candidates").trim());
  }
  return parseJsonArray<WhoopEventAnalysisCandidate>(String(result.stdout ?? ""));
}

function claimCandidate(candidate: WhoopEventAnalysisCandidate, lane: Exclude<SpartanWhoopCoachingLane, "audit_only">, idempotencyKey: string): boolean {
  const artifact = {
    ...candidate.artifact,
    spartan_event_coaching: {
      lane,
      idempotency_key: idempotencyKey,
      reason: buildSpartanCoachingReason({ lane, eventType: candidate.event_type, artifact: candidate.artifact }),
    },
  };
  const result = runPsql(`
WITH claimed AS (
  INSERT INTO spartan_event_coaching_log (
    idempotency_key, lane, trace_id, event_type, resource_id, status, artifact, claimed_at, error
  ) VALUES (
    ${sqlText(idempotencyKey)},
    ${sqlText(lane)},
    ${sqlText(candidate.trace_id)},
    ${sqlText(candidate.event_type)},
    ${sqlText(candidate.resource_id)},
    'claimed',
    ${sqlJson(artifact)},
    now(),
    NULL
  )
  ON CONFLICT (idempotency_key) DO UPDATE
  SET
    status = 'claimed',
    trace_id = EXCLUDED.trace_id,
    event_type = EXCLUDED.event_type,
    resource_id = EXCLUDED.resource_id,
    artifact = EXCLUDED.artifact,
    claimed_at = now(),
    error = NULL,
    updated_at = now()
  WHERE spartan_event_coaching_log.status = 'failed'
     OR (spartan_event_coaching_log.status = 'claimed' AND spartan_event_coaching_log.claimed_at < now() - interval '${CLAIM_WINDOW_MINUTES} minutes')
  RETURNING idempotency_key
)
SELECT COALESCE((SELECT idempotency_key FROM claimed), '') AS idempotency_key;
`);
  if (result.status !== 0) {
    throw new Error((result.stderr || "failed to claim spartan event coaching candidate").trim());
  }
  return String(result.stdout ?? "").trim() === idempotencyKey;
}

function markDelivered(idempotencyKey: string): void {
  const result = runPsql(`
UPDATE spartan_event_coaching_log
SET status = 'delivered', delivered_at = now(), error = NULL, updated_at = now()
WHERE idempotency_key = ${sqlText(idempotencyKey)};
`);
  if (result.status !== 0) throw new Error((result.stderr || "failed to mark event coaching delivered").trim());
}

function markFailed(idempotencyKey: string, error: string): void {
  const result = runPsql(`
UPDATE spartan_event_coaching_log
SET status = 'failed', error = ${sqlText(error.slice(0, 1000))}, updated_at = now()
WHERE idempotency_key = ${sqlText(idempotencyKey)};
`);
  if (result.status !== 0) throw new Error((result.stderr || "failed to mark event coaching failed").trim());
}

function buildFitnessContext(lane: SpartanWhoopCoachingLane): JsonRecord {
  if (lane === "wake_recovery") {
    return runJsonScript("/Users/hd/Developer/cortana/tools/fitness/morning-brief-data.ts");
  }
  if (lane === "post_workout") {
    return runJsonScript("/Users/hd/Developer/cortana/tools/fitness/evening-recap-data.ts");
  }
  return {};
}

function main(): void {
  const markDeliveredArg = process.argv.find((arg) => arg.startsWith("--mark-delivered="));
  if (markDeliveredArg) {
    ensureSchema();
    const key = markDeliveredArg.split("=")[1] ?? "";
    markDelivered(key);
    process.stdout.write(`${JSON.stringify({ ok: true, idempotency_key: key, status: "delivered" })}\n`);
    return;
  }

  const markFailedArg = process.argv.find((arg) => arg.startsWith("--mark-failed="));
  if (markFailedArg) {
    ensureSchema();
    const key = markFailedArg.split("=")[1] ?? "";
    const error = process.argv.find((arg) => arg.startsWith("--error="))?.split("=").slice(1).join("=") ?? "unknown";
    markFailed(key, error);
    process.stdout.write(`${JSON.stringify({ ok: true, idempotency_key: key, status: "failed" })}\n`);
    return;
  }

  ensureSchema();
  const candidates = fetchRecentCandidates();
  for (const candidate of candidates) {
    const lane = coachingLaneForWhoopEvent(candidate.event_type);
    if (lane === "audit_only") continue;
    const whoopUserId = candidate.whoop_user_id ?? (typeof candidate.artifact.whoop_user_id === "string" ? candidate.artifact.whoop_user_id : null);
    const idempotencyKey = buildWhoopCoachingIdempotencyKey({
      eventType: candidate.event_type,
      resourceId: candidate.resource_id,
      observedAt: candidate.observed_at,
      whoopUserId,
    });
    if (!idempotencyKey) continue;
    if (!claimCandidate(candidate, lane, idempotencyKey)) continue;

    const fitnessContext = buildFitnessContext(lane);
    process.stdout.write(`${JSON.stringify({
      generated_at: new Date().toISOString(),
      source: "whoop_webhook",
      coaching_lane: lane,
      idempotency_key: idempotencyKey,
      event_type: candidate.event_type,
      trace_id: candidate.trace_id,
      resource_id: candidate.resource_id,
      observed_at: candidate.observed_at,
      event_artifact: candidate.artifact,
      fitness_context: fitnessContext,
      mark_delivered_command: `npx tsx /Users/hd/Developer/cortana/tools/fitness/whoop-event-coaching-data.ts --mark-delivered=${idempotencyKey}`,
      mark_failed_command: `npx tsx /Users/hd/Developer/cortana/tools/fitness/whoop-event-coaching-data.ts --mark-failed=${idempotencyKey} --error=<reason>`,
    })}\n`);
    return;
  }

  process.stdout.write("NO_REPLY\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
