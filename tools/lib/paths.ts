import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "url";

export const POSTGRES_PATH = "/opt/homebrew/opt/postgresql@17/bin";
export const PSQL_BIN = process.env.PSQL_BIN ?? path.join(POSTGRES_PATH, "psql");

export function getScriptDir(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}

function safeExistsSync(filePath: string): boolean {
  const fn = (fs as typeof import("node:fs") & { default?: { existsSync?: (p: string) => boolean } }).existsSync
    ?? (fs as { default?: { existsSync?: (p: string) => boolean } }).default?.existsSync;
  if (typeof fn !== "function") return false;
  return fn(filePath);
}

export function findRepoRoot(startDir?: string): string {
  let dir = startDir ?? getScriptDir(import.meta.url);
  for (let i = 0; i < 12; i += 1) {
    if (
      safeExistsSync(path.join(dir, "AGENTS.md")) ||
      safeExistsSync(path.join(dir, ".git"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return startDir ?? process.cwd();
}

export function repoRoot(): string {
  return findRepoRoot();
}

export function resolveRepoPath(...segments: string[]): string {
  return path.join(repoRoot(), ...segments);
}

export function resolveHomePath(...segments: string[]): string {
  return path.join(os.homedir(), ...segments);
}

export function homeRoot(): string {
  return process.env.CORTANA_HOME ?? os.homedir();
}

export function sourceRepoRoot(): string {
  return process.env.CORTANA_SOURCE_REPO ?? path.join(homeRoot(), "Developer", "cortana");
}

export function externalRepoRoot(): string {
  return process.env.CORTANA_EXTERNAL_REPO ?? path.join(homeRoot(), "Developer", "cortana-external");
}

export function compatRepoRoot(): string {
  return process.env.CORTANA_COMPAT_REPO ?? path.join(homeRoot(), "openclaw");
}

export function runtimeStateHome(): string {
  return process.env.CORTANA_RUNTIME_HOME ?? homeRoot();
}

export function resolveRuntimeStatePath(...segments: string[]): string {
  return path.join(runtimeStateHome(), ".openclaw", ...segments);
}
