import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

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

  while (Atomics.load(ia, 0) === 0) {
    Atomics.wait(ia, 0, 0, 100);
  }

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
    const rows = waitFor(prisma.$queryRawUnsafe(sql));
    return formatPsqlLike(rows);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[db] SQL execution failed: ${msg}`);
    console.error(`[db] SQL: ${sql}`);
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
    console.error(`[db] Failed to parse JSON response: ${msg}`);
    throw new Error(`Database JSON parse failed: ${msg}`);
  }
}

export function execute(sql: string): void {
  try {
    void waitFor(prisma.$executeRawUnsafe(sql));
  } catch {
    void run(sql);
  }
}

export function withPostgresPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env;
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

export function runPsql(sql: string, _options: RunPsqlOptions = {}) {
  try {
    const stdout = run(sql);
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const stderr = error instanceof Error ? error.message : String(error);
    return { status: 1, stdout: "", stderr };
  }
}
