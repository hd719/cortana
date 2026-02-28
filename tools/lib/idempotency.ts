#!/usr/bin/env npx tsx
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { withPostgresPath } from "./db.js";

const PATH_OVERRIDE = "/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function getPsqlBin(): string {
  return process.env.IDEMPOTENCY_PSQL_BIN ?? "/opt/homebrew/opt/postgresql@17/bin/psql";
}

function getDbName(): string {
  return process.env.IDEMPOTENCY_DB ?? process.env.CORTANA_DB ?? "cortana";
}

function getSource(): string {
  return process.env.IDEMPOTENCY_SOURCE ?? process.env.SOURCE ?? "idempotency";
}

function getTxnFile(): string {
  return process.env.IDEMPOTENCY_TXN_FILE ?? "";
}

function setTxnFile(value: string): void {
  if (value) {
    process.env.IDEMPOTENCY_TXN_FILE = value;
  } else {
    delete process.env.IDEMPOTENCY_TXN_FILE;
  }
}

function runPsql(args: string[], stdio: "inherit" | "pipe" | "ignore"): ReturnType<typeof spawnSync> {
  const env = withPostgresPath({
    ...process.env,
    PATH: `${PATH_OVERRIDE}:${process.env.PATH ?? ""}`,
  });
  return spawnSync(getPsqlBin(), args, { encoding: "utf8", stdio, env });
}

export function generateOperationId(): string {
  if (process.env.CORTANA_OPERATION_ID) {
    return process.env.CORTANA_OPERATION_ID;
  }
  return randomUUID().toLowerCase();
}

export function checkIdempotency(operationId: string): boolean {
  const opEsc = sqlEscape(operationId);
  const sql = `
    SELECT COUNT(*)::int
    FROM cortana_events
    WHERE event_type='idempotent_operation'
      AND COALESCE(metadata->>'operation_id','')='${opEsc}'
      AND COALESCE(metadata->>'status','') IN ('completed','success','done');
  `;

  const res = runPsql([getDbName(), "-q", "-X", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql], "pipe");
  if (res.status !== 0) return false;
  const count = String(res.stdout ?? "").replace(/\s+/g, "");
  return Number(count || "0") > 0;
}

export function logIdempotency(
  operationId: string,
  operationType: string,
  status: string,
  metadata = "{}"
): void {
  const opEsc = sqlEscape(operationId);
  const typeEsc = sqlEscape(operationType);
  const statusEsc = sqlEscape(status);
  const metaEsc = sqlEscape(metadata);
  const source = sqlEscape(getSource());

  const sql = `
    INSERT INTO cortana_events (event_type, source, severity, message, metadata)
    VALUES (
      'idempotent_operation',
      '${source}',
      CASE
        WHEN '${statusEsc}' IN ('failed','error') THEN 'error'
        WHEN '${statusEsc}' IN ('skipped','duplicate') THEN 'warning'
        ELSE 'info'
      END,
      'Idempotent operation ${typeEsc} -> ${statusEsc}',
      COALESCE('${metaEsc}'::jsonb, '{}'::jsonb)
        || jsonb_build_object(
          'operation_id','${opEsc}',
          'operation_type','${typeEsc}',
          'status','${statusEsc}',
          'logged_at', NOW()::text
        )
    );
  `;

  runPsql([getDbName(), "-q", "-X", "-v", "ON_ERROR_STOP=1", "-c", sql], "ignore");
}

export function beginTransaction(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortana-txn."));
  const txnFile = path.join(dir, "transaction.sql");
  fs.writeFileSync(txnFile, "BEGIN;\n", "utf8");
  setTxnFile(txnFile);
}

export function transactionExec(sql: string): void {
  const txnFile = getTxnFile();
  if (!txnFile || !fs.existsSync(txnFile)) {
    const res = runPsql([getDbName(), "-q", "-X", "-v", "ON_ERROR_STOP=1", "-c", sql], "inherit");
    if (res.status !== 0) {
      throw new Error("Transaction SQL execution failed");
    }
    return;
  }
  fs.appendFileSync(txnFile, `${sql}\n`, "utf8");
}

export function commitTransaction(): void {
  const txnFile = getTxnFile();
  if (!txnFile || !fs.existsSync(txnFile)) return;
  fs.appendFileSync(txnFile, "COMMIT;\n", "utf8");
  const res = runPsql([getDbName(), "-q", "-X", "-v", "ON_ERROR_STOP=1", "-f", txnFile], "ignore");
  if (res.status !== 0) {
    throw new Error("Transaction commit failed");
  }
  fs.rmSync(txnFile, { force: true });
  const dir = path.dirname(txnFile);
  if (dir && dir.startsWith(os.tmpdir())) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  setTxnFile("");
}

export function rollbackTransaction(): void {
  const txnFile = getTxnFile();
  if (txnFile && fs.existsSync(txnFile)) {
    fs.rmSync(txnFile, { force: true });
    const dir = path.dirname(txnFile);
    if (dir && dir.startsWith(os.tmpdir())) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  setTxnFile("");
}

async function main(): Promise<number> {
  return 0;
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(selfPath)) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
