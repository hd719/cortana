#!/usr/bin/env npx tsx

/** Enforce Covenant memory boundaries for sub-agent write targets. */

import path from "path";
import { resolveRepoPath } from "../lib/paths.js";

const WORKSPACE_ROOT = path.resolve(resolveRepoPath());
const LONG_TERM_MEMORY_FILES = new Set([path.resolve(path.join(WORKSPACE_ROOT, "MEMORY.md"))]);
const LONG_TERM_MEMORY_PREFIXES = [path.resolve(path.join(WORKSPACE_ROOT, "memory"))];

function fail(msg: string): never {
  console.error(`MEMORY_BOUNDARY_VIOLATION: ${msg}`);
  process.exit(1);
}

function inDir(target: string, parent: string): boolean {
  const rel = path.relative(parent, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error("Usage: validate_memory_boundary.py <agent_identity_id> <target_path>");
    process.exit(2);
  }

  const agentIdentityId = args[0].trim();
  if (!agentIdentityId) fail("agent_identity_id is required");

  const target = path.resolve(args[1]);

  if (!inDir(target, WORKSPACE_ROOT)) {
    fail(`path is outside workspace root: ${target}`);
  }

  if (LONG_TERM_MEMORY_FILES.has(target)) {
    fail(`writes to long-term memory are restricted to Cortana main: ${target}`);
  }

  for (const prefix of LONG_TERM_MEMORY_PREFIXES) {
    if (inDir(target, prefix)) {
      fail(`writes to long-term memory namespace are restricted to Cortana main: ${target}`);
    }
  }

  const ownScratch = path.resolve(
    path.join(WORKSPACE_ROOT, ".covenant", "agents", agentIdentityId, "scratch")
  );
  const anyScratchRoot = path.resolve(path.join(WORKSPACE_ROOT, ".covenant", "agents"));

  if (inDir(target, anyScratchRoot) && !inDir(target, ownScratch)) {
    fail(`cross-agent scratch access denied: ${target} is not under ${ownScratch}`);
  }

  const identitiesRoot = path.resolve(path.join(WORKSPACE_ROOT, "agents", "identities"));
  if (inDir(target, identitiesRoot)) {
    fail("agent identity contracts are immutable during task execution");
  }

  console.log("MEMORY_BOUNDARY_OK");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
