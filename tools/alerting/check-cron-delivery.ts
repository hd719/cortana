#!/usr/bin/env npx tsx

import fs from "fs";
import { spawnSync } from "child_process";
import { readJsonFile } from "../lib/json-file.js";
import { resolveHomePath, PSQL_BIN } from "../lib/paths.js";
import { withPostgresPath } from "../lib/db.js";

const coerceBool = (value: unknown): unknown => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["false", "0", "no", "n"].includes(v)) return false;
    if (["true", "1", "yes", "y"].includes(v)) return true;
  }
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

async function main(): Promise<number> {
  const jobsFile = resolveHomePath(".openclaw", "cron", "jobs.json");
  const maxAgeMs = 60 * 60 * 1000;

  const data = readJsonFile<Record<string, unknown>>(jobsFile);
  const jobs = data && Array.isArray(data.jobs) ? data.jobs : [];

  const nowMs = Date.now();
  const failures: Array<{ name: string; runTime: string }> = [];

  for (const job of jobs) {
    if (!isRecord(job)) continue;
    if (!job.enabled) continue;

    const delivery = isRecord(job.delivery) ? job.delivery : null;
    const mode = delivery ? delivery.mode : null;
    if (mode === "none") continue;

    const state = isRecord(job.state) ? job.state : {};
    if (state.lastStatus !== "ok") continue;

    const lastDelivered = coerceBool(state.lastDelivered);
    const lastDeliveryStatus = state.lastDeliveryStatus;

    if (!((lastDelivered === false) || (lastDeliveryStatus !== "delivered"))) {
      continue;
    }

    const lastRunRaw = state.lastRunAtMs;
    let lastRunMs: number | null = null;

    if (typeof lastRunRaw === "number" && Number.isFinite(lastRunRaw)) {
      lastRunMs = Math.trunc(lastRunRaw);
    } else if (typeof lastRunRaw === "string") {
      const trimmed = lastRunRaw.trim();
      if (/^[+-]?\d+$/.test(trimmed)) {
        lastRunMs = Number.parseInt(trimmed, 10);
      }
    }

    if (lastRunMs === null) continue;

    const ageMs = nowMs - lastRunMs;
    if (ageMs < 0 || ageMs > maxAgeMs) continue;

    const name = (job.name as string) || "unknown";
    const iso = new Date(lastRunMs).toISOString().replace(/\.\d{3}Z$/, "Z");
    failures.push({ name, runTime: iso });
  }

  if (failures.length === 0) {
    return 0;
  }

  const escapeSql = (value: string) => value.replace(/'/g, "''");

  let sql = "";
  for (const failure of failures) {
    const msg = `Cron delivery failure: ${failure.name} last run ${failure.runTime}`;
    sql += "INSERT INTO cortana_events (event_type, source, severity, message) ";
    sql += `VALUES ('cron_delivery_failure', 'delivery_monitor', 'warning', '${escapeSql(msg)}');`;
  }

  let psqlExecutable = false;
  try {
    fs.accessSync(PSQL_BIN, fs.constants.X_OK);
    psqlExecutable = true;
  } catch {
    psqlExecutable = false;
  }

  if (psqlExecutable && sql) {
    const env = {
      ...withPostgresPath(process.env),
      PGHOST: process.env.PGHOST ?? "localhost",
      PGUSER: process.env.PGUSER ?? process.env.USER ?? "hd",
    };

    spawnSync(PSQL_BIN, ["cortana", "-v", "ON_ERROR_STOP=1", "-c", sql], {
      encoding: "utf8",
      stdio: "ignore",
      env,
    });
  }

  for (const [index, failure] of failures.entries()) {
    console.log(`${failure.name} ${failure.runTime}`);
    if (index >= 2) break;
  }

  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
