#!/usr/bin/env npx tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { runPsql, withPostgresPath } from "../lib/db.js";
import {
  SEVERITY_RANK,
  defaultRequiredAction,
  defaultVerificationKey,
  normalizeHumanActionCategory,
  normalizeHumanActionSeverity,
  normalizeHumanActionStatus,
  normalizeHumanActionSystem,
  normalizeVerificationKey,
  type HumanActionCategory,
  type HumanActionSeverity,
  type HumanActionStatus,
  type HumanActionSystem,
  type HumanActionVerificationKey,
} from "./human-required-taxonomy.js";

export type HumanRequiredActionInput = {
  fingerprint?: string;
  system: HumanActionSystem | string;
  category: HumanActionCategory | string;
  ownerLane?: string;
  severity?: HumanActionSeverity | string;
  summary: string;
  requiredAction?: string;
  verificationKey?: HumanActionVerificationKey | string | null;
  verificationArgs?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  dueAt?: string | null;
  nextRemindAt?: string | null;
};

export type HumanRequiredActionRow = {
  id: number;
  fingerprint: string;
  system: HumanActionSystem;
  category: HumanActionCategory;
  owner_lane: string;
  severity: HumanActionSeverity;
  status: HumanActionStatus;
  summary: string;
  required_action: string;
  verification_key: HumanActionVerificationKey | null;
  verification_args: Record<string, unknown>;
  evidence: Record<string, unknown>;
  metadata: Record<string, unknown>;
  material_digest: string;
  detection_count: number;
  alert_count: number;
  first_seen_at: string;
  last_seen_at: string;
  next_remind_at: string | null;
  due_at: string | null;
  verified_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
};

export type NormalizedHumanRequiredAction = {
  fingerprint: string;
  system: HumanActionSystem;
  category: HumanActionCategory;
  ownerLane: string;
  severity: HumanActionSeverity;
  summary: string;
  requiredAction: string;
  verificationKey: HumanActionVerificationKey | null;
  verificationArgs: Record<string, unknown>;
  evidence: Record<string, unknown>;
  metadata: Record<string, unknown>;
  materialDigest: string;
  dueAt: string | null;
  nextRemindAt: string | null;
};

export type UpsertResult = {
  row: HumanRequiredActionRow;
  created: boolean;
  materiallyChanged: boolean;
  severityIncreased: boolean;
  shouldAlert: boolean;
};

export type HumanRequiredActionStore = {
  ensureSchema(): void;
  findOpenByFingerprint(fingerprint: string): HumanRequiredActionRow | null;
  create(input: NormalizedHumanRequiredAction, nowIso: string, alertCount: number): HumanRequiredActionRow;
  updateOpen(existing: HumanRequiredActionRow, input: NormalizedHumanRequiredAction, nowIso: string, alertIncrement: number): HumanRequiredActionRow;
  getById(id: number): HumanRequiredActionRow | null;
  list(status: HumanActionStatus | "all", limit: number): HumanRequiredActionRow[];
  close(id: number, status: Exclude<HumanActionStatus, "open">, resolvedBy: string, note: string | null, nowIso: string): HumanRequiredActionRow;
};

const SECRET_KEY_PATTERN = /(token|secret|password|cookie|authorization|api[_-]?key|refresh[_-]?token|access[_-]?token)/i;
const VOLATILE_KEY_PATTERN = /(timestamp|updated_at|created_at|observed_at|last_seen|first_seen|stack|trace|raw|counter|count)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sqlLiteral(value: string | null): string {
  if (value === null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

function jsonLiteral(value: unknown): string {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

function normalizeText(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed.slice(0, 1000);
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!isRecord(value)) {
    if (typeof value !== "string") return value;
    return value
      .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]")
      .replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[REDACTED_TOKEN]")
      .replace(/((?:token|secret|password|api[_-]?key)\s*[:=]\s*)[^\s'"]+/gi, "$1[REDACTED]");
  }

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactSecrets(inner);
  }
  return out;
}

function materialize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(materialize);
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (VOLATILE_KEY_PATTERN.test(key)) continue;
    out[key] = materialize(value[key]);
  }
  return out;
}

export function materialDigest(input: {
  system: HumanActionSystem;
  category: HumanActionCategory;
  severity: HumanActionSeverity;
  requiredAction: string;
  verificationKey: HumanActionVerificationKey | null;
  evidence: Record<string, unknown>;
}): string {
  const stable = JSON.stringify(materialize(input));
  return createHash("sha256").update(stable).digest("hex");
}

function defaultFingerprint(input: {
  system: HumanActionSystem;
  category: HumanActionCategory;
  ownerLane: string;
  summary: string;
  verificationKey: HumanActionVerificationKey | null;
}): string {
  return [
    input.system,
    input.category,
    input.ownerLane,
    input.verificationKey ?? "manual",
    input.summary.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80),
  ].join(":");
}

export function normalizeHumanRequiredActionInput(input: HumanRequiredActionInput): NormalizedHumanRequiredAction {
  const system = normalizeHumanActionSystem(input.system);
  const category = normalizeHumanActionCategory(input.category);
  const ownerLane = (input.ownerLane ?? "monitor").trim() || "monitor";
  const severity = normalizeHumanActionSeverity(input.severity ?? "warning");
  const summary = normalizeText(input.summary, "summary");
  const requiredAction = normalizeText(input.requiredAction ?? defaultRequiredAction(system), "requiredAction");
  const verificationKey = normalizeVerificationKey(input.verificationKey ?? defaultVerificationKey(system));
  const verificationArgs = isRecord(input.verificationArgs) ? input.verificationArgs : {};
  const evidence = redactSecrets(isRecord(input.evidence) ? input.evidence : {}) as Record<string, unknown>;
  const metadata = redactSecrets(isRecord(input.metadata) ? input.metadata : {}) as Record<string, unknown>;
  const fingerprint = normalizeText(input.fingerprint ?? defaultFingerprint({ system, category, ownerLane, summary, verificationKey }), "fingerprint");
  const digest = materialDigest({ system, category, severity, requiredAction, verificationKey, evidence });

  return {
    fingerprint,
    system,
    category,
    ownerLane,
    severity,
    summary,
    requiredAction,
    verificationKey,
    verificationArgs,
    evidence,
    metadata,
    materialDigest: digest,
    dueAt: input.dueAt ?? null,
    nextRemindAt: input.nextRemindAt ?? null,
  };
}

export function decideAlert(existing: HumanRequiredActionRow | null, input: NormalizedHumanRequiredAction, now = new Date()): {
  created: boolean;
  materiallyChanged: boolean;
  severityIncreased: boolean;
  due: boolean;
  shouldAlert: boolean;
} {
  if (!existing) return { created: true, materiallyChanged: true, severityIncreased: false, due: false, shouldAlert: true };
  const materiallyChanged = existing.material_digest !== input.materialDigest || existing.required_action !== input.requiredAction || existing.verification_key !== input.verificationKey;
  const severityIncreased = SEVERITY_RANK[input.severity] > SEVERITY_RANK[existing.severity];
  const due = Boolean(existing.due_at && Date.parse(existing.due_at) <= now.getTime());
  return {
    created: false,
    materiallyChanged,
    severityIncreased,
    due,
    shouldAlert: materiallyChanged || severityIncreased || due,
  };
}

function parseRow(raw: string): HumanRequiredActionRow | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed) as HumanRequiredActionRow;
}

function parseRows(raw: string): HumanRequiredActionRow[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed as HumanRequiredActionRow[] : [];
}

export class PsqlHumanRequiredActionStore implements HumanRequiredActionStore {
  constructor(private readonly db = process.env.CORTANA_DB ?? "cortana") {}

  private query(sql: string): string {
    const proc = runPsql(sql, {
      db: this.db,
      args: ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
      env: withPostgresPath(process.env),
    });
    if (proc.status !== 0) throw new Error((proc.stderr || proc.stdout || "psql failed").trim());
    return String(proc.stdout ?? "").trim();
  }

  ensureSchema(): void {
    this.query(`
      CREATE TABLE IF NOT EXISTS cortana_human_required_actions (
        id BIGSERIAL PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        system TEXT NOT NULL,
        category TEXT NOT NULL,
        owner_lane TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        summary TEXT NOT NULL,
        required_action TEXT NOT NULL,
        verification_key TEXT NULL,
        verification_args JSONB NOT NULL DEFAULT '{}'::jsonb,
        evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        material_digest TEXT NOT NULL,
        detection_count INTEGER NOT NULL DEFAULT 1,
        alert_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        next_remind_at TIMESTAMPTZ NULL,
        due_at TIMESTAMPTZ NULL,
        verified_at TIMESTAMPTZ NULL,
        resolved_at TIMESTAMPTZ NULL,
        resolved_by TEXT NULL,
        resolution_note TEXT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_human_required_actions_open_fingerprint
        ON cortana_human_required_actions (fingerprint)
        WHERE status = 'open';
      CREATE INDEX IF NOT EXISTS idx_human_required_actions_status_due
        ON cortana_human_required_actions (status, due_at);
      CREATE INDEX IF NOT EXISTS idx_human_required_actions_system_seen
        ON cortana_human_required_actions (system, last_seen_at DESC);
    `);
  }

  findOpenByFingerprint(fingerprint: string): HumanRequiredActionRow | null {
    return parseRow(this.query(`SELECT row_to_json(t)::text FROM cortana_human_required_actions t WHERE status = 'open' AND fingerprint = ${sqlLiteral(fingerprint)} LIMIT 1;`));
  }

  getById(id: number): HumanRequiredActionRow | null {
    return parseRow(this.query(`SELECT row_to_json(t)::text FROM cortana_human_required_actions t WHERE id = ${Math.trunc(id)} LIMIT 1;`));
  }

  create(input: NormalizedHumanRequiredAction, nowIso: string, alertCount: number): HumanRequiredActionRow {
    return parseRow(this.query(`
      INSERT INTO cortana_human_required_actions (
        fingerprint, system, category, owner_lane, severity, status, summary, required_action,
        verification_key, verification_args, evidence, metadata, material_digest, detection_count,
        alert_count, first_seen_at, last_seen_at, next_remind_at, due_at
      ) VALUES (
        ${sqlLiteral(input.fingerprint)}, ${sqlLiteral(input.system)}, ${sqlLiteral(input.category)},
        ${sqlLiteral(input.ownerLane)}, ${sqlLiteral(input.severity)}, 'open', ${sqlLiteral(input.summary)},
        ${sqlLiteral(input.requiredAction)}, ${sqlLiteral(input.verificationKey)}, ${jsonLiteral(input.verificationArgs)},
        ${jsonLiteral(input.evidence)}, ${jsonLiteral(input.metadata)}, ${sqlLiteral(input.materialDigest)},
        1, ${Math.trunc(alertCount)}, ${sqlLiteral(nowIso)}::timestamptz, ${sqlLiteral(nowIso)}::timestamptz,
        ${sqlLiteral(input.nextRemindAt)}::timestamptz, ${sqlLiteral(input.dueAt)}::timestamptz
      )
      RETURNING row_to_json(cortana_human_required_actions)::text;
    `))!;
  }

  updateOpen(existing: HumanRequiredActionRow, input: NormalizedHumanRequiredAction, nowIso: string, alertIncrement: number): HumanRequiredActionRow {
    return parseRow(this.query(`
      UPDATE cortana_human_required_actions
      SET system = ${sqlLiteral(input.system)},
          category = ${sqlLiteral(input.category)},
          owner_lane = ${sqlLiteral(input.ownerLane)},
          severity = ${sqlLiteral(input.severity)},
          summary = ${sqlLiteral(input.summary)},
          required_action = ${sqlLiteral(input.requiredAction)},
          verification_key = ${sqlLiteral(input.verificationKey)},
          verification_args = ${jsonLiteral(input.verificationArgs)},
          evidence = ${jsonLiteral(input.evidence)},
          metadata = ${jsonLiteral(input.metadata)},
          material_digest = ${sqlLiteral(input.materialDigest)},
          detection_count = detection_count + 1,
          alert_count = alert_count + ${Math.trunc(alertIncrement)},
          last_seen_at = ${sqlLiteral(nowIso)}::timestamptz,
          next_remind_at = COALESCE(${sqlLiteral(input.nextRemindAt)}::timestamptz, next_remind_at),
          due_at = COALESCE(${sqlLiteral(input.dueAt)}::timestamptz, due_at)
      WHERE id = ${Math.trunc(existing.id)}
      RETURNING row_to_json(cortana_human_required_actions)::text;
    `))!;
  }

  list(status: HumanActionStatus | "all", limit: number): HumanRequiredActionRow[] {
    const where = status === "all" ? "TRUE" : `status = ${sqlLiteral(status)}`;
    return parseRows(this.query(`
      SELECT COALESCE(json_agg(t ORDER BY last_seen_at DESC), '[]'::json)::text
      FROM (
        SELECT * FROM cortana_human_required_actions
        WHERE ${where}
        ORDER BY last_seen_at DESC
        LIMIT ${Math.max(1, Math.min(200, Math.trunc(limit)))}
      ) t;
    `));
  }

  close(id: number, status: Exclude<HumanActionStatus, "open">, resolvedBy: string, note: string | null, nowIso: string): HumanRequiredActionRow {
    return parseRow(this.query(`
      UPDATE cortana_human_required_actions
      SET status = ${sqlLiteral(status)},
          resolved_at = ${sqlLiteral(nowIso)}::timestamptz,
          resolved_by = ${sqlLiteral(resolvedBy)},
          resolution_note = ${sqlLiteral(note)}
      WHERE id = ${Math.trunc(id)}
      RETURNING row_to_json(cortana_human_required_actions)::text;
    `))!;
  }
}

export function upsertHumanRequiredAction(input: HumanRequiredActionInput, opts: { store?: HumanRequiredActionStore; now?: Date } = {}): UpsertResult {
  const store = opts.store ?? new PsqlHumanRequiredActionStore();
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const normalized = normalizeHumanRequiredActionInput(input);
  store.ensureSchema();
  const existing = store.findOpenByFingerprint(normalized.fingerprint);
  const decision = decideAlert(existing, normalized, now);
  const row = existing
    ? store.updateOpen(existing, normalized, nowIso, decision.shouldAlert ? 1 : 0)
    : store.create(normalized, nowIso, 1);
  return { row, ...decision };
}

export function listHumanRequiredActions(opts: { store?: HumanRequiredActionStore; status?: HumanActionStatus | "all"; limit?: number } = {}): HumanRequiredActionRow[] {
  const store = opts.store ?? new PsqlHumanRequiredActionStore();
  store.ensureSchema();
  return store.list(opts.status ?? "open", opts.limit ?? 50);
}

export function closeHumanRequiredAction(id: number, opts: { store?: HumanRequiredActionStore; status?: Exclude<HumanActionStatus, "open">; resolvedBy?: string; note?: string | null; now?: Date } = {}): HumanRequiredActionRow {
  const store = opts.store ?? new PsqlHumanRequiredActionStore();
  store.ensureSchema();
  return store.close(id, opts.status ?? "resolved", opts.resolvedBy ?? "monitor", opts.note ?? null, (opts.now ?? new Date()).toISOString());
}

export function digestHumanRequiredActions(opts: { store?: HumanRequiredActionStore; limit?: number } = {}): string {
  const rows = listHumanRequiredActions({ store: opts.store, status: "open", limit: opts.limit ?? 10 });
  if (rows.length === 0) return "NO_REPLY";
  return [
    `Human-required actions open: ${rows.length}`,
    ...rows.slice(0, opts.limit ?? 10).map((row) => `- ${row.severity}: ${row.summary} — ${row.required_action}`),
  ].join("\n");
}

export function verifyHumanRequiredAction(id: number, opts: { store?: HumanRequiredActionStore; now?: Date } = {}): { ok: boolean; row: HumanRequiredActionRow; detail: string } {
  const store = opts.store ?? new PsqlHumanRequiredActionStore();
  store.ensureSchema();
  const row = store.getById(id);
  if (!row) throw new Error(`human-required action not found: ${id}`);
  if (!row.verification_key) return { ok: false, row, detail: "no verification key configured" };

  const result = runVerification(row.verification_key, row.verification_args);
  if (!result.ok) return { ok: false, row, detail: result.detail };

  const closed = store.close(id, "verified", "verification", result.detail, (opts.now ?? new Date()).toISOString());
  return { ok: true, row: closed, detail: result.detail };
}

function runVerification(key: HumanActionVerificationKey, args: Record<string, unknown>): { ok: boolean; detail: string } {
  if (key === "openclaw_gateway_health") {
    const proc = spawnSync("openclaw", ["gateway", "status", "--no-probe"], { encoding: "utf8", timeout: 15000 });
    return { ok: proc.status === 0, detail: (proc.stdout || proc.stderr || "").trim().slice(0, 500) || `exit=${proc.status}` };
  }
  if (key === "browser_cdp_health") {
    const url = typeof args.cdpUrl === "string" ? args.cdpUrl : "";
    if (!url) return { ok: false, detail: "missing cdpUrl verification arg" };
    const target = url.endsWith("/") ? `${url}json/version` : `${url}/json/version`;
    const proc = spawnSync("curl", ["-sSf", "--max-time", "6", target], { encoding: "utf8", timeout: 10000 });
    return { ok: proc.status === 0, detail: (proc.stdout || proc.stderr || target).trim().slice(0, 500) };
  }
  if (key === "apple_health_freshness") {
    const file = typeof args.path === "string" ? args.path : path.join(os.homedir(), ".openclaw", "data", "apple-health", "latest.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      const generatedAt = typeof parsed.generated_at === "string" ? parsed.generated_at : typeof parsed.generatedAt === "string" ? parsed.generatedAt : "";
      const maxAgeSeconds = Number(args.maxAgeSeconds ?? 129600);
      const ageSeconds = generatedAt ? (Date.now() - Date.parse(generatedAt)) / 1000 : Number.POSITIVE_INFINITY;
      return { ok: Number.isFinite(ageSeconds) && ageSeconds <= maxAgeSeconds, detail: generatedAt ? `apple health age_seconds=${Math.round(ageSeconds)}` : "missing generated_at metadata" };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, detail: detail.slice(0, 500) };
    }
  }
  return { ok: false, detail: `unsupported verification key: ${key}` };
}

export function fixtureInput(name: string): HumanRequiredActionInput {
  if (name === "apple-health") {
    return {
      fingerprint: "apple_health:human_setup:latest_export",
      system: "apple_health",
      category: "human_setup",
      ownerLane: "monitor",
      severity: "warning",
      summary: "Apple Health export needs attention",
      requiredAction: defaultRequiredAction("apple_health"),
      verificationKey: "apple_health_freshness",
      verificationArgs: { path: path.join(os.homedir(), ".openclaw", "data", "apple-health", "latest.json"), maxAgeSeconds: 129600 },
      evidence: { source: "fixture", latestJson: "invalid_or_stale" },
    };
  }
  throw new Error(`unknown fixture: ${name}`);
}
