#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { resolveRepoPath } from "../lib/paths.js";
import { readJsonFile, writeJsonFileAtomic } from "../lib/json-file.js";

const WORKSPACE = resolveRepoPath();
const STATE_PATH = path.join(WORKSPACE, "memory", "vector-memory-health-state.json");

type JsonValue = any;

function loadState(): Record<string, any> {
  const data = readJsonFile<Record<string, any>>(STATE_PATH);
  return data ?? {};
}

function saveState(state: Record<string, any>): void {
  writeJsonFileAtomic(STATE_PATH, state, 2);
}

function parseJson(raw: string): JsonValue | null {
  const text = raw.trim();
  if (!text) return null;
  const m = text.search(/[\[{]/);
  const payload = m >= 0 ? text.slice(m) : text;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function vectorSearch(query: string, maxResults: number): [Array<Record<string, any>> | null, string] {
  const proc = spawnSync("openclaw", ["memory", "search", query, "--json", "--max-results", String(maxResults)], {
    encoding: "utf8",
    timeout: 90000,
  });
  const combined = `${proc.stdout || ""}\n${proc.stderr || ""}`.trim();
  const payload = parseJson(proc.stdout || "");
  let items: Array<Record<string, any>> = [];
  if (Array.isArray(payload)) {
    items = payload.filter((x) => x && typeof x === "object");
  } else if (payload && typeof payload === "object") {
    for (const key of ["results", "items", "matches", "data"]) {
      const val = (payload as any)[key];
      if (Array.isArray(val)) {
        items = val.filter((x) => x && typeof x === "object");
        break;
      }
    }
  }

  const textLower = combined.toLowerCase();
  const quotaError =
    /(resource_exhausted|embedd\w*[^\n]{0,80}429|429[^\n]{0,80}embedd\w*)/.test(textLower) &&
    (textLower.includes("failed") || textLower.includes("error") || textLower.includes("quota"));

  if (proc.status !== 0 || quotaError) {
    return [null, combined];
  }
  return [items, combined];
}

function collectFiles(workspace: string): string[] {
  const files: string[] = [];
  const root = path.join(workspace, "MEMORY.md");
  if (fs.existsSync(root)) files.push(root);
  const memDir = path.join(workspace, "memory");
  if (fs.existsSync(memDir)) {
    for (const p of fs.readdirSync(memDir).sort()) {
      if (p.endsWith(".md")) files.push(path.join(memDir, p));
    }
  }
  return files;
}

function scoreLine(queryTerms: string[], line: string): number {
  const l = line.toLowerCase();
  let score = 0;
  for (const t of queryTerms) {
    if (l.includes(t)) score += 2;
  }
  if (queryTerms.length >= 2 && queryTerms.slice(0, 2).every((t) => l.includes(t))) {
    score += 1;
  }
  return score;
}

function keywordFallback(query: string, maxResults: number): Array<Record<string, any>> {
  let terms = (query.toLowerCase().match(/[a-zA-Z0-9_]+/g) ?? []).filter((t) => t.length >= 3);
  if (!terms.length) terms = [query.toLowerCase()];

  const hits: Array<Record<string, any>> = [];
  for (const p of collectFiles(WORKSPACE)) {
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
    } catch {
      continue;
    }
    const rel = path.relative(WORKSPACE, p);
    lines.forEach((line, idx) => {
      const s = scoreLine(terms, line);
      if (s <= 0) return;
      let snippet = line.trim();
      if (snippet.length > 420) snippet = `${snippet.slice(0, 417)}...`;
      hits.push({
        source: rel,
        line: idx + 1,
        snippet,
        score: Number(s),
        mode: "keyword_fallback",
      });
    });
  }

  hits.sort((a, b) => Number(b.score) - Number(a.score));
  return hits.slice(0, maxResults);
}

function printHelp(): void {
  const text = `usage: safe-memory-search.ts [-h] [--max-results MAX_RESULTS] [--json] query\n\nSafe memory search with fallback\n\npositional arguments:\n  query\n\noptions:\n  -h, --help            show this help message and exit\n  --max-results MAX_RESULTS\n  --json`;
  console.log(text);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help") || argv.length === 0) {
    printHelp();
    if (argv.length === 0) process.exit(2);
    return;
  }

  let maxResults = 5;
  let jsonFlag = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--max-results" && next) {
      maxResults = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--json") {
      jsonFlag = true;
    } else if (arg.startsWith("-")) {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(2);
    } else {
      positional.push(arg);
    }
  }

  const query = positional.join(" ").trim();
  if (!query) {
    console.error("query is required");
    process.exit(2);
  }

  const state = loadState();
  const forceFallback = Boolean(state.fallback_mode);

  let items: Array<Record<string, any>> = [];
  let mode = "vector";
  let errorText = "";

  if (!forceFallback) {
    const [vectorItems, err] = vectorSearch(query, maxResults);
    errorText = err;
    if (vectorItems !== null) {
      items = vectorItems;
    } else {
      mode = "keyword_fallback";
      items = keywordFallback(query, maxResults);
    }
  } else {
    mode = "keyword_fallback";
    items = keywordFallback(query, maxResults);
  }

  if (mode === "keyword_fallback") {
    state.fallback_mode = true;
    state.last_fallback_reason = errorText.slice(0, 500);
    saveState(state);
  }

  const output = { mode, query, results: items };
  if (jsonFlag) {
    console.log(JSON.stringify(output));
  } else {
    console.log(JSON.stringify(output, null, 2));
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
