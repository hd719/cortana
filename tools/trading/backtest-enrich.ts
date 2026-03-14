#!/usr/bin/env npx tsx

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runTradingPipeline } from "./trading-pipeline";

const DEFAULT_ROOT = path.join(process.cwd(), "var", "backtests");
const RUNS_DIR = path.join(process.env.BACKTEST_ROOT_DIR || DEFAULT_ROOT, "runs");

type EnrichmentStatus = "success" | "failed";

interface BaseSummary {
  runId: string;
  status: "success" | "failed";
  strategy: string;
  completedAt: string;
  artifacts: { directory: string };
}

interface EnrichmentArtifact {
  schemaVersion: 1;
  runId: string;
  name: string;
  status: EnrichmentStatus;
  generatedAt: string;
  host: string;
  payload?: Record<string, unknown>;
  error?: string;
}

function latestBaseRun(): string | null {
  if (!existsSync(RUNS_DIR)) return null;
  const entries = readDirSafe(RUNS_DIR).filter((dir) => existsSync(path.join(RUNS_DIR, dir, "summary.json")));
  if (!entries.length) return null;
  return entries.sort().pop() || null;
}

function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function loadBaseSummary(runId: string): BaseSummary | null {
  const summaryPath = path.join(RUNS_DIR, runId, "summary.json");
  if (!existsSync(summaryPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(summaryPath, "utf8"));
    return parsed as BaseSummary;
  } catch {
    return null;
  }
}

async function runCouncilEnrichment(runId: string, base: BaseSummary): Promise<EnrichmentArtifact> {
  const generatedAt = new Date().toISOString();
  const name = "council";
  const outDir = path.join(RUNS_DIR, runId, "enrichments");
  mkdirSync(outDir, { recursive: true });
  const tmpPath = path.join(outDir, `${name}.tmp.json`);
  const finalPath = path.join(outDir, `${name}.json`);

  try {
    const report = await runTradingPipeline({ includeCouncil: true });
    const artifact: EnrichmentArtifact = {
      schemaVersion: 1,
      runId,
      name,
      status: "success",
      generatedAt,
      host: os.hostname(),
      payload: { report },
    };
    writeFileSync(tmpPath, JSON.stringify(artifact, null, 2) + "\n");
    renameSync(tmpPath, finalPath);
    return artifact;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const artifact: EnrichmentArtifact = {
      schemaVersion: 1,
      runId,
      name,
      status: "failed",
      generatedAt,
      host: os.hostname(),
      error: message.slice(0, 1000),
    };
    writeFileSync(tmpPath, JSON.stringify(artifact, null, 2) + "\n");
    renameSync(tmpPath, finalPath);
    return artifact;
  }
}

async function main(): Promise<void> {
  const runId = process.env.BACKTEST_RUN_ID || latestBaseRun();
  if (!runId) {
    console.error("No base run found for enrichment");
    process.exit(1);
  }

  const base = loadBaseSummary(runId);
  if (!base) {
    console.error(`Base summary missing for ${runId}`);
    process.exit(1);
  }
  if (base.status !== "success") {
    console.error(`Base run ${runId} not successful; skipping enrichment`);
    return;
  }

  const result = await runCouncilEnrichment(runId, base);
  if (result.status !== "success") {
    console.error(`Enrichment failed for ${runId}: ${result.error || "unknown"}`);
    process.exit(1);
  }
  console.log(`Enrichment complete for ${runId}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
