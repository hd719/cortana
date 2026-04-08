#!/usr/bin/env npx tsx

import fs from "node:fs";
import path from "node:path";

import { buildTonalProgramCatalog, type TonalProgramCatalog } from "./tonal-program-catalog.js";

const DEFAULT_TONAL_URL = "http://127.0.0.1:3033/tonal/data";
const DEFAULT_OUTPUT_PATH = "/Users/hd/Developer/cortana/memory/fitness/programs/json/current-tonal-catalog.json";

export function persistCurrentTonalCatalog(
  catalog: TonalProgramCatalog,
  outputPath = DEFAULT_OUTPUT_PATH,
): { ok: true; outputPath: string; bytes: number } {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const payload = `${JSON.stringify(catalog, null, 2)}\n`;
  fs.writeFileSync(outputPath, payload, "utf8");
  return {
    ok: true,
    outputPath,
    bytes: Buffer.byteLength(payload, "utf8"),
  };
}

export function buildAndPersistCurrentTonalCatalog(
  tonalPayload: unknown,
  outputPath = DEFAULT_OUTPUT_PATH,
): {
  catalog: TonalProgramCatalog;
  write: { ok: true; outputPath: string; bytes: number };
} {
  const catalog = buildTonalProgramCatalog(tonalPayload);
  const write = persistCurrentTonalCatalog(catalog, outputPath);
  return { catalog, write };
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
  const tonalPayload = await fetchJson(tonalUrl);
  const { catalog, write } = buildAndPersistCurrentTonalCatalog(tonalPayload, outputPath);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    tonal_url: tonalUrl,
    output_path: write.outputPath,
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
