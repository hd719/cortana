#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { runPsql, withPostgresPath } from "../lib/db.js";
import { repoRoot, resolveHomePath } from "../lib/paths.js";

const env = {
  ...withPostgresPath(process.env),
  PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${withPostgresPath(process.env).PATH ?? ""}`,
};

const DB = process.env.CORTANA_DB ?? "cortana";
const args = process.argv.slice(2);
const CRON_NAME = args[0] ?? "";
const REQUIRED = args.slice(1);

if (!CRON_NAME) {
  console.log(`usage: ${process.argv[1]} <cron_name> [required_check ...]`);
  process.exit(2);
}

const QDIR = resolveHomePath(".openclaw/cron/quarantine");
const RUN_DIR = resolveHomePath(".openclaw/cron/runs");
fs.mkdirSync(QDIR, { recursive: true });
const QFILE = path.join(QDIR, `${CRON_NAME}.quarantined`);

function shell(command: string, argv: string[]) {
  return spawnSync(command, argv, { encoding: "utf8", env });
}

function sqlEscape(v: string) {
  return v.replace(/'/g, "''");
}

function logEvent(sev: string, msg: string, meta: Record<string, unknown> = {}) {
  runPsql(
    `INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('cron_preflight', '${sqlEscape(
      CRON_NAME
    )}', '${sqlEscape(sev)}', '${sqlEscape(msg)}', '${sqlEscape(JSON.stringify(meta))}');`,
    { db: DB, env, stdio: "ignore" }
  );
}

function quarantine(reason: string): never {
  fs.writeFileSync(QFILE, `${new Date().toISOString()} ${reason}\n`, "utf8");
  logEvent("warning", `Cron quarantined: ${reason}`, { cron: CRON_NAME, reason });
  console.log(`preflight failed: ${reason}`);
  process.exit(1);
}

function runArtifactRotation() {
  const rotator = path.join(repoRoot(), "tools/cron/rotate-cron-artifacts.sh");
  try {
    fs.accessSync(rotator, fs.constants.X_OK);
    const r = shell(rotator, []);
    if (r.status !== 0) {
      logEvent("warning", "Cron artifact rotation failed", { cron: CRON_NAME, script: rotator });
    }
  } catch {
    logEvent("warning", "Cron artifact rotator missing or not executable", { cron: CRON_NAME, script: rotator });
  }
}

function runMetaMonitor() {
  const monitorScript = path.join(repoRoot(), "tools/monitoring/meta-monitor.sh");
  try {
    fs.accessSync(monitorScript, fs.constants.X_OK);
    const r = shell(monitorScript, []);
    if (r.status !== 0) {
      logEvent("warning", "Meta-monitor run failed during preflight hygiene", { cron: CRON_NAME, script: monitorScript });
    }
  } catch {
    logEvent("warning", "Meta-monitor missing or not executable", { cron: CRON_NAME, script: monitorScript });
  }
}

function warnOversizedArtifacts() {
  if (!fs.existsSync(RUN_DIR) || !fs.statSync(RUN_DIR).isDirectory()) return;

  let warned = false;
  for (const name of fs.readdirSync(RUN_DIR)) {
    if (!name.endsWith(".jsonl")) continue;
    const f = path.join(RUN_DIR, name);
    let sz = 0;
    try {
      sz = fs.statSync(f).size;
    } catch {
      sz = 0;
    }

    if (sz > 1048576) {
      warned = true;
      logEvent("warning", "Cron run artifact exceeds 1MB", {
        cron: CRON_NAME,
        file: f,
        bytes: sz,
        threshold: 1048576,
      });
    }
  }

  if (warned) console.log("warning: oversized cron artifacts detected (>1MB)");
}

function checkPg(): boolean {
  return runPsql("SELECT 1;", { db: DB, env, stdio: "ignore" }).status === 0;
}

function checkGog(): boolean {
  return shell("gog", ["--account", "hameldesai3@gmail.com", "auth", "list", "--no-input"]).status === 0;
}

function checkGogOauth(): boolean {
  const script = path.join(repoRoot(), "tools/gog/oauth-refresh.ts");
  return shell("npx", ["tsx", script]).status === 0;
}

function checkFitness(): boolean {
  return shell("curl", ["-sSf", "--max-time", "8", "http://localhost:3033/health"]).status === 0;
}

function checkGateway(): boolean {
  return shell("openclaw", ["gateway", "status"]).status === 0;
}

function runCheck(chk: string): boolean {
  if (chk === "pg") return checkPg();
  if (chk === "gog") return checkGog();
  if (chk === "gog_oauth") return checkGogOauth();
  if (chk === "fitness") return checkFitness();
  if (chk === "gateway") return checkGateway();
  quarantine(`unknown preflight check '${chk}'`);
}

runArtifactRotation();
runMetaMonitor();
warnOversizedArtifacts();

if (fs.existsSync(QFILE)) {
  let allOk = true;
  for (const c of REQUIRED) {
    if (!runCheck(c)) {
      allOk = false;
      break;
    }
  }

  if (allOk) {
    fs.rmSync(QFILE, { force: true });
    logEvent("info", "Cron quarantine released after successful preflight", { cron: CRON_NAME });
  } else {
    console.log(`cron still quarantined: ${CRON_NAME}`);
    process.exit(1);
  }
}

for (const c of REQUIRED) {
  if (!runCheck(c)) quarantine(`required check failed: ${c}`);
}

logEvent("info", "Preflight passed", { cron: CRON_NAME, checks: REQUIRED });
console.log(`preflight ok: ${CRON_NAME}`);
