#!/usr/bin/env npx tsx

import fs from "node:fs";
import path from "node:path";

import { normalizeTonalMovementKey, resolveTonalMovement, type TonalMuscleGroup, type TonalMovementPattern } from "./tonal-movement-map.js";

const TONAL_MOVEMENTS_BASE_URL = "https://tonal.com/blogs/movements";
const DEFAULT_OUTPUT_PATH = "/Users/hd/Developer/cortana/memory/fitness/programs/tonal-public-movement-catalog.json";
const DEFAULT_MARKDOWN_PATH = "/Users/hd/Developer/cortana/memory/fitness/programs/tonal-public-movement-catalog.md";
const OBSERVED_CATALOG_PATH = "/Users/hd/Developer/cortana/memory/fitness/programs/current-tonal-catalog.json";

export type TonalPublicCategory = "upper" | "lower" | "core" | "top_moves" | "unknown";
export type TonalPplBucket = "push" | "pull" | "legs" | "core" | "other";

export type TonalObservedMovement = {
  movementId: string | null;
  canonicalKey: string | null;
  sampleTitle: string | null;
};

export type TonalPublicMovement = {
  title: string;
  normalizedKey: string;
  publicCategory: TonalPublicCategory;
  pplBucket: TonalPplBucket;
  publicPage: number;
  publicUrl: string;
  mapped: boolean;
  movementId: string | null;
  canonicalKey: string | null;
  muscleGroup: TonalMuscleGroup;
  pattern: TonalMovementPattern;
  mappingConfidence: number;
  mappingConfidenceLabel: "high" | "medium" | "low";
  observedOnMachine: boolean;
  metricReady: boolean;
  notes: string[];
};

export type TonalPublicMovementCatalog = {
  schema: "spartan.tonal_public_movement_catalog.v1";
  generatedAt: string;
  source: {
    baseUrl: string;
    pagesScraped: number;
  };
  summary: {
    publicMovementCount: number;
    mappedCount: number;
    observedCount: number;
    metricReadyCount: number;
    pplCounts: Record<TonalPplBucket, number>;
    publicCategoryCounts: Record<TonalPublicCategory, number>;
  };
  movements: TonalPublicMovement[];
};

type ParsedPublicMovement = {
  title: string;
  publicCategory: TonalPublicCategory;
  publicPage: number;
  publicUrl: string;
};

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/");
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function categoryFromLabel(raw: string | null | undefined): TonalPublicCategory {
  const key = normalizeTonalMovementKey(raw ?? "");
  if (key === "upper") return "upper";
  if (key === "lower") return "lower";
  if (key === "core") return "core";
  if (key === "top moves") return "top_moves";
  return "unknown";
}

export function detectMovementLibraryPageCount(html: string): number {
  const matches = [...html.matchAll(/\/blogs\/movements\?page=(\d+)/g)]
    .map((match) => Number.parseInt(match[1] ?? "", 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  return Math.max(1, ...matches);
}

export function parseTonalMovementLibraryPage(html: string, page: number): ParsedPublicMovement[] {
  const results: ParsedPublicMovement[] = [];
  const seen = new Set<string>();
  const cardRegex = /<play-tile\b[\s\S]*?title="([^"]+)"[\s\S]*?<\/play-tile>/g;

  for (const match of html.matchAll(cardRegex)) {
    const title = decodeHtmlEntities(match[1] ?? "").trim();
    if (!title) continue;
    const block = match[0] ?? "";
    const categoryMatch =
      block.match(/aria-label="This exersice movement targets the ([A-Za-z ]+) muscles"/i)
      ?? block.match(/aria-label="This exercise movement targets the ([A-Za-z ]+) muscles"/i);
    const publicCategory = categoryFromLabel(categoryMatch?.[1]);
    const dedupeKey = normalizeTonalMovementKey(title);
    if (!dedupeKey || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    results.push({
      title,
      publicCategory,
      publicPage: page,
      publicUrl: page === 1 ? TONAL_MOVEMENTS_BASE_URL : `${TONAL_MOVEMENTS_BASE_URL}?page=${page}`,
    });
  }

  return results;
}

function inferPplBucketFromTitle(title: string, publicCategory: TonalPublicCategory): TonalPplBucket {
  const key = normalizeTonalMovementKey(title);
  if (publicCategory === "core") return "core";
  if (publicCategory === "lower") return "legs";
  if (/\b(row|pull|pulldown|lat|rear delt|face pull|curl|pullover)\b/.test(key)) return "pull";
  if (/\b(press|fly|raise|tricep|triceps|extension|push)\b/.test(key)) return "push";
  if (/\b(squat|lunge|deadlift|rdl|hinge|glute|hamstring|calf|leg)\b/.test(key)) return "legs";
  return publicCategory === "upper" ? "other" : "other";
}

export function inferTonalPplBucket(input: {
  title: string;
  publicCategory: TonalPublicCategory;
  muscleGroup: TonalMuscleGroup;
  pattern: TonalMovementPattern;
}): TonalPplBucket {
  const { muscleGroup, pattern } = input;
  if (muscleGroup === "core") return "core";
  if (["quads", "hamstrings", "glutes", "calves"].includes(muscleGroup)) return "legs";
  if (
    ["chest", "shoulders", "triceps"].includes(muscleGroup)
    || ["press", "fly", "raise", "extension"].includes(pattern)
  ) return "push";
  if (
    ["back", "lats", "rear_delts", "biceps"].includes(muscleGroup)
    || ["row", "pull_down", "curl"].includes(pattern)
  ) return "pull";
  return inferPplBucketFromTitle(input.title, input.publicCategory);
}

function countBy<T extends string>(values: T[]): Record<T, number> {
  return values.reduce<Record<T, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {} as Record<T, number>);
}

export function loadObservedTonalMovementLookup(catalogPath = OBSERVED_CATALOG_PATH): Map<string, TonalObservedMovement> {
  const lookup = new Map<string, TonalObservedMovement>();
  if (!fs.existsSync(catalogPath)) return lookup;
  try {
    const raw = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as {
      movements?: Array<{ movementId?: string | null; canonicalKey?: string | null; sampleTitle?: string | null }>;
    };
    for (const movement of raw.movements ?? []) {
      if (typeof movement.movementId === "string" && movement.movementId.length > 0) {
        lookup.set(`id:${movement.movementId}`, {
          movementId: movement.movementId,
          canonicalKey: movement.canonicalKey ?? null,
          sampleTitle: movement.sampleTitle ?? null,
        });
      }
      const candidates = [movement.sampleTitle, movement.canonicalKey]
        .map((value) => normalizeTonalMovementKey(String(value ?? "")))
        .filter(Boolean);
      for (const key of candidates) {
        lookup.set(key, {
          movementId: movement.movementId ?? null,
          canonicalKey: movement.canonicalKey ?? null,
          sampleTitle: movement.sampleTitle ?? null,
        });
      }
    }
  } catch {
    return lookup;
  }
  return lookup;
}

export function buildTonalPublicMovementCatalog(input: {
  pages: Array<{ page: number; html: string }>;
  observedLookup?: Map<string, TonalObservedMovement>;
}): TonalPublicMovementCatalog {
  const observedLookup = input.observedLookup ?? new Map<string, TonalObservedMovement>();
  const seen = new Set<string>();
  const parsed = input.pages
    .flatMap(({ page, html }) => parseTonalMovementLibraryPage(html, page))
    .filter((movement) => {
      const normalizedKey = normalizeTonalMovementKey(movement.title);
      if (seen.has(normalizedKey)) return false;
      seen.add(normalizedKey);
      return true;
    });

  const movements: TonalPublicMovement[] = parsed.map((movement) => {
    const normalizedKey = normalizeTonalMovementKey(movement.title);
    const resolution = resolveTonalMovement({ movementTitle: movement.title });
    const observed = observedLookup.get(normalizedKey)
      ?? (resolution.movementId ? observedLookup.get(`id:${resolution.movementId}`) : undefined);
    const pplBucket = inferTonalPplBucket({
      title: movement.title,
      publicCategory: movement.publicCategory,
      muscleGroup: resolution.muscleGroup,
      pattern: resolution.pattern,
    });
    const notes: string[] = [];
    if (movement.publicCategory === "top_moves") notes.push("listed_under_top_moves");
    if (!resolution.mapped) notes.push("no_local_movement_id_mapping");
    if (!observed) notes.push("not_seen_in_local_workout_history");
    return {
      title: movement.title,
      normalizedKey,
      publicCategory: movement.publicCategory,
      pplBucket,
      publicPage: movement.publicPage,
      publicUrl: movement.publicUrl,
      mapped: resolution.mapped,
      movementId: resolution.mapped ? resolution.movementId : (observed?.movementId ?? null),
      canonicalKey: resolution.mapped ? resolution.movementKey : (observed?.canonicalKey ?? null),
      muscleGroup: resolution.muscleGroup,
      pattern: resolution.pattern,
      mappingConfidence: resolution.confidence,
      mappingConfidenceLabel: resolution.confidenceLabel,
      observedOnMachine: Boolean(observed),
      metricReady: Boolean(resolution.mapped || observed),
      notes,
    };
  }).sort((a, b) => a.title.localeCompare(b.title));

  return {
    schema: "spartan.tonal_public_movement_catalog.v1",
    generatedAt: new Date().toISOString(),
    source: {
      baseUrl: TONAL_MOVEMENTS_BASE_URL,
      pagesScraped: input.pages.length,
    },
    summary: {
      publicMovementCount: movements.length,
      mappedCount: movements.filter((movement) => movement.mapped).length,
      observedCount: movements.filter((movement) => movement.observedOnMachine).length,
      metricReadyCount: movements.filter((movement) => movement.metricReady).length,
      pplCounts: {
        push: 0,
        pull: 0,
        legs: 0,
        core: 0,
        other: 0,
        ...countBy(movements.map((movement) => movement.pplBucket)),
      },
      publicCategoryCounts: {
        upper: 0,
        lower: 0,
        core: 0,
        top_moves: 0,
        unknown: 0,
        ...countBy(movements.map((movement) => movement.publicCategory)),
      },
    },
    movements,
  };
}

export function renderTonalPublicMovementCatalogMarkdown(catalog: TonalPublicMovementCatalog): string {
  const lines = [
    "# Tonal Public Movement Catalog",
    "",
    `- Generated: ${catalog.generatedAt}`,
    `- Source: ${catalog.source.baseUrl}`,
    `- Pages scraped: ${catalog.source.pagesScraped}`,
    `- Public movements: ${catalog.summary.publicMovementCount}`,
    `- Mapped locally: ${catalog.summary.mappedCount}`,
    `- Observed on machine: ${catalog.summary.observedCount}`,
    `- Metric-ready: ${catalog.summary.metricReadyCount}`,
    "",
    "## PPL Counts",
    "",
    ...Object.entries(catalog.summary.pplCounts).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Sample Movements",
    "",
    ...catalog.movements.slice(0, 40).map((movement) =>
      `- ${movement.title} | ${movement.publicCategory} | ${movement.pplBucket} | metric_ready=${movement.metricReady}`,
    ),
    "",
  ];
  return `${lines.join("\n").trim()}\n`;
}

async function fetchPage(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; SpartanCatalog/1.0; +https://github.com/hd719/cortana)",
    },
  });
  if (!response.ok) {
    throw new Error(`fetch_failed:${response.status}`);
  }
  return await response.text();
}

export async function fetchTonalPublicMovementCatalogPages(): Promise<Array<{ page: number; html: string }>> {
  const firstHtml = await fetchPage(TONAL_MOVEMENTS_BASE_URL);
  const pageCount = detectMovementLibraryPageCount(firstHtml);
  const pages = [{ page: 1, html: firstHtml }];
  for (let page = 2; page <= pageCount; page += 1) {
    pages.push({
      page,
      html: await fetchPage(`${TONAL_MOVEMENTS_BASE_URL}?page=${page}`),
    });
  }
  return pages;
}

export function persistTonalPublicMovementCatalog(
  catalog: TonalPublicMovementCatalog,
  options?: { jsonPath?: string; markdownPath?: string },
): { jsonPath: string; markdownPath: string } {
  const jsonPath = options?.jsonPath ?? DEFAULT_OUTPUT_PATH;
  const markdownPath = options?.markdownPath ?? DEFAULT_MARKDOWN_PATH;
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, renderTonalPublicMovementCatalogMarkdown(catalog), "utf8");
  return { jsonPath, markdownPath };
}

async function main(): Promise<void> {
  const pages = await fetchTonalPublicMovementCatalogPages();
  const observedLookup = loadObservedTonalMovementLookup();
  const catalog = buildTonalPublicMovementCatalog({ pages, observedLookup });
  const write = persistTonalPublicMovementCatalog(catalog);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    summary: catalog.summary,
    json_path: write.jsonPath,
    markdown_path: write.markdownPath,
  })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
