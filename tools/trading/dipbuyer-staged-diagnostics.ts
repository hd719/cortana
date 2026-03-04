#!/usr/bin/env npx tsx

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runTradingPipeline } from "./trading-pipeline";

export type StageStatus = "ok" | "timeout" | "error" | "degraded";

type SummaryCounts = {
  scanned: number;
  evaluated: number;
  thresholdPassed: number;
  buy: number;
  watch: number;
  noBuy: number;
};

type TruncatedText = {
  value: string;
  bytes: number;
  truncated: boolean;
  maxChars: number;
};

type KeyComparison = {
  field: string;
  expected: string;
  actual: string;
  match: boolean;
};

type CircuitBreakerHint = {
  integrated: boolean;
  status: "ok" | "error";
  recommendedProvider?: string | null;
  reason?: string;
  note?: string;
};

type StageTimeouts = {
  stage1: number;
  stage2: number;
  stage3: number;
  stage4: number;
};

type CommandSpec = {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  errorMessage?: string;
};

export type Stage1Result = {
  stage: "stage1_runner";
  schemaVersion: "1.0";
  status: StageStatus;
  exitCode: number;
  durationMs: number;
  commandExitCode: number;
  command: CommandSpec;
  io: {
    stdout: TruncatedText;
    stderr: TruncatedText;
  };
};

export type Stage2Result = {
  stage: "stage2_parser";
  schemaVersion: "1.0";
  status: StageStatus;
  exitCode: number;
  durationMs: number;
  fromStage1: {
    status: StageStatus;
    exitCode: number;
    commandExitCode: number;
  };
  io: {
    stdout: TruncatedText;
    stderr: TruncatedText;
  };
  parsed: {
    marketRegime?: string;
    marketLine?: string;
    statusLine?: string;
    macroGateLine?: string;
    hyNoteLine?: string;
    dipProfileLine?: string;
    blockerLine?: string;
    blockerSamplesLine?: string;
    summary: SummaryCounts;
    signalSample: string[];
  };
  degradedReasons: string[];
};

export type Stage3Result = {
  stage: "stage3_verifier";
  schemaVersion: "1.0";
  status: StageStatus;
  exitCode: number;
  durationMs: number;
  fromStage2Status: StageStatus;
  unified: {
    status: StageStatus;
    report: TruncatedText;
    error?: string;
  };
  comparisons: KeyComparison[];
  mismatchCount: number;
  degradedReasons: string[];
  circuitBreaker?: CircuitBreakerHint;
};

export type Stage4Result = {
  stage: "stage4_reporter";
  schemaVersion: "1.0";
  status: StageStatus;
  exitCode: number;
  durationMs: number;
  evidenceLines: string[];
  nextAction: string;
  reportTemplate: string;
};

type Stage1Deps = {
  execute?: (spec: CommandSpec) => Promise<CommandResult>;
  now?: () => number;
};

type Stage3Deps = {
  runUnifiedPipeline?: () => Promise<string>;
  recommendCircuitBreaker?: (timeoutMs: number) => CircuitBreakerHint | undefined;
  now?: () => number;
};

const DEFAULT_MAX_CHARS = Number(process.env.TRADING_DIAG_MAX_CHARS ?? "2000");

const DEFAULT_TIMEOUTS: StageTimeouts = {
  stage1: Number(process.env.TRADING_DIAG_STAGE1_TIMEOUT_MS ?? "15000"),
  stage2: Number(process.env.TRADING_DIAG_STAGE2_TIMEOUT_MS ?? "3000"),
  stage3: Number(process.env.TRADING_DIAG_STAGE3_TIMEOUT_MS ?? "20000"),
  stage4: Number(process.env.TRADING_DIAG_STAGE4_TIMEOUT_MS ?? "2000"),
};

const DEFAULT_STAGE1_CWD = "/Users/hd/Developer/cortana-external/backtester";
const DEFAULT_SCAN_LIMIT = 120;
const EXTERNAL_FETCH_PATTERNS = [/unavailable after retries/i, /fallback/i, /fetch failed/i, /timed out fetching/i, /fred/i];

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

function stageExitCode(status: StageStatus): number {
  if (status === "ok") return 0;
  if (status === "degraded") return 2;
  if (status === "timeout") return 124;
  return 1;
}

function positiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.round(value);
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const ms = Math.max(1, positiveInt(timeoutMs, 1));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
    task
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function truncateText(raw: string, maxChars: number): TruncatedText {
  const value = raw ?? "";
  const max = positiveInt(maxChars, DEFAULT_MAX_CHARS);
  return {
    value: value.length > max ? value.slice(0, max) : value,
    bytes: Buffer.byteLength(value, "utf8"),
    truncated: value.length > max,
    maxChars: max,
  };
}

function parseSummaryLine(text: string): SummaryCounts {
  const summaryLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("Summary:"));

  if (!summaryLine) {
    return { scanned: 0, evaluated: 0, thresholdPassed: 0, buy: 0, watch: 0, noBuy: 0 };
  }

  const scanned = Number(summaryLine.match(/scanned\s+(\d+)/i)?.[1] ?? 0);
  const evaluated = Number(summaryLine.match(/evaluated\s+(\d+)/i)?.[1] ?? summaryLine.match(/Summary:\s*(\d+)\s+candidates/i)?.[1] ?? 0);
  const thresholdPassed = Number(summaryLine.match(/threshold-passed\s+(\d+)/i)?.[1] ?? evaluated);
  const buy = Number(summaryLine.match(/BUY\s+(\d+)/i)?.[1] ?? 0);
  const watch = Number(summaryLine.match(/WATCH\s+(\d+)/i)?.[1] ?? 0);
  const noBuy = Number(summaryLine.match(/NO_BUY\s+(\d+)/i)?.[1] ?? 0);

  return { scanned, evaluated, thresholdPassed, buy, watch, noBuy };
}

function parseMarketRegime(text: string): { marketRegime?: string; marketLine?: string; statusLine?: string } {
  const lines = text.split(/\r?\n/);
  const marketLine = lines.find((line) => line.startsWith("Market:"));
  const statusLine = lines.find((line) => line.startsWith("Status:"));
  const marketRegime = marketLine?.match(/^Market:\s*([^|]+)/i)?.[1]?.trim().toLowerCase();
  return { marketRegime, marketLine, statusLine };
}

function firstLineByPrefix(text: string, prefix: string): string | undefined {
  return text.split(/\r?\n/).find((line) => line.startsWith(prefix));
}

function hasExternalFetchFallback(text: string): boolean {
  return EXTERNAL_FETCH_PATTERNS.some((pattern) => pattern.test(text));
}

function parseMacroGateState(line?: string): string | undefined {
  if (!line) return undefined;
  return line.match(/Macro Gate:\s*([A-Z_]+)/i)?.[1]?.toUpperCase();
}

function parseUnifiedKeyFields(report: string): {
  dipSummary: Pick<SummaryCounts, "thresholdPassed" | "buy" | "watch" | "noBuy">;
  correctionMode?: boolean;
  macroGateState?: string;
} {
  const lines = report.split(/\r?\n/).map((line) => line.trim());
  const dipLine = lines.find((line) => line.startsWith("Dip Buyer:"));
  const regimeLine = lines.find((line) => line.startsWith("Regime/Gates:"));
  const macroLine = lines.find((line) => line.startsWith("Macro Gate:"));

  const thresholdPassed = Number(dipLine?.match(/threshold-passed\s+(\d+)/i)?.[1] ?? 0);
  const buy = Number(dipLine?.match(/BUY\s+(\d+)/i)?.[1] ?? 0);
  const watch = Number(dipLine?.match(/WATCH\s+(\d+)/i)?.[1] ?? 0);
  const noBuy = Number(dipLine?.match(/NO_BUY\s+(\d+)/i)?.[1] ?? 0);
  const correction = regimeLine?.match(/correction=(YES|NO)/i)?.[1]?.toUpperCase();

  return {
    dipSummary: { thresholdPassed, buy, watch, noBuy },
    correctionMode: correction ? correction === "YES" : undefined,
    macroGateState: parseMacroGateState(macroLine),
  };
}

function compareField(comparisons: KeyComparison[], field: string, expected: string | undefined, actual: string | undefined): void {
  if (expected === undefined || actual === undefined) return;
  comparisons.push({
    field,
    expected,
    actual,
    match: expected === actual,
  });
}

function defaultStage1Spec(): CommandSpec {
  const scanLimitRaw = Number(process.env.TRADING_SCAN_LIMIT_DIP ?? process.env.TRADING_SCAN_LIMIT ?? DEFAULT_SCAN_LIMIT);
  const scanLimit = Number.isFinite(scanLimitRaw) && scanLimitRaw > 0 ? Math.round(scanLimitRaw) : DEFAULT_SCAN_LIMIT;
  return {
    command: "python3",
    args: ["dipbuyer_alert.py", "--limit", String(scanLimit), "--min-score", "6"],
    cwd: DEFAULT_STAGE1_CWD,
    timeoutMs: DEFAULT_TIMEOUTS.stage1,
  };
}

function defaultExecuteCommand(spec: CommandSpec): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Math.max(1, positiveInt(spec.timeoutMs, DEFAULT_TIMEOUTS.stage1)));

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`.trim(),
        timedOut: false,
        errorMessage: error.message,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const signalLine = signal && !timedOut ? `Signal: ${signal}` : "";
      const mergedStderr = signalLine ? `${stderr}${stderr ? "\n" : ""}${signalLine}` : stderr;
      resolve({
        exitCode: timedOut ? 124 : typeof code === "number" ? code : 1,
        stdout,
        stderr: mergedStderr,
        timedOut,
      });
    });
  });
}

function defaultCircuitBreakerHint(timeoutMs: number): CircuitBreakerHint {
  const script = path.resolve(process.cwd(), "tools/guardrails/circuit-breaker.ts");
  if (!fs.existsSync(script)) {
    return {
      integrated: false,
      status: "error",
      note: "circuit-breaker utility unavailable",
    };
  }

  const result = spawnSync("npx", ["tsx", script, "--recommend"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: Math.max(500, positiveInt(timeoutMs, 1000)),
  });

  const stdout = (result.stdout ?? "").trim();
  if (result.status === 0) {
    try {
      const parsed = stdout ? (JSON.parse(stdout) as Record<string, unknown>) : {};
      return {
        integrated: true,
        status: "ok",
        recommendedProvider: (parsed.recommended_provider as string | null | undefined) ?? null,
        reason: (parsed.reason as string | undefined) ?? "recommendation_received",
      };
    } catch {
      return {
        integrated: true,
        status: "error",
        note: "failed to parse circuit-breaker recommendation output",
      };
    }
  }

  return {
    integrated: true,
    status: "error",
    note: (result.stderr || stdout || "circuit-breaker command failed").trim().slice(0, 240),
  };
}

export async function runStage1Runner(
  options?: Partial<CommandSpec> & { maxChars?: number; timeoutMs?: number },
  deps?: Stage1Deps
): Promise<Stage1Result> {
  const now = deps?.now ?? (() => Date.now());
  const start = now();
  const baseSpec = defaultStage1Spec();
  const spec: CommandSpec = {
    command: options?.command ?? baseSpec.command,
    args: options?.args ?? baseSpec.args,
    cwd: options?.cwd ?? baseSpec.cwd,
    timeoutMs: positiveInt(options?.timeoutMs ?? baseSpec.timeoutMs, baseSpec.timeoutMs),
  };
  const maxChars = positiveInt(options?.maxChars ?? DEFAULT_MAX_CHARS, DEFAULT_MAX_CHARS);
  const execute = deps?.execute ?? defaultExecuteCommand;

  try {
    const result = await withTimeout(execute(spec), spec.timeoutMs, "stage1_runner");
    const status: StageStatus = result.timedOut ? "timeout" : result.exitCode === 0 ? "ok" : "error";
    return {
      stage: "stage1_runner",
      schemaVersion: "1.0",
      status,
      exitCode: stageExitCode(status),
      durationMs: Math.max(0, now() - start),
      commandExitCode: result.exitCode,
      command: spec,
      io: {
        stdout: truncateText(result.stdout, maxChars),
        stderr: truncateText(result.stderr, maxChars),
      },
    };
  } catch (error) {
    const isTimeout = error instanceof TimeoutError;
    return {
      stage: "stage1_runner",
      schemaVersion: "1.0",
      status: isTimeout ? "timeout" : "error",
      exitCode: stageExitCode(isTimeout ? "timeout" : "error"),
      durationMs: Math.max(0, now() - start),
      commandExitCode: isTimeout ? 124 : 1,
      command: spec,
      io: {
        stdout: truncateText("", maxChars),
        stderr: truncateText(error instanceof Error ? error.message : String(error), maxChars),
      },
    };
  }
}

export async function runStage2Parser(
  stage1: Stage1Result,
  options?: { timeoutMs?: number; maxChars?: number; now?: () => number }
): Promise<Stage2Result> {
  const now = options?.now ?? (() => Date.now());
  const start = now();
  const timeoutMs = positiveInt(options?.timeoutMs ?? DEFAULT_TIMEOUTS.stage2, DEFAULT_TIMEOUTS.stage2);
  const maxChars = positiveInt(options?.maxChars ?? DEFAULT_MAX_CHARS, DEFAULT_MAX_CHARS);

  const work = async (): Promise<Stage2Result> => {
    const stdout = stage1.io.stdout.value;
    const stderr = stage1.io.stderr.value;
    const parsedSummary = parseSummaryLine(stdout);
    const { marketRegime, marketLine, statusLine } = parseMarketRegime(stdout);
    const macroGateLine = firstLineByPrefix(stdout, "Macro Gate:");
    const hyNoteLine = firstLineByPrefix(stdout, "HY Note:");
    const dipProfileLine = firstLineByPrefix(stdout, "Dip Profile:");
    const blockerLine = firstLineByPrefix(stdout, "Blockers:");
    const blockerSamplesLine = firstLineByPrefix(stdout, "Blocker samples:");
    const signalSample = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("• "))
      .slice(0, 4);

    const degradedReasons: string[] = [];
    const mergedText = `${stdout}\n${stderr}`;
    if (stage1.status === "timeout") degradedReasons.push("stage1_timeout");
    if (stage1.status === "error") degradedReasons.push("stage1_error");
    if (hasExternalFetchFallback(mergedText)) degradedReasons.push("external_fetch_fallback_detected");

    const status: StageStatus =
      stage1.status === "timeout"
        ? "timeout"
        : stage1.status === "error"
          ? "error"
          : degradedReasons.length > 0
            ? "degraded"
            : "ok";

    return {
      stage: "stage2_parser",
      schemaVersion: "1.0",
      status,
      exitCode: stageExitCode(status),
      durationMs: Math.max(0, now() - start),
      fromStage1: {
        status: stage1.status,
        exitCode: stage1.exitCode,
        commandExitCode: stage1.commandExitCode,
      },
      io: {
        stdout: truncateText(stdout, maxChars),
        stderr: truncateText(stderr, maxChars),
      },
      parsed: {
        marketRegime,
        marketLine,
        statusLine,
        macroGateLine,
        hyNoteLine,
        dipProfileLine,
        blockerLine,
        blockerSamplesLine,
        summary: parsedSummary,
        signalSample,
      },
      degradedReasons,
    };
  };

  try {
    return await withTimeout(work(), timeoutMs, "stage2_parser");
  } catch (error) {
    const isTimeout = error instanceof TimeoutError;
    return {
      stage: "stage2_parser",
      schemaVersion: "1.0",
      status: isTimeout ? "timeout" : "error",
      exitCode: stageExitCode(isTimeout ? "timeout" : "error"),
      durationMs: Math.max(0, now() - start),
      fromStage1: {
        status: stage1.status,
        exitCode: stage1.exitCode,
        commandExitCode: stage1.commandExitCode,
      },
      io: {
        stdout: stage1.io.stdout,
        stderr: truncateText(error instanceof Error ? error.message : String(error), maxChars),
      },
      parsed: {
        summary: parseSummaryLine(stage1.io.stdout.value),
        signalSample: [],
      },
      degradedReasons: isTimeout ? ["stage2_timeout"] : ["stage2_error"],
    };
  }
}

export async function runStage3Verifier(
  stage2: Stage2Result,
  options?: { timeoutMs?: number; maxChars?: number },
  deps?: Stage3Deps
): Promise<Stage3Result> {
  const now = deps?.now ?? (() => Date.now());
  const start = now();
  const timeoutMs = positiveInt(options?.timeoutMs ?? DEFAULT_TIMEOUTS.stage3, DEFAULT_TIMEOUTS.stage3);
  const maxChars = positiveInt(options?.maxChars ?? DEFAULT_MAX_CHARS, DEFAULT_MAX_CHARS);
  const runUnified = deps?.runUnifiedPipeline ?? (async () => runTradingPipeline());
  const recommendCircuitBreaker = deps?.recommendCircuitBreaker ?? defaultCircuitBreakerHint;

  let unifiedReport = "";
  let unifiedStatus: StageStatus = "ok";
  let unifiedError: string | undefined;

  try {
    unifiedReport = await withTimeout(runUnified(), timeoutMs, "stage3_verifier/unified_pipeline");
  } catch (error) {
    unifiedStatus = error instanceof TimeoutError ? "timeout" : "error";
    unifiedError = error instanceof Error ? error.message : String(error);
  }

  const comparisons: KeyComparison[] = [];
  if (unifiedStatus === "ok") {
    const unified = parseUnifiedKeyFields(unifiedReport);
    const expected = stage2.parsed.summary;
    compareField(comparisons, "dip_summary_buy", String(expected.buy), String(unified.dipSummary.buy));
    compareField(comparisons, "dip_summary_watch", String(expected.watch), String(unified.dipSummary.watch));
    compareField(comparisons, "dip_summary_no_buy", String(expected.noBuy), String(unified.dipSummary.noBuy));
    compareField(comparisons, "dip_threshold_passed", String(expected.thresholdPassed), String(unified.dipSummary.thresholdPassed));

    const expectedCorrection = stage2.parsed.marketRegime ? String(stage2.parsed.marketRegime === "correction") : undefined;
    const actualCorrection = unified.correctionMode === undefined ? undefined : String(unified.correctionMode);
    compareField(comparisons, "correction_mode", expectedCorrection, actualCorrection);

    const expectedMacroGate = parseMacroGateState(stage2.parsed.macroGateLine);
    compareField(comparisons, "macro_gate", expectedMacroGate, unified.macroGateState);
  }

  const mismatchCount = comparisons.filter((item) => !item.match).length;
  const degradedReasons = [...stage2.degradedReasons];
  if (mismatchCount > 0) degradedReasons.push(`verification_mismatch_count_${mismatchCount}`);

  let status: StageStatus;
  if (unifiedStatus === "timeout") {
    status = "timeout";
  } else if (unifiedStatus === "error") {
    status = "error";
  } else if (stage2.status === "timeout") {
    status = "timeout";
  } else if (stage2.status === "error") {
    status = "error";
  } else if (stage2.status === "degraded" || mismatchCount > 0) {
    status = "degraded";
  } else {
    status = "ok";
  }

  let circuitBreaker: CircuitBreakerHint | undefined;
  if (degradedReasons.some((reason) => reason.includes("external_fetch"))) {
    circuitBreaker = recommendCircuitBreaker(Math.max(500, Math.floor(timeoutMs / 4)));
    if (!circuitBreaker || circuitBreaker.status !== "ok") {
      degradedReasons.push("circuit_breaker_hint_unavailable");
    }
  }

  return {
    stage: "stage3_verifier",
    schemaVersion: "1.0",
    status,
    exitCode: stageExitCode(status),
    durationMs: Math.max(0, now() - start),
    fromStage2Status: stage2.status,
    unified: {
      status: unifiedStatus,
      report: truncateText(unifiedReport, maxChars),
      error: unifiedError ? truncateText(unifiedError, 240).value : undefined,
    },
    comparisons,
    mismatchCount,
    degradedReasons,
    circuitBreaker,
  };
}

function nextActionFor(status: StageStatus, stage3: Stage3Result): string {
  if (status === "ok") return "No action needed. Keep current diagnostics cadence.";
  if (status === "timeout") return "Increase stage timeout or inspect dipbuyer command latency before rerun.";
  if (status === "error") return "Inspect stage error details and rerun diagnostics after fixing command/runtime issues.";
  if (stage3.degradedReasons.some((reason) => reason.includes("external_fetch"))) {
    const provider = stage3.circuitBreaker?.recommendedProvider;
    if (provider) return `External data fetch degraded; retry once data source recovers and keep provider fallback ${provider}.`;
    return "External fetch degraded; rely on fallback diagnostics and rerun when upstream data source recovers.";
  }
  if (stage3.mismatchCount > 0) return "Investigate stage2/stage3 key-field mismatch before relying on diagnostics.";
  return "Review degraded telemetry and rerun diagnostics once warnings clear.";
}

export async function runStage4Reporter(
  stage3: Stage3Result,
  options?: { timeoutMs?: number; now?: () => number }
): Promise<Stage4Result> {
  const now = options?.now ?? (() => Date.now());
  const start = now();
  const timeoutMs = positiveInt(options?.timeoutMs ?? DEFAULT_TIMEOUTS.stage4, DEFAULT_TIMEOUTS.stage4);

  const work = async (): Promise<Stage4Result> => {
    const evidence: string[] = [];
    evidence.push(`stage3_status=${stage3.status}; unified_status=${stage3.unified.status}`);
    evidence.push(`mismatch_count=${stage3.mismatchCount}`);

    const cmpSample = stage3.comparisons.find((item) => !item.match) ?? stage3.comparisons[0];
    if (cmpSample) evidence.push(`field_${cmpSample.field}: expected=${cmpSample.expected} actual=${cmpSample.actual}`);

    for (const reason of stage3.degradedReasons) {
      evidence.push(`degraded_reason=${reason}`);
    }

    if (stage3.circuitBreaker) {
      if (stage3.circuitBreaker.status === "ok") {
        evidence.push(
          `circuit_breaker=${stage3.circuitBreaker.recommendedProvider ?? "null"} (${stage3.circuitBreaker.reason ?? "recommendation"})`
        );
      } else {
        evidence.push(`circuit_breaker_error=${stage3.circuitBreaker.note ?? "unknown"}`);
      }
    }

    const reportBytes = stage3.unified.report.bytes;
    evidence.push(`unified_report_bytes=${reportBytes}; truncated=${stage3.unified.report.truncated ? "yes" : "no"}`);

    const evidenceLines = evidence.slice(0, 8);
    const nextAction = nextActionFor(stage3.status, stage3);
    const reportTemplate = [
      `VERDICT: ${stage3.status.toUpperCase()}`,
      "EVIDENCE:",
      ...evidenceLines.map((line) => `- ${line}`),
      `NEXT ACTION: ${nextAction}`,
    ].join("\n");

    return {
      stage: "stage4_reporter",
      schemaVersion: "1.0",
      status: stage3.status,
      exitCode: stageExitCode(stage3.status),
      durationMs: Math.max(0, now() - start),
      evidenceLines,
      nextAction,
      reportTemplate,
    };
  };

  try {
    return await withTimeout(work(), timeoutMs, "stage4_reporter");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status: StageStatus = error instanceof TimeoutError ? "timeout" : "error";
    const evidenceLines = [`reporter_failure=${message.slice(0, 220)}`];
    const nextAction = "Fix reporter execution issue and rerun diagnostics.";
    return {
      stage: "stage4_reporter",
      schemaVersion: "1.0",
      status,
      exitCode: stageExitCode(status),
      durationMs: Math.max(0, now() - start),
      evidenceLines,
      nextAction,
      reportTemplate: `VERDICT: ${status.toUpperCase()}\nEVIDENCE:\n- ${evidenceLines[0]}\nNEXT ACTION: ${nextAction}`,
    };
  }
}

export async function runDiagnosticsE2E(options?: {
  maxChars?: number;
  stageTimeouts?: Partial<StageTimeouts>;
}): Promise<{ stage1: Stage1Result; stage2: Stage2Result; stage3: Stage3Result; stage4: Stage4Result }> {
  const maxChars = positiveInt(options?.maxChars ?? DEFAULT_MAX_CHARS, DEFAULT_MAX_CHARS);
  const timeouts: StageTimeouts = {
    stage1: positiveInt(options?.stageTimeouts?.stage1 ?? DEFAULT_TIMEOUTS.stage1, DEFAULT_TIMEOUTS.stage1),
    stage2: positiveInt(options?.stageTimeouts?.stage2 ?? DEFAULT_TIMEOUTS.stage2, DEFAULT_TIMEOUTS.stage2),
    stage3: positiveInt(options?.stageTimeouts?.stage3 ?? DEFAULT_TIMEOUTS.stage3, DEFAULT_TIMEOUTS.stage3),
    stage4: positiveInt(options?.stageTimeouts?.stage4 ?? DEFAULT_TIMEOUTS.stage4, DEFAULT_TIMEOUTS.stage4),
  };

  const stage1 = await runStage1Runner({ timeoutMs: timeouts.stage1, maxChars });
  const stage2 = await runStage2Parser(stage1, { timeoutMs: timeouts.stage2, maxChars });
  const stage3 = await runStage3Verifier(stage2, { timeoutMs: timeouts.stage3, maxChars });
  const stage4 = await runStage4Reporter(stage3, { timeoutMs: timeouts.stage4 });
  return { stage1, stage2, stage3, stage4 };
}

function parseSharedArgs(args: string[]): { maxChars: number; timeoutMs?: number; inputPath?: string; inputJson?: string } {
  const out: { maxChars: number; timeoutMs?: number; inputPath?: string; inputJson?: string } = {
    maxChars: DEFAULT_MAX_CHARS,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--max-chars") {
      out.maxChars = positiveInt(Number(args[++i]), DEFAULT_MAX_CHARS);
      continue;
    }
    if (arg === "--timeout-ms") {
      out.timeoutMs = positiveInt(Number(args[++i]), DEFAULT_TIMEOUTS.stage1);
      continue;
    }
    if (arg === "--input") {
      out.inputPath = args[++i];
      continue;
    }
    if (arg === "--input-json") {
      out.inputJson = args[++i];
      continue;
    }
  }

  return out;
}

function parseE2EArgs(args: string[]): { maxChars: number; stageTimeouts: Partial<StageTimeouts> } {
  const out: { maxChars: number; stageTimeouts: Partial<StageTimeouts> } = {
    maxChars: DEFAULT_MAX_CHARS,
    stageTimeouts: {},
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--max-chars") {
      out.maxChars = positiveInt(Number(args[++i]), DEFAULT_MAX_CHARS);
      continue;
    }
    if (arg === "--stage1-timeout-ms") {
      out.stageTimeouts.stage1 = positiveInt(Number(args[++i]), DEFAULT_TIMEOUTS.stage1);
      continue;
    }
    if (arg === "--stage2-timeout-ms") {
      out.stageTimeouts.stage2 = positiveInt(Number(args[++i]), DEFAULT_TIMEOUTS.stage2);
      continue;
    }
    if (arg === "--stage3-timeout-ms") {
      out.stageTimeouts.stage3 = positiveInt(Number(args[++i]), DEFAULT_TIMEOUTS.stage3);
      continue;
    }
    if (arg === "--stage4-timeout-ms") {
      out.stageTimeouts.stage4 = positiveInt(Number(args[++i]), DEFAULT_TIMEOUTS.stage4);
      continue;
    }
  }

  return out;
}

function readInputPayload<T>(inputPath?: string, inputJson?: string): T {
  if (inputJson) return JSON.parse(inputJson) as T;
  if (inputPath) return JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8")) as T;
  if (!process.stdin.isTTY) {
    const piped = fs.readFileSync(0, "utf8").trim();
    if (piped) return JSON.parse(piped) as T;
  }
  throw new Error("Input JSON required. Use --input <file>, --input-json '<json>', or pipe JSON via stdin.");
}

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  npx tsx tools/trading/dipbuyer-staged-diagnostics.ts stage1_runner [--timeout-ms <ms>] [--max-chars <n>]",
      "  npx tsx tools/trading/dipbuyer-staged-diagnostics.ts stage2_parser --input <stage1.json> [--timeout-ms <ms>] [--max-chars <n>]",
      "  npx tsx tools/trading/dipbuyer-staged-diagnostics.ts stage3_verifier --input <stage2.json> [--timeout-ms <ms>] [--max-chars <n>]",
      "  npx tsx tools/trading/dipbuyer-staged-diagnostics.ts stage4_reporter --input <stage3.json> [--timeout-ms <ms>]",
      "  npx tsx tools/trading/dipbuyer-staged-diagnostics.ts e2e [--stage1-timeout-ms <ms>] [--stage3-timeout-ms <ms>] [--max-chars <n>]",
    ].join("\n")
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    printUsage();
    process.exit(0);
  }

  if (command === "stage1_runner") {
    const parsed = parseSharedArgs(rest);
    const output = await runStage1Runner({ timeoutMs: parsed.timeoutMs ?? DEFAULT_TIMEOUTS.stage1, maxChars: parsed.maxChars });
    console.log(JSON.stringify(output, null, 2));
    process.exit(output.exitCode);
  }

  if (command === "stage2_parser") {
    const parsed = parseSharedArgs(rest);
    const stage1 = readInputPayload<Stage1Result>(parsed.inputPath, parsed.inputJson);
    const output = await runStage2Parser(stage1, {
      timeoutMs: parsed.timeoutMs ?? DEFAULT_TIMEOUTS.stage2,
      maxChars: parsed.maxChars,
    });
    console.log(JSON.stringify(output, null, 2));
    process.exit(output.exitCode);
  }

  if (command === "stage3_verifier") {
    const parsed = parseSharedArgs(rest);
    const stage2 = readInputPayload<Stage2Result>(parsed.inputPath, parsed.inputJson);
    const output = await runStage3Verifier(stage2, {
      timeoutMs: parsed.timeoutMs ?? DEFAULT_TIMEOUTS.stage3,
      maxChars: parsed.maxChars,
    });
    console.log(JSON.stringify(output, null, 2));
    process.exit(output.exitCode);
  }

  if (command === "stage4_reporter") {
    const parsed = parseSharedArgs(rest);
    const stage3 = readInputPayload<Stage3Result>(parsed.inputPath, parsed.inputJson);
    const output = await runStage4Reporter(stage3, {
      timeoutMs: parsed.timeoutMs ?? DEFAULT_TIMEOUTS.stage4,
    });
    console.log(output.reportTemplate);
    process.exit(output.exitCode);
  }

  if (command === "e2e") {
    const parsed = parseE2EArgs(rest);
    const output = await runDiagnosticsE2E({
      maxChars: parsed.maxChars,
      stageTimeouts: parsed.stageTimeouts,
    });
    console.log(output.stage4.reportTemplate);
    process.exit(output.stage4.exitCode);
  }

  throw new Error(`Unknown command: ${command}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
