import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "url";

export const POSTGRES_PATH = "/opt/homebrew/opt/postgresql@17/bin";
export const PSQL_BIN = process.env.PSQL_BIN ?? path.join(POSTGRES_PATH, "psql");

export function getScriptDir(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}

export function findRepoRoot(startDir?: string): string {
  const cwd = process.cwd();
  if (startDir) {
    const absoluteStart = path.resolve(startDir);
    if (absoluteStart === cwd || absoluteStart.startsWith(`${cwd}${path.sep}`)) {
      return cwd;
    }
  }
  return process.env.CORTANA_SOURCE_REPO ?? cwd;
}

export function repoRoot(): string {
  return process.env.CORTANA_SOURCE_REPO ?? process.cwd();
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
