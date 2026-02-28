#!/usr/bin/env npx tsx

import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { resolveRepoPath } from "../lib/paths.js";

const WORKSPACE = resolveRepoPath();
const DB_PATH_DEFAULT = path.join(os.homedir(), ".openclaw", "memory", "lancedb");
const CONFIG_DEFAULT = path.join(os.homedir(), ".openclaw", "openclaw.json");
const TABLE_NAME = "memories";
const EMBED_MODEL = "text-embedding-3-small";

type Chunk = {
  chunk_id: string;
  file_rel: string;
  header: string;
  body: string;
  content_hash: string;
};

class ConfigError extends Error {}

function loadOpenaiKey(configPath: string): string {
  const raw = fs.readFileSync(configPath, "utf8");
  const cfg = JSON.parse(raw) as any;
  const key = cfg?.plugins?.entries?.["memory-lancedb"]?.config?.embedding?.apiKey;
  if (!key) {
    throw new ConfigError(
      "OpenAI API key not found in openclaw.json at plugins.entries.memory-lancedb.config.embedding.apiKey"
    );
  }
  return String(key);
}

async function httpPostJson(url: string, payload: Record<string, any>, apiKey: string): Promise<Record<string, any>> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return (await res.json()) as Record<string, any>;
}

async function embedTexts(apiKey: string, texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const out = await httpPostJson(
    "https://api.openai.com/v1/embeddings",
    { model: EMBED_MODEL, input: texts },
    apiKey
  );
  return (out.data ?? []).map((row: any) => row.embedding as number[]);
}

async function requireLanceDb(): Promise<any> {
  try {
    const mod: any = await import("lancedb");
    return mod?.default ?? mod;
  } catch (err) {
    throw new Error("Missing dependency: lancedb. Install with: python3 -m pip install lancedb");
  }
}

async function openOrCreateTable(dbPath: string, vectorDim: number): Promise<any> {
  const lancedb = await requireLanceDb();
  const db = await lancedb.connect(dbPath);
  const names = new Set(await db.tableNames());
  if (names.has(TABLE_NAME)) return db.openTable(TABLE_NAME);

  const seed = [
    {
      id: "__schema__",
      text: "",
      vector: Array(vectorDim).fill(0.0),
      importance: 0.0,
      category: "other",
      createdAt: 0,
      source: "markdown_sync",
      sourceType: "markdown_sync",
      contentHash: "",
    },
  ];
  const t = await db.createTable(TABLE_NAME, seed);
  await t.delete('id = "__schema__"');
  return t;
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function discoverFiles(workspace: string): string[] {
  const files: string[] = [];
  const memoryMd = path.join(workspace, "MEMORY.md");
  if (fs.existsSync(memoryMd)) files.push(memoryMd);
  const memDir = path.join(workspace, "memory");
  if (fs.existsSync(memDir)) {
    const entries = fs.readdirSync(memDir).filter((f) => f.endsWith(".md"));
    for (const f of entries.sort()) files.push(path.join(memDir, f));
  }
  return files;
}

function parseMarkdownChunks(filePath: string, workspace: string): Chunk[] {
  const text = fs.readFileSync(filePath, "utf8");
  const rel = path.relative(workspace, filePath);
  const regex = /^##\s+(.+?)\s*$/gm;
  const matches = Array.from(text.matchAll(regex));
  const chunks: Chunk[] = [];

  if (!matches.length) {
    const header = "__document__";
    const body = text.trim();
    if (body) {
      const cid = sha256Text(`${rel}|${header}`);
      const chash = sha256Text(body);
      chunks.push({ chunk_id: cid, file_rel: rel, header, body, content_hash: chash });
    }
    return chunks;
  }

  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i];
    const header = (m[1] ?? "").trim();
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index ?? text.length : text.length;
    const body = text.slice(start, end).trim();
    if (!body) continue;
    const cid = sha256Text(`${rel}|${header}`);
    const chash = sha256Text(body);
    chunks.push({ chunk_id: cid, file_rel: rel, header, body, content_hash: chash });
  }
  return chunks;
}

async function loadExistingMarkdownRows(table: any): Promise<Record<string, Record<string, any>>> {
  const queries = [
    () => table.search().where("sourceType = 'markdown_sync'").limit(100000).toArray(),
    () => table.search().where("source = 'markdown_sync'").limit(100000).toArray(),
  ];
  for (const q of queries) {
    try {
      const rows = await q();
      const out: Record<string, Record<string, any>> = {};
      for (const r of rows) {
        const rid = String(r.id ?? "");
        if (rid) out[rid] = r;
      }
      return out;
    } catch {
      continue;
    }
  }
  return {};
}

async function deleteIds(table: any, ids: string[]): Promise<number> {
  let deleted = 0;
  for (const rid of ids) {
    const safe = rid.replace(/'/g, "");
    await table.delete(`id = '${safe}'`);
    deleted += 1;
  }
  return deleted;
}

async function upsertRows(table: any, rows: Record<string, any>[]): Promise<void> {
  if (!rows.length) return;
  await table.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows);
}

function buildEmbeddingInput(chunk: Chunk): string {
  return `Source: ${chunk.file_rel}\nSection: ${chunk.header}\n\n${chunk.body}`;
}

function printHelp(): void {
  const text = `usage: markdown-sync.ts [-h] [--workspace WORKSPACE] [--db-path DB_PATH] [--config CONFIG]\n\noptions:\n  -h, --help            show this help message and exit\n  --workspace WORKSPACE\n  --db-path DB_PATH\n  --config CONFIG`;
  console.log(text);
}

function parseArgs(argv: string[]): { workspace: string; dbPath: string; config: string } {
  const args = { workspace: WORKSPACE, dbPath: DB_PATH_DEFAULT, config: CONFIG_DEFAULT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else if (arg === "--workspace" && next) {
      args.workspace = next;
      i += 1;
    } else if (arg === "--db-path" && next) {
      args.dbPath = next;
      i += 1;
    } else if (arg === "--config" && next) {
      args.config = next;
      i += 1;
    } else if (arg.startsWith("-")) {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workspace = args.workspace;
  const files = discoverFiles(workspace);

  const chunks: Chunk[] = [];
  for (const p of files) {
    chunks.push(...parseMarkdownChunks(p, workspace));
  }

  const apiKey = loadOpenaiKey(args.config);

  if (!chunks.length) {
    console.log("Synced 0 chunks from 0 files. Added 0, updated 0, deleted 0.");
    return;
  }

  const vectors = await embedTexts(apiKey, chunks.map((c) => buildEmbeddingInput(c)));
  const table = await openOrCreateTable(args.dbPath, vectors[0].length);

  const existing = await loadExistingMarkdownRows(table);
  const currentIds = new Set(chunks.map((c) => c.chunk_id));
  const staleIds = Object.keys(existing).filter((rid) => !currentIds.has(rid));

  const nowMs = Date.now();
  let addCount = 0;
  let updateCount = 0;

  const upserts: Record<string, any>[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const c = chunks[i];
    const v = vectors[i];
    const prev = existing[c.chunk_id];
    const isNew = !prev;
    let changed = true;
    if (prev) {
      const prevHash = String(prev.contentHash ?? "");
      changed = prevHash !== c.content_hash;
    }

    if (isNew) addCount += 1;
    else if (changed) updateCount += 1;

    if (isNew || changed) {
      upserts.push({
        id: c.chunk_id,
        text: buildEmbeddingInput(c),
        vector: Array.from(v),
        importance: 0.7,
        category: "fact",
        createdAt: prev ? Number(prev.createdAt ?? nowMs) : nowMs,
        updatedAt: nowMs,
        source: "markdown_sync",
        sourceType: "markdown_sync",
        sourceFile: c.file_rel,
        sourceHeader: c.header,
        contentHash: c.content_hash,
      });
    }
  }

  await upsertRows(table, upserts);
  const deleted = await deleteIds(table, staleIds);

  console.log(
    `Synced ${chunks.length} chunks from ${files.length} files. Added ${addCount}, updated ${updateCount}, deleted ${deleted}.`
  );
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
