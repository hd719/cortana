import fs from "node:fs";
import path from "node:path";

const FILES = ["SOUL.md", "USER.md", "IDENTITY.md", "HEARTBEAT.md", "MEMORY.md", "TOOLS.md"];

function normalizeBootstrapEntryName(entryFile) {
  if (!entryFile || typeof entryFile !== "object") return "";

  const fromName = typeof entryFile.name === "string" ? path.basename(entryFile.name.trim()) : "";
  if (fromName) return fromName;

  const fromPath = typeof entryFile.path === "string" ? path.basename(entryFile.path.trim()) : "";
  return fromPath;
}

function parseAgentId(event) {
  const explicit = typeof event?.context?.agentId === "string" ? event.context.agentId.trim().toLowerCase() : "";
  if (explicit) return explicit;
  const sessionKey = typeof event?.context?.sessionKey === "string" ? event.context.sessionKey : "";
  const match = /^agent:([^:]+):/i.exec(sessionKey.trim());
  return match?.[1]?.trim().toLowerCase() || "main";
}

function loadNamespaceConfig(workspaceDir, configPathRaw) {
  const relativePath = typeof configPathRaw === "string" && configPathRaw.trim() ? configPathRaw.trim() : "config/identity-namespaces.json";
  const absolutePath = path.resolve(workspaceDir, relativePath);
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf-8"));
  } catch {
    return { defaultNamespace: "main", namespaces: {} };
  }
}

function resolveNamespace(agentId, config) {
  const namespaces = config?.namespaces ?? {};
  const explicit = typeof namespaces[agentId] === "string" ? namespaces[agentId].trim() : "";
  if (explicit) return explicit;
  const fallback = typeof config?.defaultNamespace === "string" ? config.defaultNamespace.trim() : "";
  return fallback || "main";
}

export default async function identityNamespaceBootstrapHook(event) {
  if (event?.event !== "agent:bootstrap" || !event.context) return;

  const cfg = event.context.cfg ?? {};
  const entry = cfg?.hooks?.internal?.entries?.["identity-namespace-bootstrap"] ?? {};
  if (entry?.enabled === false) return;

  const workspaceDir = event.context.workspaceDir;
  if (!workspaceDir || !Array.isArray(event.context.bootstrapFiles)) return;

  const agentId = parseAgentId(event);
  const namespaceConfig = loadNamespaceConfig(workspaceDir, entry.configPath);
  const namespace = resolveNamespace(agentId, namespaceConfig);

  const files = [...event.context.bootstrapFiles];
  for (const name of FILES) {
    const candidate = path.resolve(workspaceDir, "identities", namespace, name);
    let content = null;
    try {
      content = fs.readFileSync(candidate, "utf-8");
    } catch {
      console.warn(`[identity-namespace-bootstrap] missing ${name} for namespace=${namespace}; keeping workspace default`);
      continue;
    }

    const idx = files.findIndex((entryFile) => normalizeBootstrapEntryName(entryFile) === name);
    if (idx >= 0) {
      files[idx] = { ...files[idx], name, path: candidate, content, missing: false };
    } else {
      files.push({ name, path: candidate, content, missing: false });
    }
  }

  event.context.bootstrapFiles = files;
}
