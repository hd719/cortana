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

export type DurableMemoryTargets = {
  agentId: string;
  namespace: string;
  memoryFilePath: string;
  memoryDirPath: string;
  usedFallback: boolean;
  warning?: string;
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

export function loadIdentityNamespaceConfig(workspaceDir: string, configPath = "config/identity-namespaces.json"): IdentityNamespaceConfig {
  try {
    const raw = fs.readFileSync(path.join(workspaceDir, configPath), "utf-8");
    const parsed = JSON.parse(raw) as IdentityNamespaceConfig;
    return {
      defaultNamespace: parsed.defaultNamespace?.trim() || "main",
      namespaces: parsed.namespaces ?? {},
    };
  } catch {
    return { defaultNamespace: "main", namespaces: {} };
  }
}

export function resolveDurableMemoryTargets(params: {
  workspaceDir: string;
  agentId?: string | null;
  sessionKey?: string | null;
  configPath?: string;
  warn?: (message: string) => void;
}): DurableMemoryTargets {
  const { workspaceDir, configPath, warn } = params;
  const explicitAgent = params.agentId?.trim().toLowerCase() || null;
  const inferredAgent = resolveAgentIdFromSessionKey(params.sessionKey ?? undefined);
  const agentId = explicitAgent || inferredAgent || "main";

  const config = loadIdentityNamespaceConfig(workspaceDir, configPath);
  const namespace = resolveNamespaceForAgent(agentId, config);

  const defaultMemoryFilePath = path.join(workspaceDir, "MEMORY.md");
  const defaultMemoryDirPath = path.join(workspaceDir, "memory");

  if (namespace === "main") {
    return {
      agentId,
      namespace,
      memoryFilePath: defaultMemoryFilePath,
      memoryDirPath: defaultMemoryDirPath,
      usedFallback: false,
    };
  }

  const namespacedMemoryFilePath = resolveNamespaceFilePath(workspaceDir, namespace, "MEMORY.md");
  const namespacedMemoryDirPath = path.join(workspaceDir, "identities", namespace, "memory");

  const hasNamespacedFile = fs.existsSync(namespacedMemoryFilePath);
  const hasNamespacedDir = fs.existsSync(namespacedMemoryDirPath);

  if (hasNamespacedFile && hasNamespacedDir) {
    return {
      agentId,
      namespace,
      memoryFilePath: namespacedMemoryFilePath,
      memoryDirPath: namespacedMemoryDirPath,
      usedFallback: false,
    };
  }

  const warning =
    `[identity-namespace-memory] namespace=${namespace} for agent=${agentId} is missing durable memory path ` +
    `(file=${hasNamespacedFile}, dir=${hasNamespacedDir}); falling back to main memory targets`;
  warn?.(warning);

  return {
    agentId,
    namespace,
    memoryFilePath: defaultMemoryFilePath,
    memoryDirPath: defaultMemoryDirPath,
    usedFallback: true,
    warning,
  };
}
