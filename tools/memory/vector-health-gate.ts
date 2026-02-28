#!/usr/bin/env npx tsx

import { spawnSync } from "child_process";
import path from "path";
import { resolveRepoPath } from "../lib/paths.js";
import { readJsonFile, writeJsonFileAtomic } from "../lib/json-file.js";
import { query } from "../lib/db.js";

const WORKSPACE = resolveRepoPath();
const STATE_PATH = path.join(WORKSPACE, "memory", "vector-memory-health-state.json");

function nowIso(): string {
  return new Date().toISOString();
}

function loadState(): Record<string, any> {
  const data = readJsonFile<Record<string, any>>(STATE_PATH);
  return (
    data ?? {
      consecutive_embedding_429: 0,
      fallback_mode: false,
      reindex_queued: false,
    }
  );
}

function saveState(state: Record<string, any>): void {
  writeJsonFileAtomic(STATE_PATH, state, 2);
}

function parseJson(raw: string): any | null {
  const text = raw.trim();
  if (!text) return null;
  const idx = text.search(/[\[{]/);
  const payload = idx >= 0 ? text.slice(idx) : text;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function getMemoryStatus(): [number, number, Record<string, any>] {
  const proc = spawnSync("openclaw", ["memory", "status", "--json"], { encoding: "utf8" });
  const payload = parseJson(proc.stdout || "");
  if (!Array.isArray(payload) || payload.length === 0) {
    return [0, 0, { raw: (proc.stdout || "") + (proc.stderr || "") }];
  }
  const status = (payload[0] && typeof payload[0] === "object" ? payload[0].status : {}) ?? {};
  const files = Number(status.files ?? 0);
  const chunks = Number(status.chunks ?? 0);
  return [files, chunks, status];
}

function isEmbedding429(text: string): boolean {
  const t = text.toLowerCase();
  const pat = /(resource_exhausted|embedd\w*[^\n]{0,80}429|429[^\n]{0,80}embedd\w*)/;
  return pat.test(t) && (t.includes("failed") || t.includes("error") || t.includes("quota"));
}

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

function insertIncident(threatType: string, severity: string, description: string, tier: number, metadata: Record<string, any>): void {
  const sig = threatType;
  const dedupeSql =
    "SELECT COUNT(*) FROM cortana_immune_incidents " +
    `WHERE status='open' AND threat_signature='${sqlEscape(sig)}';`;
  const check = query(dedupeSql).trim();
  if (check && Number.parseInt(check, 10) > 0) return;

  const metaJson = JSON.stringify(metadata).replace(/'/g, "''");
  const sql =
    "INSERT INTO cortana_immune_incidents " +
    "(detected_at, threat_type, source, severity, description, threat_signature, tier, status, playbook_used, auto_resolved, metadata) VALUES " +
    `(NOW(), '${sqlEscape(threatType)}', 'vector_memory_health', '${sqlEscape(severity)}', ` +
    `'${sqlEscape(description)}', '${sqlEscape(sig)}', ${tier}, 'open', 'vector_memory_guard', FALSE, '${metaJson}'::jsonb);`;
  query(sql);
}

function attemptProbe(): [boolean, string] {
  const proc = spawnSync("openclaw", ["memory", "search", "vector health probe", "--json", "--max-results", "1"], {
    encoding: "utf8",
    timeout: 90000,
  });
  const combined = `${proc.stdout || ""}\n${proc.stderr || ""}`;
  return [isEmbedding429(combined), combined];
}

function attemptReindex(): [boolean, string] {
  const proc = spawnSync("openclaw", ["memory", "index", "--force"], { encoding: "utf8", timeout: 1800000 });
  const out = `${proc.stdout || ""}\n${proc.stderr || ""}`.trim();
  return [proc.status === 0 && !isEmbedding429(out), out.slice(0, 2000)];
}

function printHelp(): void {
  const text = `usage: vector-health-gate.ts [-h] [--json]\n\noptions:\n  -h, --help  show this help message and exit\n  --json`;
  console.log(text);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    printHelp();
    return;
  }
  const jsonFlag = argv.includes("--json");

  const state = loadState();
  const [files, chunks, status] = getMemoryStatus();

  const [saw429, probeOutput] = attemptProbe();
  if (saw429) {
    state.consecutive_embedding_429 = Number(state.consecutive_embedding_429 ?? 0) + 1;
  } else {
    state.consecutive_embedding_429 = 0;
  }

  if (chunks === 0) {
    state.fallback_mode = true;
    state.reindex_queued = true;
    state.queued_at = state.queued_at || nowIso();
    insertIncident(
      "vector_index_empty",
      "critical",
      "Vector memory index has zero chunks; semantic retrieval unavailable.",
      1,
      {
        files,
        chunks,
        provider: status.provider,
        model: status.model,
      }
    );
  }

  if (Number(state.consecutive_embedding_429 ?? 0) >= 3) {
    state.fallback_mode = true;
    state.reindex_queued = true;
    state.queued_at = state.queued_at || nowIso();
    insertIncident(
      "embedding_quota_429",
      "critical",
      "Embedding provider returned 429 three+ consecutive probes; switched to keyword fallback.",
      1,
      {
        consecutive_429: state.consecutive_embedding_429 ?? 0,
        probe_excerpt: probeOutput.slice(0, 500),
        provider: status.provider,
        model: status.model,
      }
    );
  }

  let reindexAttempted = false;
  let reindexOk = false;
  let reindexNote = "";
  if (state.reindex_queued && !saw429) {
    reindexAttempted = true;
    [reindexOk, reindexNote] = attemptReindex();
    if (reindexOk) {
      state.reindex_queued = false;
      state.fallback_mode = false;
      state.consecutive_embedding_429 = 0;
      state.last_reindex_ok_at = nowIso();
      delete state.queued_at;
    } else {
      state.last_reindex_error = reindexNote.slice(0, 600);
    }
  }

  if (chunks > 0 && Number(state.consecutive_embedding_429 ?? 0) === 0 && !state.reindex_queued) {
    state.fallback_mode = false;
  }

  state.last_checked_at = nowIso();
  state.last_status = {
    files,
    chunks,
    provider: status.provider,
    model: status.model,
  };
  saveState(state);

  const out = {
    ok: chunks > 0,
    files,
    chunks,
    consecutive_embedding_429: state.consecutive_embedding_429 ?? 0,
    fallback_mode: Boolean(state.fallback_mode),
    reindex_queued: Boolean(state.reindex_queued),
    reindex_attempted: reindexAttempted,
    reindex_ok: reindexOk,
  };

  if (jsonFlag) {
    console.log(JSON.stringify(out));
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
