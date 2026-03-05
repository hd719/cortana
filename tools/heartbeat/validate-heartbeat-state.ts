#!/usr/bin/env npx tsx

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { rotateBackupRing, withFileLock, writeJsonFileAtomic } from "../lib/json-file.js";
import {
  defaultHeartbeatState,
  hashHeartbeatState,
  HEARTBEAT_MAX_AGE_MS,
  touchHeartbeat,
  validateHeartbeatState,
} from "../lib/heartbeat-schema.js";
import db from "../lib/db.js";
const { withPostgresPath } = db;
import { PSQL_BIN } from "../lib/paths.js";

function logWriteTelemetry(source: string, dbName: string, oldHash: string | null, newHash: string): void {
  try {
    fs.accessSync(PSQL_BIN, fs.constants.X_OK);
    const env = withPostgresPath({ ...process.env, PGHOST: process.env.PGHOST || "localhost", PGUSER: process.env.PGUSER || process.env.USER });
    const metadata = JSON.stringify({ old_hash: oldHash, new_hash: newHash }).replace(/'/g, "''");
    const sql =
      "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES (" +
      "'heartbeat_state_write', '" +
      source.replace(/'/g, "''") +
      "', 'info', 'Heartbeat state updated', '" +
      metadata +
      "'::jsonb);";
    spawnSync(PSQL_BIN, [dbName, "-c", sql], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
      env,
    });
  } catch {
    // telemetry must not break writers
  }
}

async function main(): Promise<void> {
  const stateFile = process.env.HEARTBEAT_STATE_FILE || path.join(os.homedir(), ".openclaw", "memory", "heartbeat-state.json");
  const dbName = process.env.DB_NAME || "cortana";
  const snapshotIntervalSec = Number(process.env.SNAPSHOT_INTERVAL_SEC || "21600");
  const nowMs = Date.now();

  const result: Record<string, unknown> = { ok: true, action: "validated", restoredFrom: null, usedDefault: false };

  let normalized = defaultHeartbeatState(nowMs);
  let invalidReason: string | null = null;

  try {
    withFileLock(stateFile, 5000, () => {
    const oldRaw = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : null;
    let oldHash: string | null = null;
    if (oldRaw) {
      try {
        oldHash = hashHeartbeatState(JSON.parse(oldRaw));
      } catch {
        oldHash = hashHeartbeatState(oldRaw);
      }
    }

    if (oldRaw) {
      try {
        normalized = validateHeartbeatState(JSON.parse(oldRaw), nowMs, HEARTBEAT_MAX_AGE_MS);
      } catch (e) {
        invalidReason = e instanceof Error ? e.message : String(e);
      }
    }

    if (invalidReason) {
      for (const i of [1, 2, 3] as const) {
        const candidate = `${stateFile}.bak.${i}`;
        if (!fs.existsSync(candidate)) continue;
        try {
          normalized = validateHeartbeatState(JSON.parse(fs.readFileSync(candidate, "utf8")), nowMs, HEARTBEAT_MAX_AGE_MS);
          result.action = "restored_from_backup";
          result.restoredFrom = candidate;
          invalidReason = null;
          break;
        } catch {
          // try next backup
        }
      }
    }

    if (invalidReason) {
      normalized = defaultHeartbeatState(nowMs);
      result.action = "reinitialized_default";
      result.usedDefault = true;
      result.invalidReason = invalidReason;
    }

    touchHeartbeat(normalized, nowMs);

    // backup prior state BEFORE writing replacement
    rotateBackupRing(stateFile, 3);
    writeJsonFileAtomic(stateFile, normalized, 2);

    const newHash = hashHeartbeatState(normalized);
    logWriteTelemetry("heartbeat-validator", dbName, oldHash, newHash);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[heartbeat-validator] lock/write failed: ${msg}`);
    process.exit(1);
  }

  const ages = Object.values(normalized.lastChecks).map((v) => nowMs - v.lastChecked);
  result.summary = {
    version: normalized.version,
    checkCount: Object.keys(normalized.lastChecks).length,
    oldestAgeMs: ages.length ? Math.max(...ages) : 0,
    newestAgeMs: ages.length ? Math.min(...ages) : 0,
  };
  result.statePath = stateFile;

  try {
    fs.accessSync(PSQL_BIN, fs.constants.X_OK);
    const env = withPostgresPath({ ...process.env, PGHOST: process.env.PGHOST || "localhost", PGUSER: process.env.PGUSER || process.env.USER });
    const lastAge = spawnSync(PSQL_BIN, [dbName, "-At", "-c", "SELECT COALESCE(EXTRACT(EPOCH FROM (NOW() - MAX(timestamp))), 999999999)::bigint FROM cortana_events WHERE event_type='heartbeat_state_snapshot';"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
    });
    const lastAgeSec = (lastAge.stdout || "999999999").trim();
    if (/^\d+$/.test(lastAgeSec) && Number(lastAgeSec) >= snapshotIntervalSec) {
      const metaSql = JSON.stringify(result).replace(/'/g, "''");
      spawnSync(PSQL_BIN, [dbName, "-c", `INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('heartbeat_state_snapshot','heartbeat-validator','info','Heartbeat state shadow snapshot','${metaSql}'::jsonb);`], {
        encoding: "utf8",
        stdio: ["ignore", "ignore", "ignore"],
        env,
      });
    }
  } catch {}

  console.log(JSON.stringify(result));
}

main();
