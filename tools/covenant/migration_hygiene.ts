#!/usr/bin/env npx tsx

/** Migration hygiene checker for /Users/hd/openclaw/migrations. */

import fs from "fs";
import path from "path";
import { resolveRepoPath } from "../lib/paths.js";

const WORKSPACE_ROOT = resolveRepoPath();
const MIGRATIONS_DIR = path.join(WORKSPACE_ROOT, "migrations");
const MANIFEST_PATH = path.join(MIGRATIONS_DIR, "manifest.json");
const MIGRATION_RE = /^(\d{3})_([a-z0-9_]+)\.sql$/;

class HygieneError extends Error {}

type Report = {
  status: string;
  migration_count: number;
  max_prefix: number;
  duplicate_prefixes: string[];
  legacy_duplicate_prefixes: string[];
  problems: string[];
};

function listSqlFiles(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function loadManifest(): Record<string, any> {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new HygieneError(`Manifest missing: ${MANIFEST_PATH}`);
  }
  try {
    const data = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new HygieneError("Manifest must be a JSON object");
    }
    return data as Record<string, any>;
  } catch (err) {
    if (err instanceof HygieneError) throw err;
    throw new HygieneError(`Invalid manifest JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) {
    throw new HygieneError("Manifest `order` must be an array of filenames");
  }
  return [...value];
}

function parsePrefix(name: string): string | null {
  const m = MIGRATION_RE.exec(name);
  return m ? m[1] : null;
}

function checkMigrations(): Report {
  const files = listSqlFiles();
  const manifest = loadManifest();
  const order = normalizeList(manifest.order);
  const legacyDupAllowed = new Set<string>(manifest.legacy_duplicate_prefixes ?? []);

  const fileSet = new Set(files);
  const orderSet = new Set(order);

  const missingFromManifest = [...fileSet].filter((f) => !orderSet.has(f)).sort();
  const missingFromDisk = [...orderSet].filter((f) => !fileSet.has(f)).sort();

  const prefixes = files.map((f) => parsePrefix(f));
  const invalidNames = files.filter((_, idx) => prefixes[idx] === null);

  const dupCounts: Record<string, number> = {};
  prefixes.forEach((p) => {
    if (p == null) return;
    dupCounts[p] = (dupCounts[p] ?? 0) + 1;
  });
  const duplicatePrefixes = Object.keys(dupCounts)
    .filter((p) => dupCounts[p] > 1)
    .sort();

  const unexpectedDuplicates = duplicatePrefixes.filter((p) => !legacyDupAllowed.has(p)).sort();

  const maxPrefix = Math.max(0, ...Object.keys(dupCounts).map((p) => Number(p)));

  const problems: string[] = [];
  if (missingFromManifest.length) {
    problems.push(`Files missing from manifest: ${missingFromManifest.join(", ")}`);
  }
  if (missingFromDisk.length) {
    problems.push(`Manifest references missing files: ${missingFromDisk.join(", ")}`);
  }
  if (invalidNames.length) {
    problems.push(`Invalid filename format: ${invalidNames.join(", ")}`);
  }
  if (unexpectedDuplicates.length) {
    problems.push(
      "Unexpected duplicate prefixes (must be unique unless explicitly grandfathered): " +
        unexpectedDuplicates.join(", ")
    );
  }

  const status = problems.length ? "error" : "ok";
  return {
    status,
    migration_count: files.length,
    max_prefix: Number.isFinite(maxPrefix) ? maxPrefix : 0,
    duplicate_prefixes: duplicatePrefixes,
    legacy_duplicate_prefixes: Array.from(legacyDupAllowed).sort(),
    problems,
  };
}

function suggestNextPrefix(): number {
  const report = checkMigrations();
  return Number(report.max_prefix) + 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const wantsJson = args.includes("--json");
  const wantsNext = args.includes("--next-prefix");

  try {
    if (wantsNext) {
      const next = suggestNextPrefix();
      console.log(String(next).padStart(3, "0"));
      process.exit(0);
    }

    const report = checkMigrations();
    if (wantsJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`status: ${report.status}`);
      console.log(`migration_count: ${report.migration_count}`);
      console.log(`max_prefix: ${String(report.max_prefix).padStart(3, "0")}`);
      console.log(`duplicate_prefixes: ${report.duplicate_prefixes.join(", ") || "none"}`);
      if (report.problems.length) {
        console.log("problems:");
        report.problems.forEach((p) => console.log(`- ${p}`));
      } else {
        console.log("problems: none");
      }
    }
    process.exit(report.status === "ok" ? 0 : 1);
  } catch (err) {
    if (err instanceof HygieneError) {
      if (wantsJson) {
        console.log(JSON.stringify({ status: "error", problems: [err.message] }, null, 2));
      } else {
        console.error(`error: ${err.message}`);
      }
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
