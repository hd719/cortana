#!/usr/bin/env npx tsx
import { execFileSync } from "child_process";
import os from "os";
import db from "../lib/db.js";
const { runPsql, withPostgresPath } = db;

const DB = process.env.CORTANA_DB ?? "cortana";
const TONAL_ENDPOINT = process.env.TONAL_ENDPOINT ?? "http://localhost:3033/tonal/health";
const TONAL_FALLBACK_ENDPOINT =
  process.env.TONAL_FALLBACK_ENDPOINT ?? "http://localhost:3033/tonal/health";
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? "3");
const CONNECT_TIMEOUT_SECONDS = Number(process.env.CONNECT_TIMEOUT_SECONDS ?? "3");
const READ_TIMEOUT_SECONDS = Number(process.env.READ_TIMEOUT_SECONDS ?? "8");
const RETRY_SLEEP_SECONDS = Number(process.env.RETRY_SLEEP_SECONDS ?? "2");
const CHECKPOINT_SECONDS = Number(process.env.CHECKPOINT_SECONDS ?? "300");

const ASSIGNEE =
  process.env.OPENCLAW_ASSIGNEE ??
  `${process.env.ASSIGNED_TO ?? process.env.USER ?? "unknown"}@${os.hostname().split(".")[0] || "host"}`;
const RUN_ID = `tonal-health-check-${Math.floor(Date.now() / 1000)}-${process.pid}`;
const START_TS = new Date().toISOString();

const startMs = Date.now();

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function emit(level: string, message: string): void {
  const now = new Date().toISOString();
  console.log(`[${now}] [${RUN_ID}] [${ASSIGNEE}] [${level}] ${message}`);
}

function logEvent(sev: string, msg: string, meta = "{}"): void {
  const escMsg = sqlEscape(msg);
  const escMeta = sqlEscape(meta);
  const res = runPsql(
    `INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('tonal_health_check', 'tonal-health-check', '${sev}', '${escMsg}', '${escMeta}');`,
    {
      db: DB,
      env: withPostgresPath(process.env),
      stdio: ["ignore", "ignore", "ignore"],
    }
  );
  void res;
}

function sleepSeconds(seconds: number): void {
  execFileSync("/bin/sleep", [String(seconds)], { stdio: "ignore" });
}

function checkOnce(endpoint: string): string {
  return execFileSync(
    "curl",
    [
      "-sS",
      "--fail",
      "--connect-timeout",
      String(CONNECT_TIMEOUT_SECONDS),
      "--max-time",
      String(READ_TIMEOUT_SECONDS),
      endpoint,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
}

const checkpoint = setInterval(() => {
  const elapsed = Math.floor((Date.now() - startMs) / 1000);
  emit("checkpoint", `still running; assignee=${ASSIGNEE}; elapsed=${elapsed}s`);
  logEvent(
    "info",
    "Tonal health check progress checkpoint",
    JSON.stringify({ run_id: RUN_ID, assignee: ASSIGNEE, elapsed_seconds: elapsed })
  );
}, CHECKPOINT_SECONDS * 1000);

emit(
  "start",
  `run started; assignee=${ASSIGNEE}; endpoint=${TONAL_ENDPOINT}; max_attempts=${MAX_ATTEMPTS}`
);
logEvent(
  "info",
  "Tonal health check started",
  JSON.stringify({
    run_id: RUN_ID,
    assignee: ASSIGNEE,
    endpoint: TONAL_ENDPOINT,
    max_attempts: MAX_ATTEMPTS,
    start: START_TS,
  })
);

let attempt = 1;
let lastError = "";

try {
  while (attempt <= MAX_ATTEMPTS) {
    emit("progress", `attempt ${attempt}/${MAX_ATTEMPTS} against primary endpoint`);
    try {
      const response = checkOnce(TONAL_ENDPOINT);
      emit("ok", "primary endpoint healthy");
      logEvent(
        "info",
        "Tonal health check succeeded",
        JSON.stringify({ run_id: RUN_ID, assignee: ASSIGNEE, attempt, endpoint: TONAL_ENDPOINT })
      );
      process.stdout.write(response);
      process.exit(0);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      emit("warn", `primary endpoint failed (attempt ${attempt}): ${lastError}`);
    }

    emit("progress", `attempt ${attempt}/${MAX_ATTEMPTS} against fallback endpoint`);
    try {
      const response = checkOnce(TONAL_FALLBACK_ENDPOINT);
      emit("ok", "fallback endpoint healthy");
      logEvent(
        "warning",
        "Tonal health check succeeded via fallback",
        JSON.stringify({
          run_id: RUN_ID,
          assignee: ASSIGNEE,
          attempt,
          endpoint: TONAL_FALLBACK_ENDPOINT,
        })
      );
      process.stdout.write(response);
      process.exit(0);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      emit("warn", `fallback endpoint failed (attempt ${attempt}): ${lastError}`);
    }

    if (attempt < MAX_ATTEMPTS) {
      sleepSeconds(RETRY_SLEEP_SECONDS);
    }
    attempt += 1;
  }

  emit("error", `all attempts failed; assignee=${ASSIGNEE}; last_error=${lastError}`);
  logEvent(
    "error",
    "Tonal health check failed",
    JSON.stringify({
      run_id: RUN_ID,
      assignee: ASSIGNEE,
      endpoint: TONAL_ENDPOINT,
      fallback_endpoint: TONAL_FALLBACK_ENDPOINT,
      max_attempts: MAX_ATTEMPTS,
      last_error: lastError,
    })
  );
  process.exit(1);
} finally {
  clearInterval(checkpoint);
}
