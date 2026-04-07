import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runPsql, withPostgresPath } from "../lib/db";

type RunStatus = "queued" | "running" | "success" | "failed" | "cancelled";

type BacktestSummary = {
  schemaVersion?: number;
  schema_version?: number;
  runId?: string;
  run_id?: string;
  strategy?: string;
  status?: string;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  finalizedAt?: string;
  notifiedAt?: string | null;
  metrics?: Record<string, unknown>;
  host?: string;
  artifacts?: {
    directory?: string;
    summary?: string;
    log?: string;
    stdout?: string;
    stderr?: string;
    message?: string;
    watchlistFullJson?: string;
  };
  error?:
    | string
    | {
        message?: string;
        summary?: string;
      };
  lastError?: string;
  last_error?: string;
};

type TradingRunStateRecord = {
  id: string;
  runId: string;
  schemaVersion: number;
  strategy: string;
  status: RunStatus | string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  notifiedAt: string | null;
  deliveryStatus: string | null;
  decision: string | null;
  confidence: number | null;
  risk: string | null;
  correctionMode: boolean | null;
  buyCount: number | null;
  watchCount: number | null;
  noBuyCount: number | null;
  symbolsScanned: number | null;
  candidatesEvaluated: number | null;
  focusTicker: string | null;
  focusAction: string | null;
  focusStrategy: string | null;
  dipBuyerBuy: string[];
  dipBuyerWatch: string[];
  dipBuyerNoBuy: string[];
  canslimBuy: string[];
  canslimWatch: string[];
  canslimNoBuy: string[];
  artifactDirectory: string | null;
  summaryPath: string | null;
  messagePath: string | null;
  watchlistPath: string | null;
  messagePreview: string | null;
  metrics: Record<string, unknown> | null;
  lastError: string | null;
  sourceHost: string | null;
};

type SyncOptions = {
  env?: NodeJS.ProcessEnv;
  deliveryStatus?: string | null;
  lastError?: string | null;
  sourceHost?: string | null;
};

export type TradingRunStateSyncResult =
  | { ok: true; mode: "written" }
  | { ok: false; mode: "skipped" | "failed"; reason: string };

type StartRecordOptions = {
  runId: string;
  strategy: string;
  createdAt: string;
  startedAt?: string | null;
  artifactDirectory: string;
  summaryPath: string;
  messagePath: string;
  watchlistPath: string;
  sourceHost?: string | null;
};

export function syncTradingRunStarted(options: StartRecordOptions, syncOptions: SyncOptions = {}): TradingRunStateSyncResult {
  const record: TradingRunStateRecord = {
    id: options.runId,
    runId: options.runId,
    schemaVersion: 1,
    strategy: options.strategy,
    status: "running",
    createdAt: options.createdAt,
    startedAt: options.startedAt ?? options.createdAt,
    completedAt: null,
    notifiedAt: null,
    deliveryStatus: "pending",
    decision: null,
    confidence: null,
    risk: null,
    correctionMode: null,
    buyCount: null,
    watchCount: null,
    noBuyCount: null,
    symbolsScanned: null,
    candidatesEvaluated: null,
    focusTicker: null,
    focusAction: null,
    focusStrategy: null,
    dipBuyerBuy: [],
    dipBuyerWatch: [],
    dipBuyerNoBuy: [],
    canslimBuy: [],
    canslimWatch: [],
    canslimNoBuy: [],
    artifactDirectory: options.artifactDirectory,
    summaryPath: options.summaryPath,
    messagePath: options.messagePath,
    watchlistPath: options.watchlistPath,
    messagePreview: null,
    metrics: null,
    lastError: null,
    sourceHost: options.sourceHost ?? syncOptions.sourceHost ?? os.hostname(),
  };
  return writeTradingRunStateRecord(record, syncOptions.env);
}

export function syncTradingRunFromArtifacts(summaryPath: string, options: SyncOptions = {}): TradingRunStateSyncResult {
  const record = buildTradingRunStateRecordFromArtifacts(summaryPath, options);
  if (!record) {
    return { ok: false, mode: "failed", reason: `summary artifact missing or invalid at ${summaryPath}` };
  }
  return writeTradingRunStateRecord(record, options.env);
}

export function buildTradingRunStateRecordFromArtifacts(
  summaryPath: string,
  options: Omit<SyncOptions, "env"> = {},
): TradingRunStateRecord | null {
  const summaryData = readJsonIfExists(summaryPath);
  if (!summaryData) return null;

  const runPath = path.dirname(summaryPath);
  const messagePath = stringValue(asRecord(summaryData.artifacts)?.message) ?? path.join(runPath, "message.txt");
  const watchlistPath =
    stringValue(asRecord(summaryData.artifacts)?.watchlistFullJson) ?? path.join(runPath, "watchlist-full.json");
  const stderrPath = stringValue(asRecord(summaryData.artifacts)?.stderr) ?? path.join(runPath, "stderr.txt");

  const watchlistData = readJsonIfExists(watchlistPath);
  const message = readTextIfExists(messagePath);
  const stderr = readTextIfExists(stderrPath);

  const metrics = asRecord(summaryData.metrics);
  const watchlistSummary = asRecord(watchlistData?.summary);
  const focus = asRecord(watchlistData?.focus);
  const strategies = asRecord(watchlistData?.strategies);
  const dipBuyer = asRecord(strategies?.dipBuyer);
  const canslim = asRecord(strategies?.canslim);

  const runId =
    stringValue(summaryData.runId) ??
    stringValue(summaryData.run_id) ??
    path.basename(runPath);
  const createdAt =
    stringValue(summaryData.createdAt) ??
    stringValue(summaryData.startedAt) ??
    stringValue(summaryData.completedAt) ??
    stringValue(summaryData.finalizedAt) ??
    parseRunIdTimestamp(runId) ??
    new Date().toISOString();
  const startedAt = stringValue(summaryData.startedAt);
  const completedAt = stringValue(summaryData.completedAt) ?? stringValue(summaryData.finalizedAt);
  const notifiedAt = stringValue(summaryData.notifiedAt);
  const normalizedStatus = stringValue(summaryData.status) ?? (completedAt ? "success" : "unknown");

  return {
    id: runId,
    runId,
    schemaVersion: numberValue(summaryData.schemaVersion) ?? numberValue(summaryData.schema_version) ?? 1,
    strategy: stringValue(summaryData.strategy) ?? "Trading market-session unified",
    status: normalizedStatus,
    createdAt,
    startedAt,
    completedAt,
    notifiedAt,
    deliveryStatus: options.deliveryStatus ?? deriveDeliveryStatus(normalizedStatus, notifiedAt),
    decision: stringValue(watchlistData?.decision) ?? stringValue(metrics?.decision),
    confidence: numberValue(metrics?.confidence),
    risk: stringValue(metrics?.risk),
    correctionMode: booleanValue(watchlistData?.correctionMode) ?? booleanValue(metrics?.correctionMode),
    buyCount: numberValue(watchlistSummary?.buy) ?? numberValue(metrics?.buy),
    watchCount: numberValue(watchlistSummary?.watch) ?? numberValue(metrics?.watch),
    noBuyCount: numberValue(watchlistSummary?.noBuy) ?? numberValue(metrics?.noBuy),
    symbolsScanned: numberValue(metrics?.symbolsScanned),
    candidatesEvaluated: numberValue(metrics?.candidatesEvaluated),
    focusTicker: stringValue(focus?.ticker),
    focusAction: stringValue(focus?.action),
    focusStrategy: stringValue(focus?.strategy),
    dipBuyerBuy: extractTickers(dipBuyer?.buy),
    dipBuyerWatch: extractTickers(dipBuyer?.watch),
    dipBuyerNoBuy: extractTickers(dipBuyer?.noBuy),
    canslimBuy: extractTickers(canslim?.buy),
    canslimWatch: extractTickers(canslim?.watch),
    canslimNoBuy: extractTickers(canslim?.noBuy),
    artifactDirectory: stringValue(asRecord(summaryData.artifacts)?.directory) ?? runPath,
    summaryPath: stringValue(asRecord(summaryData.artifacts)?.summary) ?? summaryPath,
    messagePath: stringValue(asRecord(summaryData.artifacts)?.message) ?? (message ? messagePath : null),
    watchlistPath: stringValue(asRecord(summaryData.artifacts)?.watchlistFullJson) ?? (watchlistData ? watchlistPath : null),
    messagePreview: message ? message.split(/\r?\n/).slice(0, 6).join("\n") : null,
    metrics,
    lastError: options.lastError ?? deriveLastError(summaryData, stderr),
    sourceHost: options.sourceHost ?? stringValue(summaryData.host) ?? os.hostname(),
  };
}

export function buildTradingRunUpsertSql(record: TradingRunStateRecord): string {
  const columns = [
    ["id", sqlText(record.id)],
    ["run_id", sqlText(record.runId)],
    ["schema_version", sqlInt(record.schemaVersion)],
    ["strategy", sqlText(record.strategy)],
    ["status", sqlText(record.status)],
    ["created_at", sqlTimestamp(record.createdAt)],
    ["started_at", sqlTimestamp(record.startedAt)],
    ["completed_at", sqlTimestamp(record.completedAt)],
    ["notified_at", sqlTimestamp(record.notifiedAt)],
    ["delivery_status", sqlText(record.deliveryStatus)],
    ["decision", sqlText(record.decision)],
    ["confidence", sqlFloat(record.confidence)],
    ["risk", sqlText(record.risk)],
    ["correction_mode", sqlBool(record.correctionMode)],
    ["buy_count", sqlInt(record.buyCount)],
    ["watch_count", sqlInt(record.watchCount)],
    ["no_buy_count", sqlInt(record.noBuyCount)],
    ["symbols_scanned", sqlInt(record.symbolsScanned)],
    ["candidates_evaluated", sqlInt(record.candidatesEvaluated)],
    ["focus_ticker", sqlText(record.focusTicker)],
    ["focus_action", sqlText(record.focusAction)],
    ["focus_strategy", sqlText(record.focusStrategy)],
    ["dip_buyer_buy", sqlTextArray(record.dipBuyerBuy)],
    ["dip_buyer_watch", sqlTextArray(record.dipBuyerWatch)],
    ["dip_buyer_no_buy", sqlTextArray(record.dipBuyerNoBuy)],
    ["canslim_buy", sqlTextArray(record.canslimBuy)],
    ["canslim_watch", sqlTextArray(record.canslimWatch)],
    ["canslim_no_buy", sqlTextArray(record.canslimNoBuy)],
    ["artifact_directory", sqlText(record.artifactDirectory)],
    ["summary_path", sqlText(record.summaryPath)],
    ["message_path", sqlText(record.messagePath)],
    ["watchlist_path", sqlText(record.watchlistPath)],
    ["message_preview", sqlText(record.messagePreview)],
    ["metrics", sqlJson(record.metrics)],
    ["last_error", sqlText(record.lastError)],
    ["source_host", sqlText(record.sourceHost)],
  ] as const;

  const insertColumns = columns.map(([name]) => `"${name}"`).join(", ");
  const insertValues = columns.map(([, value]) => value).join(", ");
  const updateAssignments = columns
    .filter(([name]) => name !== "id" && name !== "run_id")
    .map(([name]) => `"${name}" = EXCLUDED."${name}"`)
    .concat(`"updated_at" = CURRENT_TIMESTAMP`)
    .join(",\n    ");

  return `INSERT INTO mc_trading_runs (${insertColumns})
VALUES (${insertValues})
ON CONFLICT ("run_id") DO UPDATE
SET ${updateAssignments};`;
}

function writeTradingRunStateRecord(record: TradingRunStateRecord, env: NodeJS.ProcessEnv = process.env): TradingRunStateSyncResult {
  const databaseUrl = resolveMissionControlDatabaseUrl(env);
  if (!databaseUrl) {
    return { ok: false, mode: "skipped", reason: "MISSION_CONTROL_DATABASE_URL is not configured" };
  }

  const sql = buildTradingRunUpsertSql(record);
  const dbEnv = withPostgresPath({ ...env, DATABASE_URL: databaseUrl });
  const result = runPsql(sql, { db: databaseUrl, env: dbEnv });
  if ((result.status ?? 1) !== 0) {
    const message = String(result.stderr || result.stdout || "psql failed").trim();
    return { ok: false, mode: "failed", reason: message };
  }
  return { ok: true, mode: "written" };
}

function resolveMissionControlDatabaseUrl(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.MISSION_CONTROL_DATABASE_URL?.trim();
  if (explicit && explicit.length > 0) return explicit;

  const fallback = readEnvValue(
    path.join(resolveCortanaExternalRepo(env), "apps", "mission-control", ".env.local"),
    "DATABASE_URL",
  );
  return fallback && fallback.length > 0 ? fallback : null;
}

function resolveCortanaExternalRepo(env: NodeJS.ProcessEnv): string {
  const explicit = env.CORTANA_EXTERNAL_REPO?.trim();
  if (explicit && explicit.length > 0) return explicit;
  const home = env.HOME?.trim() || os.homedir();
  return path.join(home, "Developer", "cortana-external");
}

function readEnvValue(filePath: string, key: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const equals = trimmed.indexOf("=");
      if (equals <= 0) continue;
      if (trimmed.slice(0, equals).trim() !== key) continue;
      const value = trimmed.slice(equals + 1).trim();
      return stripOptionalQuotes(value);
    }
    return null;
  } catch {
    return null;
  }
}

function stripOptionalQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function deriveDeliveryStatus(status: string | null, notifiedAt: string | null): string | null {
  if (notifiedAt) return "notified";
  if (!status) return null;
  if (status === "failed" || status === "cancelled") return "failed";
  if (status === "success") return "pending";
  if (status === "queued" || status === "running") return "pending";
  return null;
}

function deriveLastError(summaryData: Record<string, unknown>, stderr: string): string | null {
  const explicit =
    stringValue(summaryData.lastError) ??
    stringValue(summaryData.last_error) ??
    stringValue(asRecord(summaryData.error)?.summary) ??
    stringValue(asRecord(summaryData.error)?.message) ??
    stringValue(summaryData.error);
  if (explicit) return explicit;
  const firstLine = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ?? null;
}

function extractTickers(value: unknown): string[] {
  return asArray(value)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => stringValue(entry.ticker))
    .filter((ticker): ticker is string => Boolean(ticker));
}

function readJsonIfExists(filePath: string): Record<string, unknown> | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readTextIfExists(filePath: string): string {
  try {
    if (!existsSync(filePath)) return "";
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function parseRunIdTimestamp(runId: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(runId);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
}

function sqlTimestamp(value: string | null): string {
  return value ? `timezone('UTC', '${escapeSql(value)}'::timestamptz)` : "NULL";
}

function sqlText(value: string | null): string {
  return value == null ? "NULL" : `'${escapeSql(value)}'`;
}

function sqlInt(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? String(Math.trunc(value)) : "NULL";
}

function sqlFloat(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "NULL";
}

function sqlBool(value: boolean | null): string {
  return value == null ? "NULL" : value ? "TRUE" : "FALSE";
}

function sqlJson(value: Record<string, unknown> | null): string {
  return value == null ? "NULL" : `'${escapeSql(JSON.stringify(value))}'::jsonb`;
}

function sqlTextArray(values: string[]): string {
  if (!values.length) return "ARRAY[]::text[]";
  return `ARRAY[${values.map((value) => `'${escapeSql(value)}'`).join(", ")}]::text[]`;
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
