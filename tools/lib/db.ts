import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "child_process";
import os from "os";
import fs from "fs";
import { PrismaClient } from "@prisma/client";

const PG_BIN_DIR = "/opt/homebrew/opt/postgresql@17/bin";

let prismaClient: PrismaClient | null = null;

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

export function getPrismaClient(): PrismaClient {
  if (prismaClient) return prismaClient;
  const env = resolveDbEnv(process.env);
  if (!hasDatabaseUrl(env)) {
    throw new Error("DATABASE_URL is not set and could not be derived from PG* env vars");
  }
  prismaClient = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  return prismaClient;
}

// Backward-compat: many scripts/tests import `prisma` directly and expect an
// actual PrismaClient instance.
export const prisma: PrismaClient = getPrismaClient();

function waitFor<T>(promise: Promise<T>): T {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  let result: T | undefined;
  let error: unknown;

  promise
    .then((value) => {
      result = value;
      Atomics.store(ia, 0, 1);
      Atomics.notify(ia, 0);
    })
    .catch((err) => {
      error = err;
      Atomics.store(ia, 0, 1);
      Atomics.notify(ia, 0);
    });

  while (Atomics.load(ia, 0) === 0) Atomics.wait(ia, 0, 0, 100);

  if (error) throw error;
  return result as T;
}

function formatPsqlLike(rows: unknown): string {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  return rows
    .map((row) => {
      if (row == null) return "";
      if (typeof row !== "object") return String(row);
      const values = Object.values(row as Record<string, unknown>);
      return values.map((v) => (v == null ? "" : String(v))).join("|");
    })
    .join("\n");
}

function run(sql: string): string {
  try {
    const rows = waitFor(getPrismaClient().$queryRawUnsafe(sql));
    return formatPsqlLike(rows);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Database query failed: ${msg}`);
  }
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
  try {
    void waitFor(getPrismaClient().$executeRawUnsafe(sql));
  } catch {
    void run(sql);
  }
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
