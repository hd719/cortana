#!/usr/bin/env -S npx tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAutonomyOpsSummary, type AutonomyOpsSummary } from "./autonomy-ops.ts";

export const AUTONOMY_OPS_ARTIFACT_SCHEMA_VERSION = "autonomy-ops.v1";

export type AutonomyOperatorState = "live" | "watch" | "attention";
export type AutonomySourceStatus = "fresh" | "stale" | "missing";
export type AutonomySourceConfidence = "high" | "medium" | "low";

export type AutonomyOpsSource = {
  key: string;
  label: string;
  required: boolean;
  status: AutonomySourceStatus;
  confidence: AutonomySourceConfidence;
  generatedAt: string | null;
  freshUntil: string | null;
  detail: string | null;
};

export type AutonomyOpsArtifact = {
  schemaVersion: typeof AUTONOMY_OPS_ARTIFACT_SCHEMA_VERSION;
  generatedAt: string;
  freshUntil: string;
  operatorState: AutonomyOperatorState;
  posture: string;
  stale: boolean;
  counts: AutonomyOpsSummary["counts"];
  sections: {
    autoFixed: string[];
    degraded: string[];
    waitingOnHamel: string[];
    blockers: string[];
    familyCritical: AutonomyOpsSummary["familyCritical"];
    scorecard: AutonomyOpsSummary["scorecard"];
  };
  sources: AutonomyOpsSource[];
};

type ArtifactBuildOptions = {
  nowMs?: number;
  artifactFreshnessMs?: number;
  sourceFreshness?: AutonomyOpsSource[];
};

type WriteOptions = ArtifactBuildOptions & {
  outputPath?: string;
  summary?: AutonomyOpsSummary;
};

const DEFAULT_ARTIFACT_FRESHNESS_MS = 10 * 60 * 1000;

function defaultOutputPath(): string {
  const runtimeHome = process.env.CORTANA_RUNTIME_HOME ?? os.homedir();
  return path.join(runtimeHome, ".openclaw", "reports", "autonomy-ops", "latest.json");
}

export function buildAutonomyOpsArtifact(
  summary: AutonomyOpsSummary,
  options: ArtifactBuildOptions = {},
): AutonomyOpsArtifact {
  const nowMs = options.nowMs ?? Date.now();
  const artifactFreshnessMs = options.artifactFreshnessMs ?? DEFAULT_ARTIFACT_FRESHNESS_MS;
  const generatedAt = new Date(nowMs).toISOString();
  const freshUntil = new Date(nowMs + artifactFreshnessMs).toISOString();
  const sources = options.sourceFreshness ?? defaultSources(nowMs, artifactFreshnessMs);
  const staleSources = sources.filter((source) => source.status !== "fresh");

  return {
    schemaVersion: AUTONOMY_OPS_ARTIFACT_SCHEMA_VERSION,
    generatedAt,
    freshUntil,
    operatorState: deriveOperatorState(summary.operatorState as AutonomyOperatorState, sources),
    posture: String(summary.posture),
    stale: staleSources.length > 0,
    counts: summary.counts,
    sections: {
      autoFixed: [...summary.autoFixed],
      degraded: [...summary.degraded],
      waitingOnHamel: [...summary.waitingOnHamel],
      blockers: [...summary.blocked],
      familyCritical: summary.familyCritical,
      scorecard: summary.scorecard,
    },
    sources,
  };
}

export function writeAutonomyOpsArtifact(options: WriteOptions = {}): AutonomyOpsArtifact {
  const artifact = buildAutonomyOpsArtifact(
    options.summary ?? buildAutonomyOpsSummary(),
    options,
  );
  writeJsonAtomic(options.outputPath ?? defaultOutputPath(), artifact);
  return artifact;
}

function defaultSources(nowMs: number, freshnessMs: number): AutonomyOpsSource[] {
  const generatedAt = new Date(nowMs).toISOString();
  const freshUntil = new Date(nowMs + freshnessMs).toISOString();
  return [
    {
      key: "autonomy_status",
      label: "Autonomy status",
      required: true,
      status: "fresh",
      confidence: "high",
      generatedAt,
      freshUntil,
      detail: null,
    },
    {
      key: "autonomy_rollout",
      label: "Autonomy rollout",
      required: true,
      status: "fresh",
      confidence: "high",
      generatedAt,
      freshUntil,
      detail: null,
    },
    {
      key: "autonomy_drill",
      label: "Autonomy drill",
      required: true,
      status: "fresh",
      confidence: "high",
      generatedAt,
      freshUntil,
      detail: null,
    },
  ];
}

function deriveOperatorState(
  summaryState: AutonomyOperatorState,
  sources: AutonomyOpsSource[],
): AutonomyOperatorState {
  if (summaryState === "attention") return "attention";
  const required = sources.filter((source) => source.required);
  if (required.some((source) => source.status === "missing")) return "attention";
  if (summaryState === "watch" || required.some((source) => source.status === "stale")) return "watch";
  return "live";
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function parseArgs(argv: string[]): { outputPath?: string; json: boolean } {
  const args: { outputPath?: string; json: boolean } = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--output" && argv[i + 1]) args.outputPath = path.resolve(argv[++i]);
    else if (arg === "-h" || arg === "--help") {
      console.log("Usage: npx tsx tools/monitoring/write-autonomy-ops-artifact.ts [--json] [--output <path>]");
      process.exit(0);
    }
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const artifact = writeAutonomyOpsArtifact({ outputPath: args.outputPath });
  if (args.json) console.log(JSON.stringify(artifact, null, 2));
  else console.log("NO_REPLY");
}
