export const HUMAN_ACTION_CATEGORIES = [
  "human_auth",
  "human_permission",
  "human_setup",
  "human_portal",
  "human_browser",
] as const;

export const HUMAN_ACTION_SYSTEMS = [
  "apple_health",
  "browser_session",
  "google_oauth",
  "openai_auth",
  "schwab",
  "system",
] as const;

export const HUMAN_ACTION_SEVERITIES = ["info", "warning", "critical"] as const;
export const HUMAN_ACTION_STATUSES = ["open", "verified", "resolved", "ignored", "expired"] as const;

export type HumanActionCategory = typeof HUMAN_ACTION_CATEGORIES[number];
export type HumanActionSystem = typeof HUMAN_ACTION_SYSTEMS[number];
export type HumanActionSeverity = typeof HUMAN_ACTION_SEVERITIES[number];
export type HumanActionStatus = typeof HUMAN_ACTION_STATUSES[number];

export const SEVERITY_RANK: Record<HumanActionSeverity, number> = {
  info: 1,
  warning: 2,
  critical: 3,
};

export const VERIFICATION_KEYS = [
  "apple_health_freshness",
  "browser_cdp_health",
  "openclaw_gateway_health",
] as const;

export type HumanActionVerificationKey = typeof VERIFICATION_KEYS[number];

function isOneOf<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

export function normalizeHumanActionCategory(value: unknown): HumanActionCategory {
  if (isOneOf(value, HUMAN_ACTION_CATEGORIES)) return value;
  throw new Error(`invalid human action category: ${String(value)}`);
}

export function normalizeHumanActionSystem(value: unknown): HumanActionSystem {
  if (isOneOf(value, HUMAN_ACTION_SYSTEMS)) return value;
  throw new Error(`invalid human action system: ${String(value)}`);
}

export function normalizeHumanActionSeverity(value: unknown): HumanActionSeverity {
  if (isOneOf(value, HUMAN_ACTION_SEVERITIES)) return value;
  throw new Error(`invalid human action severity: ${String(value)}`);
}

export function normalizeHumanActionStatus(value: unknown): HumanActionStatus {
  if (isOneOf(value, HUMAN_ACTION_STATUSES)) return value;
  throw new Error(`invalid human action status: ${String(value)}`);
}

export function normalizeVerificationKey(value: unknown): HumanActionVerificationKey | null {
  if (value === undefined || value === null || value === "") return null;
  if (isOneOf(value, VERIFICATION_KEYS)) return value;
  throw new Error(`invalid human action verification key: ${String(value)}`);
}

export function defaultRequiredAction(system: HumanActionSystem): string {
  if (system === "apple_health") return "Refresh or repair the Apple Health export so latest.json has valid freshness metadata.";
  if (system === "browser_session") return "Open the configured browser profile and renew the login/session manually.";
  if (system === "google_oauth") return "Complete Google OAuth re-consent on the Mac mini, then rerun the affected check.";
  if (system === "openai_auth") return "Re-authenticate OpenAI/Codex locally, then rerun the critical cron auth guard.";
  if (system === "schwab") return "Complete the Schwab portal/OAuth action locally, then rerun provider health.";
  return "Complete the required local operator action, then rerun verification.";
}

export function defaultVerificationKey(system: HumanActionSystem): HumanActionVerificationKey | null {
  if (system === "apple_health") return "apple_health_freshness";
  if (system === "browser_session") return "browser_cdp_health";
  return null;
}
