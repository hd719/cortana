#!/usr/bin/env npx tsx

import * as fs from "node:fs";
import * as path from "node:path";
import lancedb from "lancedb";
import { compatRepoRoot, resolveRepoPath, resolveRuntimeStatePath } from "../lib/paths.js";

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  return argv[i + 1];
}

function safeExistsSync(candidate: string): boolean {
  let fn: ((p: string) => boolean) | undefined;
  try {
    fn = (fs as typeof import("node:fs") & { default?: { existsSync?: (p: string) => boolean } }).existsSync;
  } catch {
    fn = undefined;
  }
  if (typeof fn !== "function") {
    try {
      fn = (fs as { default?: { existsSync?: (p: string) => boolean } }).default?.existsSync;
    } catch {
      fn = undefined;
    }
  }
  if (typeof fn !== "function") return true;
  return fn(candidate);
}

function firstExistingPath(candidates: string[]): string {
  for (const candidate of candidates) {
    if (safeExistsSync(candidate)) return candidate;
  }
  throw new Error(`missing required file/path; tried:\n- ${candidates.join("\n- ")}`);
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help")) {
    console.log("usage: decay-scorer.ts --query <text> [--top-k N] [--candidate-k N]");
    return 0;
  }

  const query = arg("--query", argv);
  if (!query) {
    console.error("--query is required");
    return 2;
  }

  const topK = Number(arg("--top-k", argv) ?? "5");
  const candidateK = Number(arg("--candidate-k", argv) ?? String(Math.max(topK * 2, 10)));

  const configPath = firstExistingPath([
    process.env.OPENMEMORY_CONFIG_PATH ?? "",
    resolveRuntimeStatePath("config", "openmemory.json"),
    resolveRepoPath("config", "openmemory.json"),
    path.join(compatRepoRoot(), "config", "openmemory.json"),
  ].filter(Boolean));
  const dbPath = firstExistingPath([
    process.env.OPENMEMORY_LANCEDB_PATH ?? "",
    resolveRuntimeStatePath("memory", "lancedb"),
    path.join(compatRepoRoot(), ".memory", "lancedb"),
  ].filter(Boolean));

  const cfgRaw = fs.readFileSync(configPath, "utf8");
  const cfg = JSON.parse(cfgRaw || "{}");
  const apiKey = cfg?.plugins?.entries?.["memory-lancedb"]?.config?.embedding?.apiKey;

  const embRes = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey ?? ""}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: query }),
  });
  if (!embRes.ok) throw new Error("embedding request failed");
  const embJson: any = await embRes.json();
  const embedding = embJson?.data?.[0]?.embedding;

  const db = await lancedb.connect(dbPath);
  const table = await db.openTable("memory");
  const rows: any[] = await table.vectorSearch(embedding).limit(candidateK).toArray();

  const now = Date.now();
  const scored = rows.map((r) => {
    const ageDays = Math.max(0, (now - Number(r.createdAt ?? now)) / 86400000);
    const decay = Math.exp(-ageDays / 180);
    const similarity = 1 - Number(r._distance ?? 1);
    const score = similarity * 0.85 + decay * 0.15;
    return { ...r, score };
  });

  scored.sort((a, b) => b.score - a.score);
  console.log(JSON.stringify({ results: scored.slice(0, topK) }));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
}
