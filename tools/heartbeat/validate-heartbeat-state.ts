#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { withPostgresPath } from "../lib/db.js";
import { writeJsonFileAtomic } from "../lib/json-file.js";
import { PSQL_BIN } from "../lib/paths.js";

type LastCheck = { lastChecked: number };
type State = {
  version: number;
  lastChecks: Record<string, LastCheck>;
  lastRemediationAt: number;
  subagentWatchdog: {
    lastRun: number;
    lastLogged: Record<string, number>;
  };
  lastSnapshotAt?: number;
};

const stateFile = process.env.HEARTBEAT_STATE_FILE || path.join(os.homedir(), "clawd/memory/heartbeat-state.json");
const dbName = process.env.DB_NAME || "cortana";
const snapshotIntervalSec = Number(process.env.SNAPSHOT_INTERVAL_SEC || "21600");
const maxStaleMs = 48 * 60 * 60 * 1000;
const nowMs = Date.now();
const version = 2;
const requiredChecks = [
  "email",
  "calendar",
  "watchlist",
  "tasks",
  "portfolio",
  "marketIntel",
  "techNews",
  "weather",
  "fitness",
  "apiBudget",
  "mission",
  "cronDelivery",
];

function parseTs(value: unknown, allowZero = false): number {
  if (value === null || value === undefined) throw new Error("timestamp missing");
  if (typeof value === "boolean") throw new Error("invalid bool timestamp");

  if (typeof value === "number") {
    const n0 = Math.trunc(value);
    if (n0 === 0 && allowZero) return 0;
    let n = n0;
    if (n < 1_000_000_000_000) {
      if (n < 1_000_000_000) throw new Error("numeric timestamp too small");
      n *= 1000;
    }
    return n;
  }

  if (typeof value === "string") {
    const s = value.trim();
    if (!s) throw new Error("empty timestamp string");
    if (/^\d+$/.test(s)) return parseTs(Number(s), allowZero);

    const parsed = Date.parse(s.replace(/Z$/, "+00:00"));
    if (Number.isNaN(parsed)) throw new Error("invalid iso timestamp");
    return parsed;
  }

  throw new Error(`unsupported timestamp type: ${typeof value}`);
}

function validateAndNormalize(raw: unknown): State {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("state root must be object");
  }

  const root = raw as Record<string, unknown>;
  const lastChecksRaw = root.lastChecks;
  if (!lastChecksRaw || typeof lastChecksRaw !== "object" || Array.isArray(lastChecksRaw)) {
    throw new Error("lastChecks must be object");
  }

  const normalizedChecks: Record<string, LastCheck> = {};
  for (const key of requiredChecks) {
    if (!(key in (lastChecksRaw as Record<string, unknown>))) {
      throw new Error(`missing required check: ${key}`);
    }
    const val = (lastChecksRaw as Record<string, unknown>)[key];
    const tsSrc = val && typeof val === "object" && !Array.isArray(val)
      ? (val as Record<string, unknown>).lastChecked
      : val;
    const ts = parseTs(tsSrc);
    const age = nowMs - ts;
    if (ts > nowMs + 5 * 60 * 1000) throw new Error(`${key} timestamp in future`);
    if (age > maxStaleMs) throw new Error(`${key} timestamp stale`);
    normalizedChecks[key] = { lastChecked: ts };
  }

  const subRaw = (root.subagentWatchdog as Record<string, unknown> | null) || {
    lastRun: nowMs,
    lastLogged: {},
  };

  if (!subRaw || typeof subRaw !== "object" || Array.isArray(subRaw)) {
    throw new Error("subagentWatchdog must be object");
  }

  const lastLoggedRaw = subRaw.lastLogged ?? {};
  if (!lastLoggedRaw || typeof lastLoggedRaw !== "object" || Array.isArray(lastLoggedRaw)) {
    throw new Error("subagentWatchdog.lastLogged must be object");
  }

  const normalized: State = {
    version,
    lastChecks: normalizedChecks,
    lastRemediationAt: parseTs(root.lastRemediationAt ?? nowMs, true),
    subagentWatchdog: {
      lastRun: parseTs(subRaw.lastRun ?? nowMs, true),
      lastLogged: Object.fromEntries(
        Object.entries(lastLoggedRaw as Record<string, unknown>).map(([k, v]) => [String(k), parseTs(v, true)])
      ),
    },
  };

  if ("lastSnapshotAt" in root) {
    try {
      normalized.lastSnapshotAt = parseTs(root.lastSnapshotAt);
    } catch {
      // intentionally ignored
    }
  }

  return normalized;
}

function defaultState(): State {
  return {
    version,
    lastChecks: Object.fromEntries(requiredChecks.map((k) => [k, { lastChecked: nowMs }])),
    lastRemediationAt: nowMs,
    subagentWatchdog: { lastRun: nowMs, lastLogged: {} },
  };
}

function backupPath(n: 1 | 2 | 3): string {
  return `${stateFile}.bak.${n}`;
}

function rotateBackups(): void {
  const b1 = backupPath(1);
  const b2 = backupPath(2);
  const b3 = backupPath(3);

  if (fs.existsSync(b2)) fs.copyFileSync(b2, b3);
  if (fs.existsSync(b1)) fs.copyFileSync(b1, b2);
  fs.copyFileSync(stateFile, b1);
}

const result: Record<string, unknown> = {
  ok: true,
  action: "validated",
  restoredFrom: null,
  usedDefault: false,
};

let normalized: State | null = null;
let invalidReason: string | null = null;

if (fs.existsSync(stateFile)) {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    normalized = validateAndNormalize(raw);
  } catch (error) {
    invalidReason = error instanceof Error ? error.message : String(error);
  }
}

if (!normalized) {
  for (const i of [1, 2, 3] as const) {
    const candidate = backupPath(i);
    if (!fs.existsSync(candidate)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, "utf8"));
      normalized = validateAndNormalize(raw);
      result.action = "restored_from_backup";
      result.restoredFrom = candidate;
      break;
    } catch {
      // keep trying backups
    }
  }
}

if (!normalized) {
  normalized = defaultState();
  result.action = "reinitialized_default";
  result.usedDefault = true;
}

if (invalidReason) result.invalidReason = invalidReason;

writeJsonFileAtomic(stateFile, normalized, 2);
rotateBackups();

const ages = Object.values(normalized.lastChecks)
  .filter((v): v is LastCheck => Boolean(v && typeof v === "object" && typeof v.lastChecked === "number"))
  .map((v) => nowMs - v.lastChecked);

result.summary = {
  version: normalized.version,
  checkCount: Object.keys(normalized.lastChecks).length,
  oldestAgeMs: ages.length > 0 ? Math.max(...ages) : 0,
  newestAgeMs: ages.length > 0 ? Math.min(...ages) : 0,
};
result.statePath = stateFile;

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

if (isExecutable(PSQL_BIN)) {
  const env = withPostgresPath({
    ...process.env,
    PGHOST: process.env.PGHOST || "localhost",
    PGUSER: process.env.PGUSER || process.env.USER,
  });

  let lastAgeSec = "999999999";
  const q = spawnSync(
    PSQL_BIN,
    [
      dbName,
      "-At",
      "-c",
      "SELECT COALESCE(EXTRACT(EPOCH FROM (NOW() - MAX(timestamp))), 999999999)::bigint FROM cortana_events WHERE event_type='heartbeat_state_snapshot';",
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
    }
  );

  if (q.status === 0) {
    const v = (q.stdout || "").trim();
    if (/^\d+$/.test(v)) lastAgeSec = v;
  }

  if (/^\d+$/.test(lastAgeSec) && Number(lastAgeSec) >= snapshotIntervalSec) {
    const metaSql = JSON.stringify(result).replace(/'/g, "''");
    spawnSync(
      PSQL_BIN,
      [
        dbName,
        "-c",
        `INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('heartbeat_state_snapshot','heartbeat-validator','info','Heartbeat state shadow snapshot','${metaSql}'::jsonb);`,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "ignore", "ignore"],
        env,
      }
    );
  }
}

console.log(JSON.stringify(result));
