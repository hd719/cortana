import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoPath, sourceRepoRoot } from "../lib/paths.js";
import type {
  Tier2ThresholdClass,
  VacationActionKind,
  VacationOpsConfig,
  VacationSystemDefinition,
  VacationTier,
} from "./types.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MODULE_REPO_ROOT = path.resolve(MODULE_DIR, "..", "..");
const CONFIG_RELATIVE_PATH = path.join("config", "vacation-ops.json");

function candidateConfigPaths(): string[] {
  return [
    process.env.CORTANA_VACATION_OPS_CONFIG_PATH,
    resolveRepoPath(CONFIG_RELATIVE_PATH),
    path.join(MODULE_REPO_ROOT, CONFIG_RELATIVE_PATH),
    path.join(sourceRepoRoot(), CONFIG_RELATIVE_PATH),
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
}

export function resolveVacationOpsConfigPath(): string {
  for (const candidate of candidateConfigPaths()) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(`Vacation ops config not found. Checked: ${candidateConfigPaths().join(", ")}`);
}

export const VACATION_OPS_CONFIG_PATH = resolveVacationOpsConfigPath();

export const REQUIRED_SYSTEM_KEYS = [
  "gateway_service",
  "telegram_delivery",
  "main_agent_delivery",
  "monitor_agent_delivery",
  "mission_control",
  "tailscale_remote_access",
  "runtime_integrity",
  "critical_synthetic_probe",
  "gog_headless_auth",
  "calendar_reminders_e2e",
  "apple_reminders_e2e",
  "morning_brief_e2e",
  "gmail_inbox_triage",
  "fitness_service",
  "schwab_quote_smoke",
  "backtester_app",
  "github_identity",
  "browser_cdp",
] as const;

const VALID_TIERS = new Set([0, 1, 2, 3]);
const VALID_TIER2_CLASSES = new Set<Tier2ThresholdClass>(["market_trading", "fitness_news", "background_intel"]);
const VALID_REMEDIATION_STEPS = new Set<VacationActionKind>([
  "retry",
  "restart_service",
  "runtime_sync",
  "restore_env",
  "rotate_session",
  "rerun_smoke",
  "alert_only",
]);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid vacation ops config: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTimeString(value: unknown): value is string {
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value);
}

function validateSystemDefinition(key: string, value: unknown): asserts value is VacationSystemDefinition {
  assert(isRecord(value), `system ${key} must be an object`);
  const tier = Number(value.tier);
  assert(Number.isInteger(tier) && VALID_TIERS.has(tier as VacationTier), `system ${key} has invalid tier`);
  assert(typeof value.required === "boolean", `system ${key} must declare required`);
  assert(typeof value.probe === "string" && value.probe.trim().length > 0, `system ${key} must declare probe`);
  assert(
    typeof value.freshnessSource === "string" && value.freshnessSource.trim().length > 0,
    `system ${key} must declare freshnessSource`,
  );
  assert(Array.isArray(value.remediation) && value.remediation.length > 0, `system ${key} must declare remediation`);
  for (const step of value.remediation) {
    assert(typeof step === "string" && VALID_REMEDIATION_STEPS.has(step as VacationActionKind), `system ${key} remediation contains invalid step`);
  }
  if (value.tier2Class != null) {
    assert(typeof value.tier2Class === "string" && VALID_TIER2_CLASSES.has(value.tier2Class as Tier2ThresholdClass), `system ${key} has invalid tier2Class`);
  }
}

export function parseVacationOpsConfig(raw: unknown): VacationOpsConfig {
  assert(isRecord(raw), "root must be an object");
  assert(Number.isInteger(Number(raw.version)), "version must be an integer");
  assert(typeof raw.timezone === "string" && raw.timezone.trim().length > 0, "timezone is required");
  assert(isRecord(raw.summaryTimes), "summaryTimes is required");
  assert(isTimeString(raw.summaryTimes.morning), "summaryTimes.morning must be HH:MM");
  assert(isTimeString(raw.summaryTimes.evening), "summaryTimes.evening must be HH:MM");
  assert(Number(raw.readinessFreshnessHours) > 0, "readinessFreshnessHours must be > 0");
  assert(Number(raw.authorizationFreshnessHours) > 0, "authorizationFreshnessHours must be > 0");
  assert(Array.isArray(raw.pausedJobIds), "pausedJobIds must be an array");
  assert(raw.pausedJobIds.includes("af9e1570-3ba2-4d10-a807-91cdfc2df18b"), "pausedJobIds must include Daily Auto-Update");
  assert(Array.isArray(raw.remediationLadder) && raw.remediationLadder.length > 0, "remediationLadder must be a non-empty array");
  for (const step of raw.remediationLadder) {
    assert(typeof step === "string" && VALID_REMEDIATION_STEPS.has(step as VacationActionKind), `invalid remediation ladder step: ${String(step)}`);
  }
  assert(isRecord(raw.guard), "guard config is required");
  assert(Array.isArray(raw.guard.fragileCronMatchers), "guard.fragileCronMatchers must be an array");
  assert(Number(raw.guard.quarantineAfterConsecutiveErrors) >= 1, "guard.quarantineAfterConsecutiveErrors must be >= 1");
  assert(isRecord(raw.tier2Thresholds), "tier2Thresholds is required");
  assert(isRecord(raw.systems), "systems is required");

  for (const key of REQUIRED_SYSTEM_KEYS) {
    assert(key in raw.systems, `missing required system key ${key}`);
  }

  for (const [key, value] of Object.entries(raw.systems)) {
    validateSystemDefinition(key, value);
  }

  return raw as VacationOpsConfig;
}

export function loadVacationOpsConfig(configPath = resolveVacationOpsConfigPath()): VacationOpsConfig {
  return parseVacationOpsConfig(JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown);
}
