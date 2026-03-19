import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type NotificationTier = "P0" | "P1" | "P2" | "P3";
export type NotificationSeverity = NotificationTier;
export type DeliveryDecision = "immediate" | "digest" | "silent";
export type ActionNeeded = "now" | "soon" | "summary" | "none";

export type NotificationEnvelope = {
  message: string;
  target: string;
  alertType: string;
  dedupeKey: string;
  severity: NotificationSeverity;
  owner: string;
  system: string;
  actionNeeded: ActionNeeded;
  sourceAgent?: string;
};

type NotificationModeState = {
  mode?: string;
  active?: boolean;
  allowBelow?: NotificationTier;
  summaryWindows?: string[];
  reason?: string;
  updatedAt?: string;
};

const MODE_FILE = path.join(os.homedir(), ".openclaw", "notification-mode.json");
const DIGEST_DIR = path.join(os.homedir(), ".openclaw", "tmp", "notification-digests");
const AGGREGATE_DIR = path.join(os.homedir(), ".openclaw", "tmp", "notification-aggregate");

const TIER_RANK: Record<NotificationTier, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const OPERATIONAL_SYSTEMS = new Set([
  "system",
  "ops",
  "operational",
  "health",
  "monitor",
  "cron",
  "auth",
  "delivery",
  "runtime",
  "repo",
  "session",
  "subagent",
  "gateway",
]);

function ensureParent(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function readModeState(): NotificationModeState {
  try {
    return JSON.parse(fs.readFileSync(MODE_FILE, "utf8")) as NotificationModeState;
  } catch {
    return {};
  }
}

export function normalizeSeverity(raw: string | undefined | null): NotificationSeverity {
  const value = String(raw ?? "P1").trim().toLowerCase();
  if (["p0", "critical", "sev0", "urgent_critical"].includes(value)) return "P0";
  if (["p1", "high", "immediate", "alert", "urgent"].includes(value)) return "P1";
  if (["p2", "medium", "digest", "batched", "summary"].includes(value)) return "P2";
  if (["p3", "low", "silent", "none", "no-action"].includes(value)) return "P3";
  return "P1";
}

export function normalizeActionNeeded(raw: string | undefined | null, severity: NotificationSeverity): ActionNeeded {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "now") return "now";
  if (value === "soon") return "soon";
  if (["summary", "digest", "later"].includes(value)) return "summary";
  if (["none", "silent", "no", "false"].includes(value)) return "none";
  if (severity === "P0" || severity === "P1") return "now";
  if (severity === "P2") return "summary";
  return "none";
}

export function normalizeSystem(raw: string | undefined | null, alertType = "notice"): string {
  const value = String(raw ?? "").trim();
  if (value) return value;
  return alertType.replace(/[_-]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

export function routeOwner(owner: string | undefined | null, system: string): string {
  const normalized = system.trim().toLowerCase();
  if (OPERATIONAL_SYSTEMS.has(normalized)) return "monitor";
  return String(owner ?? "monitor").trim() || "monitor";
}

export function deliveryDecisionFor(severity: NotificationSeverity, now = new Date()): DeliveryDecision {
  if (severity === "P3") return "silent";

  const mode = readModeState();
  const active = mode.active === true || String(mode.mode ?? "").toLowerCase() === "quiet";
  const allowBelow = normalizeSeverity(mode.allowBelow ?? "P1");

  if (active && TIER_RANK[severity] > TIER_RANK[allowBelow]) {
    return severity === "P2" ? "digest" : "silent";
  }

  if (severity === "P2") return "digest";
  return "immediate";
}

export function isFocusModeActive(now = new Date()): boolean {
  return deliveryDecisionFor("P2", now) !== "immediate";
}

export function digestFileFor(now = new Date()): string {
  fs.mkdirSync(DIGEST_DIR, { recursive: true });
  return path.join(DIGEST_DIR, `${now.toISOString().slice(0, 10)}.jsonl`);
}

function aggregateFileFor(dedupeKey: string): string {
  fs.mkdirSync(AGGREGATE_DIR, { recursive: true });
  const safe = crypto.createHash("sha1").update(dedupeKey || "no-key", "utf8").digest("hex");
  return path.join(AGGREGATE_DIR, `${safe}.json`);
}

export function appendDigestEntry(entry: NotificationEnvelope, now = new Date()): string {
  const file = digestFileFor(now);
  fs.appendFileSync(file, `${JSON.stringify({ ...entry, queuedAt: now.toISOString() })}\n`, "utf8");
  return file;
}

export function recordAggregate(envelope: NotificationEnvelope, windowSeconds = 6 * 3600): { combined: boolean; hits: number; file: string } {
  const file = aggregateFileFor(envelope.dedupeKey || envelope.alertType || envelope.system);
  const now = Date.now();
  let state: {
    firstSeenAt?: string;
    lastSeenAt?: string;
    hits?: number;
    severity?: NotificationSeverity;
    owner?: string;
    system?: string;
    actionNeeded?: ActionNeeded;
    messages?: string[];
    sources?: string[];
  } = {};

  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    state = {};
  }

  const lastSeen = state.lastSeenAt ? Date.parse(state.lastSeenAt) : 0;
  if (!lastSeen || now - lastSeen > windowSeconds * 1000) {
    state = {};
  }

  const messages = Array.isArray(state.messages) ? state.messages : [];
  const sources = Array.isArray(state.sources) ? state.sources : [];
  const uniqueMessages = Array.from(new Set([...messages, envelope.message])).slice(-5);
  const uniqueSources = Array.from(new Set([...sources, envelope.owner, envelope.sourceAgent].filter(Boolean) as string[])).slice(-8);
  const hits = Number(state.hits ?? 0) + 1;

  const nextState = {
    firstSeenAt: state.firstSeenAt ?? new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    hits,
    severity: envelope.severity,
    owner: envelope.owner,
    system: envelope.system,
    actionNeeded: envelope.actionNeeded,
    messages: uniqueMessages,
    sources: uniqueSources,
  };

  ensureParent(file);
  fs.writeFileSync(file, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  return { combined: hits > 1, hits, file };
}

export function formatUserLabel(envelope: NotificationEnvelope): string {
  const urgency = envelope.severity === "P0" ? "CRITICAL" : envelope.severity === "P1" ? "High" : envelope.severity === "P2" ? "Digest" : "Silent";
  const action = envelope.actionNeeded === "now" ? "Action now" : envelope.actionNeeded === "soon" ? "Action soon" : envelope.actionNeeded === "summary" ? "Summary only" : "No action needed";
  return `${envelope.system} | ${envelope.severity} ${urgency} | ${action}`;
}

export function formatUserMessage(envelope: NotificationEnvelope, aggregate?: { hits: number; combined: boolean }): string {
  const header = formatUserLabel(envelope);
  const hasRelatedDetectionsLine = /(?:^|\n)(?:🔎\s*)?Related detections:\s*\d+/i.test(envelope.message);
  const suffix = aggregate && aggregate.hits > 1 && !hasRelatedDetectionsLine ? `\n\nRelated detections: ${aggregate.hits}` : "";
  return `${header}\n${envelope.message}${suffix}`;
}

export function setNotificationMode(mode: "normal" | "quiet", reason = "", allowBelow: NotificationTier = "P1"): string {
  const payload: NotificationModeState = {
    mode,
    active: mode === "quiet",
    allowBelow,
    reason,
    updatedAt: new Date().toISOString(),
  };
  ensureParent(MODE_FILE);
  fs.writeFileSync(MODE_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return MODE_FILE;
}

export function getNotificationMode(): NotificationModeState {
  return readModeState();
}
