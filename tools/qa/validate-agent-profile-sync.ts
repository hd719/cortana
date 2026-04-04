#!/usr/bin/env npx tsx

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type OpenClawAgent = {
  id: string;
  workspace: string;
  model?: string | { primary?: string };
};

type AgentProfile = {
  id: string;
  workspace: string;
  model?: string;
  identityNamespace?: string;
};

type IdentityNamespaceConfig = {
  defaultNamespace?: string;
  namespaces?: Record<string, string>;
};

type Mismatch = {
  agentId: string;
  issue: string;
  expected?: string;
  actual?: string;
};

export type SyncReport = {
  ok: boolean;
  openclawCount: number;
  profileCount: number;
  mismatches: Mismatch[];
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function expectedModel(agent: OpenClawAgent): string {
  if (typeof agent.model === "string") return agent.model;
  return agent.model?.primary ?? "";
}

function expectedNamespace(agent: OpenClawAgent, namespaces: Record<string, string>): string | null {
  const explicit = namespaces[agent.id];
  if (explicit) return explicit;
  const match = /\/identities\/([^/]+)$/.exec(agent.workspace);
  if (match?.[1]) return match[1];
  if (agent.id === "main") return "main";
  return null;
}

export function evaluateAgentProfileSync(paths?: {
  openclawPath?: string;
  agentProfilesPath?: string;
  identityNamespacesPath?: string;
}): SyncReport {
  const openclawPath = paths?.openclawPath ?? path.join(REPO_ROOT, "config", "openclaw.json");
  const agentProfilesPath = paths?.agentProfilesPath ?? path.join(REPO_ROOT, "config", "agent-profiles.json");
  const identityNamespacesPath = paths?.identityNamespacesPath ?? path.join(REPO_ROOT, "config", "identity-namespaces.json");

  const openclaw = readJson<{ agents?: { list?: OpenClawAgent[] } }>(openclawPath);
  const profiles = readJson<AgentProfile[]>(agentProfilesPath);
  const nsConfig = readJson<IdentityNamespaceConfig>(identityNamespacesPath);

  const agents = Array.isArray(openclaw.agents?.list) ? openclaw.agents!.list : [];
  const byProfile = new Map(profiles.map((profile) => [profile.id, profile]));
  const byAgent = new Map(agents.map((agent) => [agent.id, agent]));
  const namespaces = nsConfig.namespaces ?? {};
  const mismatches: Mismatch[] = [];

  for (const agent of agents) {
    const profile = byProfile.get(agent.id);
    if (!profile) {
      mismatches.push({ agentId: agent.id, issue: "missing_profile" });
      continue;
    }

    if (profile.workspace !== agent.workspace) {
      mismatches.push({
        agentId: agent.id,
        issue: "workspace_mismatch",
        expected: agent.workspace,
        actual: profile.workspace,
      });
    }

    const model = expectedModel(agent);
    if (profile.model !== model) {
      mismatches.push({
        agentId: agent.id,
        issue: "model_mismatch",
        expected: model,
        actual: profile.model ?? "",
      });
    }

    const namespace = expectedNamespace(agent, namespaces);
    if (namespace && profile.identityNamespace !== namespace) {
      mismatches.push({
        agentId: agent.id,
        issue: "identity_namespace_mismatch",
        expected: namespace,
        actual: profile.identityNamespace ?? "",
      });
    }
  }

  for (const profile of profiles) {
    if (!byAgent.has(profile.id)) {
      mismatches.push({ agentId: profile.id, issue: "stale_profile_entry" });
    }
  }

  return {
    ok: mismatches.length === 0,
    openclawCount: agents.length,
    profileCount: profiles.length,
    mismatches,
  };
}

export function run(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const report = evaluateAgentProfileSync();

  if (json) {
    console.log(JSON.stringify(report));
    return report.ok ? 0 : 1;
  }

  if (report.ok) {
    console.log("NO_REPLY");
    return 0;
  }

  console.log(
    [
      "⚠️ Agent profile drift detected",
      `OpenClaw agents: ${report.openclawCount}`,
      `Agent profiles: ${report.profileCount}`,
      ...report.mismatches.slice(0, 10).map((mismatch) =>
        `- ${mismatch.agentId}: ${mismatch.issue}` +
        (mismatch.expected != null || mismatch.actual != null
          ? ` (expected=${JSON.stringify(mismatch.expected ?? "")}, actual=${JSON.stringify(mismatch.actual ?? "")})`
          : ""),
      ),
    ].join("\n"),
  );

  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(run());
}
