#!/usr/bin/env npx tsx

import { spawnSync } from "child_process";
import { readJsonFile, writeJsonFileAtomic } from "../lib/json-file.js";
import { resolveRepoPath } from "../lib/paths.js";
import { query } from "../lib/db.js";
export function runCli(argv = process.argv.slice(2)): number {
  if (argv.includes("--help")) {
    console.log("usage: vector-health-gate.ts [--json]");
    return 0;
  }

  const statePath = `${resolveRepoPath()}/memory/vector-health-state.json`;
  const state = readJsonFile<Record<string, any>>(statePath) ?? {};
  const statusRes: any = spawnSync("openclaw", ["memory", "status", "--json"], { encoding: "utf8" });
  const statusRows = JSON.parse(statusRes?.stdout || "[]");
  const stats = statusRows?.[0]?.status ?? { chunks: 0 };

  let reindex_attempted = false;
  let reindex_ok = false;
  let fallback_mode = Boolean(state.fallback_mode);
  let consecutive429 = Number(state.consecutive_embedding_429 ?? 0);

  if (Number(stats.chunks ?? 0) === 0) {
    reindex_attempted = true;
    const reindex: any = spawnSync("openclaw", ["memory", "index"], { encoding: "utf8" });
    reindex_ok = (reindex?.status ?? 1) === 0;
    fallback_mode = false;
  } else {
    const search: any = spawnSync("openclaw", ["memory", "search", "healthcheck"], { encoding: "utf8" });
    if ((search?.status ?? 1) !== 0 && String(search?.stderr || "").includes("429")) {
      consecutive429 += 1;
    } else {
      consecutive429 = 0;
    }
    if (consecutive429 >= 3) fallback_mode = true;
  }

  query("SELECT 1");

  const nextState = {
    ...state,
    consecutive_embedding_429: consecutive429,
    fallback_mode,
    reindex_queued: reindex_attempted && !reindex_ok,
    updated_at: new Date().toISOString(),
  };
  writeJsonFileAtomic(statePath, nextState);

  console.log(
    JSON.stringify({
      fallback_mode,
      reindex_attempted,
      reindex_ok,
      consecutive_embedding_429: consecutive429,
    })
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runCli());
}
