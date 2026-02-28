#!/usr/bin/env npx tsx

/** Idempotency guard for sub-agent launches. */

import fs from "fs";
import path from "path";
import { runPsql, withPostgresPath } from "../lib/db.js";
import { resolveRepoPath } from "../lib/paths.js";

const WORKSPACE_ROOT = resolveRepoPath();
const REGISTRY_PATH = path.join(WORKSPACE_ROOT, "tmp", "spawn_guard_registry.json");
const LIFECYCLE_CLI = path.join(WORKSPACE_ROOT, "tools", "covenant", "lifecycle_events.ts");
const DEFAULT_TTL_SECONDS = 3600;

type GuardEntry = {
  key: string;
  normalized_label: string;
  task_id: number | null;
  label: string;
  run_id: string;
  state: string;
  started_at: number;
  updated_at: number;
  ttl_seconds: number;
  metadata: Record<string, any>;
};

function ensureParent(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function normLabel(label: string): string {
  const compact = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return compact || "unnamed";
}

function dedupeKey(label: string, taskId: number | null): string {
  const nl = normLabel(label);
  const tid = taskId != null ? `task:${taskId}` : "task:none";
  return `${tid}|label:${nl}`;
}

function loadRegistry(): Record<string, any> {
  if (!fs.existsSync(REGISTRY_PATH)) return { entries: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { entries: {} };
    if (!raw.entries || typeof raw.entries !== "object") raw.entries = {};
    return raw;
  } catch {
    return { entries: {} };
  }
}

function saveRegistry(registry: Record<string, any>): void {
  ensureParent(REGISTRY_PATH);
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
}

function runPsqlQuery(db: string, sql: string): boolean {
  const result = runPsql(sql, { db, args: ["-X", "-q", "-At"], env: withPostgresPath(process.env) });
  return result.status === 0;
}

function logDecision(event: string, payload: Record<string, any>, db = "cortana"): void {
  const enriched = { ...payload, decision_event: event };

  if (fs.existsSync(LIFECYCLE_CLI)) {
    const sql =
      "SELECT cortana_event_bus_publish(" +
      "'agent_spawn_dedupe', " +
      "'spawn_guard', " +
      `'${JSON.stringify(enriched).replace(/'/g, "''")}'::jsonb, NULL);`;
    if (runPsqlQuery(db, sql)) return;
  }

  const fallbackLog = path.join(WORKSPACE_ROOT, "reports", "spawn_guard.decisions.jsonl");
  ensureParent(fallbackLog);
  fs.appendFileSync(fallbackLog, JSON.stringify({ ts: Math.floor(Date.now() / 1000), ...enriched }) + "\n");
}

function isActive(entry: GuardEntry, now: number): boolean {
  if (entry.state !== "running") return false;
  return now <= entry.updated_at + entry.ttl_seconds;
}

function claim(
  label: string,
  runId: string,
  taskId: number | null,
  ttlSeconds: number,
  metadata: Record<string, any> = {}
): Record<string, any> {
  const key = dedupeKey(label, taskId);
  const now = Math.floor(Date.now() / 1000);
  const normalizedLabel = normLabel(label);

  ensureParent(REGISTRY_PATH);
  const registry = loadRegistry();
  const entries: Record<string, any> = registry.entries ?? {};

  for (const [k, v] of Object.entries(entries)) {
    try {
      const state = v.state;
      const updatedAt = Number(v.updated_at ?? 0);
      const ttl = Number(v.ttl_seconds ?? DEFAULT_TTL_SECONDS);
      if (state !== "running" && now > updatedAt + ttl) {
        delete entries[k];
      } else if (state === "running" && now > updatedAt + ttl) {
        v.state = "expired";
        v.updated_at = now;
      }
    } catch {
      delete entries[k];
    }
  }

  const existing = entries[key];
  if (existing && isActive(existing as GuardEntry, now)) {
    const result = { action: "deduped", reason: "active_run_exists", key, existing };
    logDecision("deduped", result);
    registry.entries = entries;
    saveRegistry(registry);
    return result;
  }

  const entry: GuardEntry = {
    key,
    normalized_label: normalizedLabel,
    task_id: taskId,
    label,
    run_id: runId,
    state: "running",
    started_at: now,
    updated_at: now,
    ttl_seconds: ttlSeconds,
    metadata,
  };
  entries[key] = entry;
  registry.entries = entries;
  saveRegistry(registry);
  const result = { action: "claimed", key, entry };
  logDecision("claimed", result);
  return result;
}

function release(label: string, taskId: number | null, runId: string, finalState = "completed"): Record<string, any> {
  const key = dedupeKey(label, taskId);
  const now = Math.floor(Date.now() / 1000);

  ensureParent(REGISTRY_PATH);
  const registry = loadRegistry();
  const entries: Record<string, any> = registry.entries ?? {};
  const existing = entries[key];
  if (!existing || typeof existing !== "object") {
    return { action: "noop", reason: "missing_key", key };
  }

  if (existing.run_id !== runId) {
    return { action: "noop", reason: "run_id_mismatch", key, existing };
  }

  existing.state = finalState;
  existing.updated_at = now;
  entries[key] = existing;
  registry.entries = entries;
  saveRegistry(registry);
  const result = { action: "released", key, entry: existing };
  logDecision("released", result);
  return result;
}

function demo(): number {
  const taskId = 4242;
  const label = "Huragok migration hygiene";
  const first = claim(label, "run-A", taskId, 120);
  const second = claim(label, "run-B", taskId, 120);
  const released = release(label, taskId, "run-A");
  console.log(JSON.stringify({ first, second, released }, null, 2));
  return second.action === "deduped" ? 0 : 1;
}

function usageError(): never {
  console.error("usage: spawn_guard.py claim|release|demo");
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  if (!cmd) usageError();

  if (cmd === "demo") {
    process.exit(demo());
  }

  if (cmd === "claim") {
    const get = (flag: string): string | undefined => {
      const idx = args.indexOf(flag);
      if (idx >= 0) return args[idx + 1];
      const eq = args.find((a) => a.startsWith(`${flag}=`));
      if (eq) return eq.slice(flag.length + 1);
      return undefined;
    };

    const label = get("--label");
    const runId = get("--run-id");
    if (!label || !runId) usageError();

    const taskId = get("--task-id") ? Number(get("--task-id")) : null;
    const ttl = get("--ttl-seconds") ? Number(get("--ttl-seconds")) : DEFAULT_TTL_SECONDS;

    let metadata: Record<string, any> = {};
    try {
      metadata = JSON.parse(get("--metadata") || "{}");
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        throw new Error("metadata must be object");
      }
    } catch (err) {
      console.error(`invalid metadata json: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }

    const result = claim(label, runId, taskId, ttl, metadata);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.action === "claimed" || result.action === "deduped" ? 0 : 1);
  }

  if (cmd === "release") {
    const get = (flag: string): string | undefined => {
      const idx = args.indexOf(flag);
      if (idx >= 0) return args[idx + 1];
      const eq = args.find((a) => a.startsWith(`${flag}=`));
      if (eq) return eq.slice(flag.length + 1);
      return undefined;
    };

    const label = get("--label");
    const runId = get("--run-id");
    if (!label || !runId) usageError();

    const taskId = get("--task-id") ? Number(get("--task-id")) : null;
    const state = get("--state") || "completed";

    const result = release(label, taskId, runId, state);
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  usageError();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
