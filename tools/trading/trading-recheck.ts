#!/usr/bin/env npx tsx

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { extractSignalsFromPipelineReport, resolvePythonBin, resolveBacktesterCwd } from "./trading-cron-alert";

type BaseSummary = {
  runId: string;
  status: "success" | "failed";
  completedAt: string;
  artifacts: {
    directory: string;
    summary: string;
    log: string;
    stdout?: string;
    message?: string;
  };
};

type QuickCheckResult = {
  symbol: string;
  verdict: string;
  reason?: string;
  analysis_path?: string;
  base_action?: string | null;
  score?: number | null;
  confidence?: number | null;
};

type QuickCheckBatchPayload = {
  generated_at?: string;
  count?: number;
  results: QuickCheckResult[];
};

type SymbolState = {
  verdict: string;
  reason?: string;
  baseAction?: string | null;
  score?: number | null;
  confidence?: number | null;
  lastSeenAt: string;
  lastAlertedAt?: string | null;
  lastAlertSignature?: string | null;
};

type RecheckState = {
  schemaVersion: 1;
  updatedAt: string;
  symbols: Record<string, SymbolState>;
};

export type TrackedSymbol = {
  ticker: string;
  sections: string[];
  actions: Array<"BUY" | "WATCH">;
};

export type RecheckChange = {
  symbol: string;
  previousVerdict: string;
  verdict: string;
  direction: "upgrade" | "downgrade" | "changed";
  reason: string;
  baseAction?: string | null;
  score?: number | null;
  confidence?: number | null;
};

const ROOT_DIR = process.cwd();
const RESOLVED_BACKTEST_ROOT = process.env.BACKTEST_ROOT_DIR || path.join(ROOT_DIR, "var", "backtests");
const RUNS_DIR = path.join(RESOLVED_BACKTEST_ROOT, "runs");
const STATE_PATH = process.env.TRADING_RECHECK_STATE_PATH || path.join(RESOLVED_BACKTEST_ROOT, "rechecks", "state.json");
const MAX_BASE_AGE_MS = Number(process.env.TRADING_RECHECK_MAX_BASE_AGE_MS || 4 * 60 * 60 * 1000);
const COOLDOWN_MS = Number(process.env.TRADING_RECHECK_COOLDOWN_MS || 4 * 60 * 60 * 1000);
const MAX_ALERT_CHANGES = Number(process.env.TRADING_RECHECK_MAX_ALERT_CHANGES || 6);
const QUICK_CHECK_COMMAND = process.env.TRADING_RECHECK_COMMAND?.trim();
const EXCLUDE_SYMBOLS_RAW = process.env.TRADING_RECHECK_EXCLUDE_SYMBOLS || "";
const EXCLUDE_FILE = process.env.TRADING_RECHECK_EXCLUDE_FILE?.trim();

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, payload: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

function parseIsoMs(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Date.parse(raw);
  return Number.isFinite(value) ? value : null;
}

export function listBaseSummaries(runsDir: string = RUNS_DIR): Array<{ file: string; summary: BaseSummary }> {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .map((entry) => path.join(runsDir, entry, "summary.json"))
    .filter((file) => existsSync(file))
    .map((file) => ({ file, summary: readJson<BaseSummary>(file) }))
    .filter((item): item is { file: string; summary: BaseSummary } => Boolean(item.summary));
}

export function pickEligibleBaseRun(
  candidates: Array<{ file: string; summary: BaseSummary }>,
  nowMs: number = Date.now(),
  maxAgeMs: number = MAX_BASE_AGE_MS,
): { file: string; summary: BaseSummary } | null {
  const latest = [...candidates]
    .sort((a, b) => String(a.summary.completedAt).localeCompare(String(b.summary.completedAt)))
    .pop();
  if (!latest) return null;
  if (latest.summary.status !== "success") return null;
  const completedAtMs = parseIsoMs(latest.summary.completedAt);
  if (completedAtMs == null) return null;
  if (nowMs - completedAtMs > maxAgeMs) return null;
  if (!latest.summary.artifacts?.stdout || !existsSync(latest.summary.artifacts.stdout)) return null;
  return latest;
}

export function extractTrackedSymbols(report: string): TrackedSymbol[] {
  const byTicker = new Map<string, TrackedSymbol>();
  for (const signal of extractSignalsFromPipelineReport(report).all) {
    if (signal.action === "NO_BUY") continue;
    const current = byTicker.get(signal.ticker) || { ticker: signal.ticker, sections: [], actions: [] };
    if (!current.sections.includes(signal.section)) current.sections.push(signal.section);
    if (!current.actions.includes(signal.action)) current.actions.push(signal.action);
    byTicker.set(signal.ticker, current);
  }
  return [...byTicker.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
}

function parseSymbolTokens(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((value) => value.trim().toUpperCase())
    .filter((value) => Boolean(value));
}

export function loadRecheckExcludedSymbols(
  rawList: string = EXCLUDE_SYMBOLS_RAW,
  filePath: string | undefined = EXCLUDE_FILE,
): Set<string> {
  const excluded = new Set<string>(parseSymbolTokens(rawList));
  if (!filePath) return excluded;

  try {
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const withoutComment = line.replace(/#.*/, "").trim();
      if (!withoutComment) continue;
      for (const symbol of parseSymbolTokens(withoutComment)) {
        excluded.add(symbol);
      }
    }
  } catch {
    return excluded;
  }

  return excluded;
}

export function applyTrackedSymbolExclusions(tracked: TrackedSymbol[], excluded: Set<string>): TrackedSymbol[] {
  if (!excluded.size) return tracked;
  return tracked.filter((item) => !excluded.has(item.ticker.toUpperCase()));
}

function defaultBatchCommand(symbols: string[]): { command: string; args: string[]; cwd: string } {
  return {
    command: resolvePythonBin(),
    args: ["quick_check_batch.py", "--symbols", symbols.join(",")],
    cwd: resolveBacktesterCwd(),
  };
}

export function runQuickCheckBatch(symbols: string[]): QuickCheckBatchPayload {
  if (!symbols.length) return { results: [] };
  const defaultCommand = defaultBatchCommand(symbols);
  const proc = QUICK_CHECK_COMMAND
    ? spawnSync("/bin/sh", ["-lc", QUICK_CHECK_COMMAND], {
      cwd: ROOT_DIR,
      encoding: "utf8",
      env: { ...process.env, TRADING_RECHECK_SYMBOLS: symbols.join(",") },
    })
    : spawnSync(defaultCommand.command, defaultCommand.args, {
      cwd: defaultCommand.cwd,
      encoding: "utf8",
      env: process.env,
    });

  if (proc.error) throw proc.error;
  if ((proc.status ?? 1) !== 0) {
    throw new Error((proc.stderr || proc.stdout || "quick-check batch failed").trim());
  }

  const payload = JSON.parse((proc.stdout || "{}").trim()) as QuickCheckBatchPayload;
  if (!payload || !Array.isArray(payload.results)) {
    throw new Error("quick-check batch returned invalid payload");
  }
  return payload;
}

export function loadState(file: string = STATE_PATH): RecheckState {
  const raw = readJson<RecheckState>(file);
  if (!raw || typeof raw !== "object" || typeof raw.symbols !== "object") {
    return { schemaVersion: 1, updatedAt: new Date(0).toISOString(), symbols: {} };
  }
  return raw;
}

function verdictRank(verdict: string): number {
  const value = verdict.trim().toLowerCase();
  if (value === "actionable") return 4;
  if (value === "needs confirmation") return 3;
  if (value === "early / interesting") return 2;
  if (value === "extended" || value === "manage winners / exhaustion risk") return 2;
  return 1;
}

function buildDirection(previousVerdict: string, nextVerdict: string): "upgrade" | "downgrade" | "changed" {
  const previousRank = verdictRank(previousVerdict);
  const nextRank = verdictRank(nextVerdict);
  if (nextRank > previousRank) return "upgrade";
  if (nextRank < previousRank) return "downgrade";
  return "changed";
}

function transitionSignature(symbol: string, previousVerdict: string, verdict: string): string {
  return `${symbol}:${previousVerdict}->${verdict}`;
}

export function evaluateRecheckChanges(
  previousState: RecheckState,
  results: QuickCheckResult[],
  nowMs: number = Date.now(),
  cooldownMs: number = COOLDOWN_MS,
): { changes: RecheckChange[]; nextState: RecheckState } {
  const nextSymbols: Record<string, SymbolState> = { ...previousState.symbols };
  const changes: RecheckChange[] = [];
  const nowIso = new Date(nowMs).toISOString();

  for (const result of results) {
    const symbol = String(result.symbol || "").trim().toUpperCase();
    if (!symbol) continue;
    const previous = previousState.symbols[symbol];
    const verdict = String(result.verdict || "avoid for now").trim();
    const previousVerdict = previous?.verdict?.trim();
    const signature = previousVerdict ? transitionSignature(symbol, previousVerdict, verdict) : null;
    const lastAlertedAtMs = parseIsoMs(previous?.lastAlertedAt ?? undefined);
    const withinCooldown =
      signature != null &&
      previous?.lastAlertSignature === signature &&
      lastAlertedAtMs != null &&
      nowMs - lastAlertedAtMs < cooldownMs;

    const nextSymbolState: SymbolState = {
      verdict,
      reason: result.reason,
      baseAction: result.base_action,
      score: result.score ?? null,
      confidence: result.confidence ?? null,
      lastSeenAt: nowIso,
      lastAlertedAt: previous?.lastAlertedAt ?? null,
      lastAlertSignature: previous?.lastAlertSignature ?? null,
    };

    if (previousVerdict && previousVerdict !== verdict && !withinCooldown) {
      const change: RecheckChange = {
        symbol,
        previousVerdict,
        verdict,
        direction: buildDirection(previousVerdict, verdict),
        reason: String(result.reason || "").trim(),
        baseAction: result.base_action,
        score: result.score ?? null,
        confidence: result.confidence ?? null,
      };
      changes.push(change);
      nextSymbolState.lastAlertedAt = nowIso;
      nextSymbolState.lastAlertSignature = signature;
    }

    nextSymbols[symbol] = nextSymbolState;
  }

  return {
    changes,
    nextState: {
      schemaVersion: 1,
      updatedAt: nowIso,
      symbols: nextSymbols,
    },
  };
}

function compactChange(change: RecheckChange): string {
  const score = change.score != null ? ` | ${change.score}/12` : "";
  const confidence = change.confidence != null ? ` | ${change.confidence}%` : "";
  return `${change.symbol} ${change.previousVerdict} -> ${change.verdict}${score}${confidence}`;
}

export function formatRecheckAlert(
  runId: string,
  tracked: TrackedSymbol[],
  changes: RecheckChange[],
  maxItems: number = MAX_ALERT_CHANGES,
): string {
  const upgrades = changes.filter((change) => change.direction === "upgrade");
  const nonUpgrades = changes.filter((change) => change.direction !== "upgrade");
  const lines = [
    "📈 Trading Re-check",
    `Base run: ${runId}`,
    `Re-checked: ${tracked.length} | Changes: ${changes.length}`,
  ];

  const pushGroup = (label: string, items: RecheckChange[]) => {
    if (!items.length) return;
    const shown = items.slice(0, maxItems).map(compactChange).join("; ");
    const remaining = items.length - Math.min(items.length, maxItems);
    lines.push(`${label}: ${shown}${remaining > 0 ? ` (+${remaining} more)` : ""}`);
  };

  pushGroup("Upgrades", upgrades);
  pushGroup("Downgrades", nonUpgrades);
  return lines.join("\n");
}

function main(): void {
  const picked = pickEligibleBaseRun(listBaseSummaries());
  if (!picked) {
    console.log("NO_REPLY");
    return;
  }

  const report = readFileSync(picked.summary.artifacts.stdout!, "utf8");
  const excludedSymbols = loadRecheckExcludedSymbols();
  const tracked = applyTrackedSymbolExclusions(extractTrackedSymbols(report), excludedSymbols);
  if (!tracked.length) {
    console.log("NO_REPLY");
    return;
  }

  const batch = runQuickCheckBatch(tracked.map((item) => item.ticker));
  const previousState = loadState();
  const evaluation = evaluateRecheckChanges(previousState, batch.results);
  writeJsonAtomic(STATE_PATH, evaluation.nextState);

  if (!evaluation.changes.length) {
    console.log("NO_REPLY");
    return;
  }

  console.log(formatRecheckAlert(picked.summary.runId, tracked, evaluation.changes));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
