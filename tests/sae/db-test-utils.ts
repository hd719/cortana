import { spawnSync } from "node:child_process";
import { describe } from "vitest";
import { POSTGRES_PATH, resolvePsqlBin } from "../../tools/lib/paths";

export const DB_NAME = process.env.DB_NAME || "cortana";
export const PSQL_BIN = resolvePsqlBin();

function withPostgresPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    PATH: `${POSTGRES_PATH}:${env.PATH ?? ""}`,
  };
}

export function psql(sql: string): string {
  const proc = spawnSync(PSQL_BIN, [DB_NAME, "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql], {
    encoding: "utf8",
    env: withPostgresPath(process.env),
  });
  if (proc.error) throw proc.error;
  if ((proc.status ?? 1) !== 0) {
    throw new Error((proc.stderr || proc.stdout || `psql failed: ${PSQL_BIN}`).trim());
  }
  return (proc.stdout || "").trim();
}

export function applySqlFile(filePath: string, label: string): void {
  const proc = spawnSync(PSQL_BIN, [DB_NAME, "-X", "-v", "ON_ERROR_STOP=1", "-f", filePath], {
    encoding: "utf8",
    env: withPostgresPath(process.env),
  });
  if (proc.error) throw proc.error;
  if ((proc.status ?? 1) !== 0) {
    throw new Error((proc.stderr || proc.stdout || `${label} failed: ${PSQL_BIN}`).trim());
  }
}

export function probePostgres(): { ok: true } | { ok: false; reason: string } {
  const proc = spawnSync(PSQL_BIN, [DB_NAME, "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", "SELECT 1;"], {
    encoding: "utf8",
    env: withPostgresPath(process.env),
  });

  if (proc.error) {
    return { ok: false, reason: `${proc.error.message} (${PSQL_BIN})` };
  }
  if ((proc.status ?? 1) !== 0) {
    return { ok: false, reason: (proc.stderr || proc.stdout || `psql failed: ${PSQL_BIN}`).trim() };
  }
  return { ok: true };
}

export function describeWithPostgres(availability: ReturnType<typeof probePostgres>) {
  return availability.ok || process.env.CI ? describe : describe.skip;
}
