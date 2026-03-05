import fs from "node:fs";
import path from "node:path";

export const IDENTITY_NAMESPACE_FILES = [
  "SOUL.md",
  "USER.md",
  "IDENTITY.md",
  "HEARTBEAT.md",
  "MEMORY.md",
] as const;

export type IdentityNamespaceFile = (typeof IDENTITY_NAMESPACE_FILES)[number];

export type IdentityNamespaceConfig = {
  defaultNamespace?: string;
  namespaces?: Record<string, string>;
};

export function resolveNamespaceForAgent(
  agentId: string | null | undefined,
  config: IdentityNamespaceConfig,
): string {
  const normalizedAgent = (agentId ?? "").trim().toLowerCase() || "main";
  const byAgent = config.namespaces ?? {};
  const explicit = byAgent[normalizedAgent]?.trim();
  if (explicit) return explicit;
  const fallback = config.defaultNamespace?.trim();
  if (fallback) return fallback;
  return "main";
}

export function resolveNamespaceFilePath(workspaceDir: string, namespace: string, fileName: IdentityNamespaceFile): string {
  return path.join(workspaceDir, "identities", namespace, fileName);
}

export function upsertBootstrapFile(
  files: Array<{ name: string; path: string; content?: string; missing?: boolean }>,
  next: { name: string; path: string; content: string },
) {
  const index = files.findIndex((entry) => entry.name === next.name);
  if (index >= 0) {
    files[index] = { ...files[index], ...next, missing: false };
    return;
  }
  files.push({ ...next, missing: false });
}

export function readIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

export function resolveAgentIdFromSessionKey(sessionKey: string | undefined): string | null {
  if (!sessionKey) return null;
  const match = /^agent:([^:]+):/i.exec(sessionKey.trim());
  if (!match) return null;
  return match[1]?.trim().toLowerCase() || null;
}
