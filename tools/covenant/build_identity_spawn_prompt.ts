#!/usr/bin/env npx tsx

/** Build Covenant sub-agent prompt with enforced identity contract. */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { runPsql, withPostgresPath } from "../lib/db.js";
import { resolveRepoPath } from "../lib/paths.js";

const WORKSPACE_ROOT = resolveRepoPath();
const REGISTRY_PATH = path.join(WORKSPACE_ROOT, "agents", "identities", "registry.json");
const HANDSHAKE_VALIDATOR = path.join(WORKSPACE_ROOT, "tools", "covenant", "validate_spawn_handshake.py");
const FEEDBACK_COMPILER = path.join(WORKSPACE_ROOT, "tools", "covenant", "feedback_compiler.ts");
const MEMORY_INJECTOR = path.join(WORKSPACE_ROOT, "tools", "covenant", "memory_injector.ts");

const IDENTITY_PROMPT_TEMPLATES: Record<string, string> = {
  "agent.monitor.v1": "Focus on signal quality, anomaly detection, and actionable triage paths.",
  "agent.huragok.v1": "Focus on implementation safety, resilience, and reproducible execution artifacts.",
  "agent.researcher.v1": "Focus on high-quality source gathering, evidence synthesis, and option comparisons with confidence.",
  "agent.oracle.v1": "Focus on strategic forecasts, risk tradeoffs, and recommendation logic grounded in evidence.",
  "agent.librarian.v1": "Focus on clear documentation structure, durable references, and organized knowledge artifacts.",
};

const DEFAULT_DB = "cortana";

type Json = Record<string, unknown>;

type HandshakePayload = {
  agent_identity_id: string;
  objective: string;
  success_criteria: string[];
  output_format: { type: string; sections: string[] };
  timeout_retry_policy: { timeout_seconds: number; max_retries: number; retry_on: string[]; escalate_on: string[] };
  callback: { update_channel: string; final_channel?: string; heartbeat_interval_seconds?: number; on_blocked?: string };
  constraints?: { workspace_root?: string; allowed_paths?: string[]; forbidden_actions?: string[] };
  trace_id?: string;
  chain_id?: string;
  metadata?: Json;
};

function usageExit(): never {
  console.error("Usage: build_identity_spawn_prompt.ts <handshake.json> [--output <path>]");
  process.exit(2);
}

function fail(msg: string): never {
  console.error(`PROMPT_BUILD_INVALID: ${msg}`);
  process.exit(1);
}

function loadJson(filePath: string, label: string): unknown {
  if (!fs.existsSync(filePath)) {
    fail(`${label} not found: ${filePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`${label} invalid JSON: ${message}`);
  }
}

function formatBullets(values: string[]): string {
  return values.map((v) => `- ${v}`).join("\n");
}

function agentRoleFromIdentity(identityId: string, contract: Json): string {
  const roleText = String(contract.role ?? "").toLowerCase();
  for (const known of ["huragok", "researcher", "librarian", "oracle", "monitor"]) {
    if (roleText.includes(known)) return known;
  }
  const parts = identityId.split(".");
  if (parts.length >= 2) return parts[1].toLowerCase();
  return "all";
}

function feedbackInjectionBlock(agentRole: string, limit = 5): string {
  if (!fs.existsSync(FEEDBACK_COMPILER)) return "";
  const result = spawnSync(FEEDBACK_COMPILER, ["inject", agentRole, "--limit", String(limit)], {
    encoding: "utf8",
  });
  if (result.status !== 0) return "";
  return (result.stdout || "").trim();
}

function memoryInjectionBlock(agentRole: string, limit = 5, maxChars = 2000, sinceHours = 168): string {
  if (!fs.existsSync(MEMORY_INJECTOR)) return "";
  const result = spawnSync(
    MEMORY_INJECTOR,
    [
      "inject",
      agentRole,
      "--limit",
      String(limit),
      "--max-chars",
      String(maxChars),
      "--since-hours",
      String(sinceHours),
    ],
    { encoding: "utf8" }
  );
  if (result.status !== 0) return "";
  return (result.stdout || "").trim();
}

function sqlQuote(value: string): string {
  return value.replace(/'/g, "''");
}

function extractChainId(payload: HandshakePayload): string | null {
  const direct = payload.chain_id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (payload.metadata && typeof payload.metadata === "object") {
    const chainId = (payload.metadata as Json).chain_id;
    if (typeof chainId === "string" && chainId.trim()) return chainId.trim();
  }
  return null;
}

function extractTraceId(payload: HandshakePayload): string | null {
  const direct = payload.trace_id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (payload.metadata && typeof payload.metadata === "object") {
    const traceId = (payload.metadata as Json).trace_id;
    if (typeof traceId === "string" && traceId.trim()) return traceId.trim();
  }
  return null;
}

function fetchHandoffArtifacts(chainId: string, toAgent: string): Json[] {
  const sql =
    "SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.created_at ASC), '[]'::json)::text " +
    "FROM (" +
    "SELECT id, chain_id, from_agent, to_agent, artifact_type, payload, created_by, created_at " +
    "FROM cortana_handoff_artifacts " +
    `WHERE chain_id = '${sqlQuote(chainId)}'::uuid ` +
    "AND consumed_at IS NULL " +
    `AND (to_agent IS NULL OR to_agent = '${sqlQuote(toAgent)}') ` +
    "ORDER BY created_at ASC" +
    ") t;";

  const result = runPsql(sql, { db: DEFAULT_DB, args: ["-X", "-q", "-At"], env: withPostgresPath(process.env) });
  if (result.status !== 0) return [];

  try {
    const parsed = JSON.parse((result.stdout || "").toString().trim() || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function handoffArtifactBlock(payload: HandshakePayload, agentRole: string): string {
  const chainId = extractChainId(payload);
  if (!chainId || !agentRole) return "";

  const artifacts = fetchHandoffArtifacts(chainId, agentRole);
  if (!artifacts.length) return "";

  const compact = artifacts.map((a) => ({
    id: a.id,
    from_agent: a.from_agent,
    to_agent: a.to_agent,
    artifact_type: a.artifact_type,
    created_at: a.created_at,
    payload: a.payload,
  }));

  return (
    "## Handoff Artifacts (HAB)\n" +
    "Use these Cortana-curated upstream artifacts as chain context.\n" +
    `- chain_id: ${chainId}\n` +
    `- recipient_agent: ${agentRole}\n` +
    `- artifact_count: ${compact.length}\n\n` +
    "```json\n" +
    `${JSON.stringify(compact, null, 2)}\n` +
    "```"
  );
}

function buildPrompt(
  payload: HandshakePayload,
  contract: Json,
  feedbackBlock = "",
  memoryBlock = "",
  handoffBlock = ""
): string {
  const successCriteria = payload.success_criteria;
  const outputFormat = payload.output_format;
  const timeoutRetry = payload.timeout_retry_policy;
  const callback = payload.callback;
  const constraints = payload.constraints ?? {};
  const traceId = extractTraceId(payload);

  const sections = outputFormat.sections;
  const allowedTools = contract.tool_permissions as string[];
  const hardBoundaries = contract.hard_boundaries as string[];
  const escalationTriggers = contract.escalation_triggers as string[];

  return `You are running under Covenant Identity Contract enforcement.

## Identity Contract (authoritative)
- id: ${payload.agent_identity_id}
- name: ${String(contract.name)}
- role: ${String(contract.role)}
- mission_scope: ${String(contract.mission_scope)}
- tone_voice: ${String(contract.tone_voice)}
- identity_template: ${IDENTITY_PROMPT_TEMPLATES[payload.agent_identity_id] ?? "Use role-consistent reasoning and deliver contract-compliant outputs."}

### Tool Permissions (ALLOWLIST — strict)
${formatBullets(allowedTools)}

### Hard Boundaries (never violate)
${formatBullets(hardBoundaries)}

### Escalation Triggers (immediate escalation to Cortana)
${formatBullets(escalationTriggers)}

${feedbackBlock || "## Agent Feedback Lessons\n- No role-specific lessons injected for this spawn."}

${memoryBlock || "## Identity-Scoped Memory Context\n- No role-scoped memories injected for this spawn."}

${handoffBlock || "## Handoff Artifacts (HAB)\n- No unconsumed artifacts injected for this spawn."}

## Spawn Correlation Metadata
- trace_id: ${traceId || "not provided"}
- chain_id: ${extractChainId(payload) || "not provided"}

## Mission Objective
${payload.objective}

## Success Criteria
${formatBullets(successCriteria)}

## Output Contract
- format: ${outputFormat.type}
- required_sections: ${sections.join(", ")}

## Timeout / Retry Policy
- timeout_seconds: ${timeoutRetry.timeout_seconds}
- max_retries: ${timeoutRetry.max_retries}
- retry_on: ${timeoutRetry.retry_on.join(", ")}
- escalate_on: ${timeoutRetry.escalate_on.join(", ")}

## Callback Protocol
- update_channel: ${callback.update_channel}
- final_channel: ${callback.final_channel ?? "requester_session"}
- heartbeat_interval_seconds: ${callback.heartbeat_interval_seconds ?? 300}
- on_blocked: ${callback.on_blocked ?? "immediate"}

## Constraints
- workspace_root: ${constraints.workspace_root ?? "/Users/hd/openclaw"}
- allowed_paths: ${(constraints.allowed_paths ?? ["/Users/hd/openclaw"]).join(", ")}
- forbidden_actions: ${constraints.forbidden_actions && constraints.forbidden_actions.length ? constraints.forbidden_actions.join(", ") : "none specified"}

## Required Protocol Emission (machine-parseable)
Emit status/completion JSON lines exactly once each (single-line JSON object per line):
- \`COVENANT_STATUS_JSON: {...}\`
- \`COVENANT_COMPLETION_JSON: {...}\`

### Status payload required fields
- state
- confidence
- blockers
- evidence
- next_action

### Completion payload required fields
- summary
- artifacts
- risks
- follow_ups

The lines above are parsed by tooling and must be valid JSON. Do not wrap in markdown.
Use:
- \`python3 /Users/hd/openclaw/tools/covenant/validate_agent_protocol.py --type status <status.json>\`
- \`python3 /Users/hd/openclaw/tools/covenant/validate_agent_protocol.py --type completion <completion.json>\`
for pre-flight checks when needed.

If requirements are ambiguous or conflict with contract boundaries, stop and escalate.

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`
`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length !== 1 && argv.length !== 3) {
    usageExit();
  }

  const payloadPath = path.resolve(argv[0]);
  let outputPath: string | null = null;

  if (argv.length === 3) {
    if (argv[1] !== "--output") {
      usageExit();
    }
    outputPath = path.resolve(argv[2]);
  }

  const payloadRaw = loadJson(payloadPath, "handshake payload");
  if (!payloadRaw || typeof payloadRaw !== "object" || Array.isArray(payloadRaw)) {
    fail("handshake payload root must be an object");
  }
  const payload = payloadRaw as HandshakePayload;

  const result = spawnSync("python3", [HANDSHAKE_VALIDATOR, payloadPath], { encoding: "utf8" });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "").toString().trim();
    fail(`handshake validation failed: ${err}`);
  }

  const registryRaw = loadJson(REGISTRY_PATH, "identity registry");
  if (!registryRaw || typeof registryRaw !== "object" || Array.isArray(registryRaw)) {
    fail("identity registry missing 'agents' object");
  }

  const registry = registryRaw as Json;
  const agents = registry.agents as Json | undefined;
  if (!agents || typeof agents !== "object") {
    fail("identity registry missing 'agents' object");
  }

  const identityId = payload.agent_identity_id;
  const contract = agents[identityId] as Json | undefined;
  if (!contract || typeof contract !== "object") {
    fail(`identity contract not found for ${identityId}`);
  }

  const agentRole = agentRoleFromIdentity(identityId, contract);
  const feedbackBlock = feedbackInjectionBlock(agentRole, 5);
  const memoryBlock = memoryInjectionBlock(agentRole, 5, 2000, 168);
  const handoffBlock = handoffArtifactBlock(payload, agentRole);

  const prompt = buildPrompt(payload, contract, feedbackBlock, memoryBlock, handoffBlock);

  if (outputPath) {
    fs.writeFileSync(outputPath, prompt, "utf8");
    console.log(`PROMPT_READY: ${outputPath}`);
  } else {
    console.log(prompt);
  }
}

main();
