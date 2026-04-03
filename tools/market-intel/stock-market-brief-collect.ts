#!/usr/bin/env npx tsx

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { getMarketSessionInfo } from "../../skills/markets/check_market_status.ts";

export const DEFAULT_ARTIFACT_PATH = "/tmp/cron-stock-market-brief.json";
export const EXTERNAL_BACKTESTER_DIR = "/Users/hd/Developer/cortana-external/backtester";
export const MARKET_BRIEF_ARTIFACT_FAMILY = "market_brief";
export const MARKET_BRIEF_SCHEMA_VERSION = 1;

export type MarketBriefSnapshot = {
  artifact_family: "market_brief";
  schema_version: 1;
  producer: string;
  generated_at: string;
  known_at: string;
  status: "ok" | "degraded" | "error";
  degraded_status: "healthy" | "degraded_safe" | "degraded_risky";
  outcome_class: string;
  warnings?: string[];
  regime: {
    label: string;
    display: string;
    position_sizing_pct: number;
    distribution_days: number;
    regime_score: number;
    notes: string;
    status: string;
    data_source: string;
    degraded_reason?: string | null;
  };
  posture: { action: string; reason: string };
  macro: {
    state: string;
    conviction?: string;
    summary_line: string;
    theme_titles?: string[];
  };
  tape: {
    summary_line: string;
    risk_tone: string;
    primary_source: string;
    symbols: Array<Record<string, unknown>>;
  };
  focus: {
    symbols: string[];
    sources?: string[];
  };
  freshness?: Record<string, unknown>;
};

export type StockMarketBriefArtifact = {
  artifact_version: 1;
  generated_at: string;
  source: "cortana-external";
  session: { phase: string; label: string; sessionDate: string };
  snapshot: MarketBriefSnapshot;
};

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function assertNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${label} must be a number`);
  }
  return value;
}

function assertStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value as string[];
}

export function parseSnapshotPayload(raw: string): MarketBriefSnapshot {
  const payload = JSON.parse(raw) as Partial<MarketBriefSnapshot>;
  if (!payload || typeof payload !== "object") {
    throw new Error("snapshot payload is not an object");
  }

  if (payload.artifact_family !== MARKET_BRIEF_ARTIFACT_FAMILY) {
    throw new Error(`snapshot payload must be artifact_family=${MARKET_BRIEF_ARTIFACT_FAMILY}`);
  }
  if (payload.schema_version !== MARKET_BRIEF_SCHEMA_VERSION) {
    throw new Error(`snapshot payload must be schema_version=${MARKET_BRIEF_SCHEMA_VERSION}`);
  }

  assertString(payload.producer, "snapshot.producer");
  assertString(payload.generated_at, "snapshot.generated_at");
  assertString(payload.known_at, "snapshot.known_at");

  const status = assertString(payload.status, "snapshot.status");
  if (!["ok", "degraded", "error"].includes(status)) {
    throw new Error(`snapshot.status unsupported: ${status}`);
  }
  const degradedStatus = assertString(payload.degraded_status, "snapshot.degraded_status");
  if (!["healthy", "degraded_safe", "degraded_risky"].includes(degradedStatus)) {
    throw new Error(`snapshot.degraded_status unsupported: ${degradedStatus}`);
  }
  assertString(payload.outcome_class, "snapshot.outcome_class");

  const regime = assertObject(payload.regime, "snapshot.regime");
  assertString(regime.label, "snapshot.regime.label");
  assertString(regime.display, "snapshot.regime.display");
  assertNumber(regime.position_sizing_pct, "snapshot.regime.position_sizing_pct");
  assertNumber(regime.distribution_days, "snapshot.regime.distribution_days");
  assertNumber(regime.regime_score, "snapshot.regime.regime_score");
  assertString(regime.notes, "snapshot.regime.notes");
  assertString(regime.status, "snapshot.regime.status");
  assertString(regime.data_source, "snapshot.regime.data_source");

  const posture = assertObject(payload.posture, "snapshot.posture");
  assertString(posture.action, "snapshot.posture.action");
  assertString(posture.reason, "snapshot.posture.reason");

  const macro = assertObject(payload.macro, "snapshot.macro");
  assertString(macro.state, "snapshot.macro.state");
  assertString(macro.summary_line, "snapshot.macro.summary_line");

  const tape = assertObject(payload.tape, "snapshot.tape");
  assertString(tape.summary_line, "snapshot.tape.summary_line");
  assertString(tape.risk_tone, "snapshot.tape.risk_tone");
  assertString(tape.primary_source, "snapshot.tape.primary_source");
  if (!Array.isArray(tape.symbols)) {
    throw new Error("snapshot.tape.symbols must be an array");
  }

  const focus = assertObject(payload.focus, "snapshot.focus");
  assertStringArray(focus.symbols, "snapshot.focus.symbols");

  if (payload.warnings != null) {
    assertStringArray(payload.warnings, "snapshot.warnings");
  }
  if (payload.session != null) {
    const session = assertObject(payload.session, "snapshot.session");
    assertString(session.phase, "snapshot.session.phase");
    assertBoolean(session.is_regular_hours, "snapshot.session.is_regular_hours");
  }

  return payload as MarketBriefSnapshot;
}

export function buildArtifact(snapshot: MarketBriefSnapshot, now = new Date()): StockMarketBriefArtifact {
  return {
    artifact_version: 1,
    generated_at: now.toISOString(),
    source: "cortana-external",
    session: getMarketSessionInfo(now),
    snapshot,
  };
}

export function collectExternalSnapshot(): MarketBriefSnapshot {
  const result = spawnSync("uv", ["run", "python", "market_brief_snapshot.py"], {
    cwd: EXTERNAL_BACKTESTER_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error((result.stderr || result.stdout || "market brief snapshot failed").trim());
  }
  return parseSnapshotPayload((result.stdout || "").trim());
}

export function writeArtifact(payload: StockMarketBriefArtifact, artifactPath = DEFAULT_ARTIFACT_PATH): void {
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function main(): void {
  const snapshot = collectExternalSnapshot();
  const artifact = buildArtifact(snapshot);
  writeArtifact(artifact);
  process.stdout.write(`${JSON.stringify({ ok: true, path: DEFAULT_ARTIFACT_PATH, generated_at: artifact.generated_at })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
