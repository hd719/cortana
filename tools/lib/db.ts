import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "child_process";
import os from "os";
import fs from "fs";

const PG_BIN_DIR = "/opt/homebrew/opt/postgresql@17/bin";

function hasDatabaseUrl(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.DATABASE_URL && String(env.DATABASE_URL).trim().length > 0);
}

function buildDatabaseUrlFromEnv(env: NodeJS.ProcessEnv): string | null {
  const host = env.PGHOST || env.POSTGRES_HOST || "127.0.0.1";
  const port = env.PGPORT || env.POSTGRES_PORT || "5432";
  const db = env.CORTANA_DB || env.POSTGRES_DB || "cortana";
  const user = env.PGUSER || env.POSTGRES_USER || os.userInfo().username || "postgres";
  const password = env.PGPASSWORD || env.POSTGRES_PASSWORD || "";

  if (!host || !port || !db || !user) return null;
  const auth = password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}` : encodeURIComponent(user);
  return `postgresql://${auth}@${host}:${port}/${db}`;
}

function resolveDbEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = withPostgresPath(baseEnv);
  if (!hasDatabaseUrl(env)) {
    const derived = buildDatabaseUrlFromEnv(env);
    if (derived) env.DATABASE_URL = derived;
  }
  return env;
}

// Backward-compat export: some callers/tests import `prisma` from this module.
// We do not depend on Prisma runtime here; DB operations use psql.
export const prisma = {};

function run(sql: string): string {
  const result = runPsql(sql);
  if (result.status !== 0) {
    const msg = result.stderr || `psql exited with status ${result.status}`;
    throw new Error(`Database query failed: ${msg}`);
  }
  return String(result.stdout ?? "").trimEnd();
}

export function query(sql: string): string {
  return run(sql);
}

export function queryJson<T = any>(sql: string): T[] {
  const raw = run(sql).trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as T[];
    return [parsed as T];
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Database JSON parse failed: ${msg}`);
  }
}

export function execute(sql: string): void {
  void run(sql);
}

export function withPostgresPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clone: NodeJS.ProcessEnv = { ...env };
  const pathParts = String(clone.PATH || "").split(":").filter(Boolean);
  if (!pathParts.includes(PG_BIN_DIR)) pathParts.unshift(PG_BIN_DIR);
  clone.PATH = pathParts.join(":");
  return clone;
}

type RunPsqlOptions = {
  db?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  stdio?:
    | "inherit"
    | "pipe"
    | "ignore"
    | ["ignore" | "pipe" | "inherit", "ignore" | "pipe" | "inherit", "ignore" | "pipe" | "inherit"];
};

function resolvePsqlBin(env: NodeJS.ProcessEnv): string {
  const explicit = env.PSQL_BIN;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const preferred = `${PG_BIN_DIR}/psql`;
  if (fs.existsSync(preferred)) return preferred;
  return "psql";
}

export function runPsql(sql: string, options: RunPsqlOptions = {}) {
  const env = resolveDbEnv(options.env ?? process.env);
  const db = options.db ?? env.CORTANA_DB ?? "cortana";
  const args = options.args ?? ["-q", "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A"];
  const psqlBin = resolvePsqlBin(env);

  const spawnOpts: SpawnSyncOptionsWithStringEncoding = {
    encoding: "utf8",
    env,
    stdio: options.stdio ?? "pipe",
  };

  return spawnSync(psqlBin, [db, ...args, "-c", sql], spawnOpts);
}

// Default export for CJS/ESM interop compatibility
export default { prisma, query, queryJson, execute, withPostgresPath, runPsql };
