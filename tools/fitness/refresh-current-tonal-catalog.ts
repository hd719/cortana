#!/usr/bin/env npx tsx

import fs from "node:fs";
import path from "node:path";

import { buildTonalProgramCatalog, type TonalProgramCatalog } from "./tonal-program-catalog.js";

const DEFAULT_TONAL_URL = "http://127.0.0.1:3033/tonal/data";
const DEFAULT_OUTPUT_PATH = "/Users/hd/Developer/cortana/memory/fitness/programs/json/current-tonal-catalog.json";
const DEFAULT_MARKDOWN_PATH = "/Users/hd/Developer/cortana/memory/fitness/programs/md/current-tonal-catalog.md";

export function persistCurrentTonalCatalog(
  catalog: TonalProgramCatalog,
  options?: { outputPath?: string; markdownPath?: string },
): { ok: true; outputPath: string; markdownPath: string; bytes: number } {
  const outputPath = options?.outputPath ?? DEFAULT_OUTPUT_PATH;
  const markdownPath = options?.markdownPath ?? DEFAULT_MARKDOWN_PATH;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  const payload = `${JSON.stringify(catalog, null, 2)}\n`;
  const markdown = renderCurrentTonalCatalogMarkdown(catalog);
  fs.writeFileSync(outputPath, payload, "utf8");
  fs.writeFileSync(markdownPath, markdown, "utf8");
  return {
    ok: true,
    outputPath,
    markdownPath,
    bytes: Buffer.byteLength(payload, "utf8"),
  };
}

export function buildAndPersistCurrentTonalCatalog(
  tonalPayload: unknown,
  options?: { outputPath?: string; markdownPath?: string },
): {
  catalog: TonalProgramCatalog;
  write: { ok: true; outputPath: string; markdownPath: string; bytes: number };
} {
  const catalog = buildTonalProgramCatalog(tonalPayload);
  const write = persistCurrentTonalCatalog(catalog, options);
  return { catalog, write };
}

export function renderCurrentTonalCatalogMarkdown(catalog: TonalProgramCatalog): string {
  const lines = [
    "# Current Tonal Catalog",
    "",
    `- Generated: ${catalog.generatedAt}`,
    `- User ID: ${catalog.userId ?? "unknown"}`,
    `- Workouts seen: ${catalog.summary.workoutsSeen}`,
    `- Movements seen: ${catalog.summary.movementsSeen}`,
    `- Mapped movement %: ${catalog.summary.mappedMovementPct}`,
    `- Strength scores present: ${catalog.summary.strengthScoresPresent}`,
    `- Latest workout at: ${catalog.summary.latestWorkoutAt ?? "unknown"}`,
    "",
    "## Top Movements",
    "",
    ...catalog.movements.slice(0, 20).map((movement) =>
      `- ${movement.sampleTitle ?? movement.canonicalKey}: ${movement.setCount} sets | ${movement.muscleGroup} | ${movement.pattern} | mapped=${movement.mapped}`,
    ),
    "",
    "## Recent Workouts",
    "",
    ...catalog.recentWorkouts.slice(0, 10).map((workout) =>
      `- ${workout.beginTime ?? "unknown"} | focus=${workout.focus} | volume=${workout.totalVolume ?? "unknown"} | mapped=${workout.mappedMovementPct}%`,
    ),
    "",
  ];
  return `${lines.join("\n").trim()}\n`;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; SpartanCurrentTonalCatalog/1.0; +https://github.com/hd719/cortana)",
    },
  });
  if (!response.ok) {
    throw new Error(`fetch_failed:${response.status}`);
  }
  return await response.json();
}

async function main(): Promise<void> {
  const tonalUrl = process.env.TONAL_URL ?? DEFAULT_TONAL_URL;
  const outputPath = process.env.TONAL_CURRENT_CATALOG_PATH ?? DEFAULT_OUTPUT_PATH;
  const markdownPath = process.env.TONAL_CURRENT_CATALOG_MARKDOWN_PATH ?? DEFAULT_MARKDOWN_PATH;
  const tonalPayload = await fetchJson(tonalUrl);
  const { catalog, write } = buildAndPersistCurrentTonalCatalog(tonalPayload, { outputPath, markdownPath });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    tonal_url: tonalUrl,
    output_path: write.outputPath,
    markdown_path: write.markdownPath,
    bytes: write.bytes,
    summary: catalog.summary,
  })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
