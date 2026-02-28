#!/usr/bin/env npx tsx

/** Validate Covenant sub-agent spawn handshake payloads. */

import fs from "fs";
import path from "path";
import { resolveRepoPath } from "../lib/paths.js";

const WORKSPACE_ROOT = resolveRepoPath();
const IDENTITY_REGISTRY_PATH = path.join(WORKSPACE_ROOT, "agents", "identities", "registry.json");

const ALLOWED_FIELDS = new Set([
  "request_id",
  "spawned_by",
  "agent_identity_id",
  "objective",
  "success_criteria",
  "output_format",
  "timeout_retry_policy",
  "callback",
  "constraints",
  "metadata",
]);

const REQUIRED_FIELDS = new Set([
  "agent_identity_id",
  "objective",
  "success_criteria",
  "output_format",
  "timeout_retry_policy",
  "callback",
]);

const ALLOWED_CALLBACK_FIELDS = new Set(["update_channel", "final_channel", "heartbeat_interval_seconds", "on_blocked"]);
const REQUIRED_CALLBACK_FIELDS = new Set(["update_channel"]);
const ALLOWED_OUTPUT_FORMAT_FIELDS = new Set(["type", "sections"]);
const REQUIRED_OUTPUT_FORMAT_FIELDS = new Set(["type", "sections"]);
const ALLOWED_TIMEOUT_FIELDS = new Set(["timeout_seconds", "max_retries", "retry_on", "escalate_on"]);
const REQUIRED_TIMEOUT_FIELDS = new Set(["timeout_seconds", "max_retries", "retry_on", "escalate_on"]);
const ALLOWED_CONSTRAINT_FIELDS = new Set(["workspace_root", "allowed_paths", "forbidden_actions"]);
const ALLOWED_METADATA_FIELDS = new Set(["chain_id", "trace_id"]);

function fail(msg: string): never {
  console.error(`HANDSHAKE_INVALID: ${msg}`);
  process.exit(1);
}

function expectObject(value: any, field: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`'${field}' must be an object`);
  }
  return value as Record<string, any>;
}

function expectNonEmptyString(value: any, field: string): void {
  if (typeof value !== "string" || !value.trim()) {
    fail(`'${field}' must be a non-empty string`);
  }
}

function expectNonEmptyStringList(value: any, field: string): void {
  if (!Array.isArray(value) || !value.length) {
    fail(`'${field}' must be a non-empty array`);
  }
  value.forEach((item, idx) => {
    if (typeof item !== "string" || !item.trim()) {
      fail(`'${field}[${idx}]' must be a non-empty string`);
    }
  });
}

function loadRegistry(): Record<string, any> {
  if (!fs.existsSync(IDENTITY_REGISTRY_PATH)) {
    fail(`identity registry not found: ${IDENTITY_REGISTRY_PATH}`);
  }
  let registry: any;
  try {
    registry = JSON.parse(fs.readFileSync(IDENTITY_REGISTRY_PATH, "utf8"));
  } catch (err) {
    fail(`identity registry invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    fail("identity registry root must be an object");
  }
  const agents = registry.agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents) || !Object.keys(agents).length) {
    fail("identity registry must contain non-empty 'agents' object");
  }
  return registry as Record<string, any>;
}

function validate(payload: Record<string, any>): void {
  const extra = Object.keys(payload).filter((k) => !ALLOWED_FIELDS.has(k)).sort();
  if (extra.length) {
    fail(`unsupported field(s): ${extra.join(", ")}`);
  }

  const missing = Array.from(REQUIRED_FIELDS).filter((k) => !(k in payload)).sort();
  if (missing.length) {
    fail(`missing required field(s): ${missing.join(", ")}`);
  }

  if ("request_id" in payload) expectNonEmptyString(payload.request_id, "request_id");
  if ("spawned_by" in payload) expectNonEmptyString(payload.spawned_by, "spawned_by");

  expectNonEmptyString(payload.agent_identity_id, "agent_identity_id");
  const registry = loadRegistry();
  const knownIds = new Set(Object.keys(registry.agents || {}));
  if (!knownIds.has(payload.agent_identity_id)) {
    fail(`unknown 'agent_identity_id'. Expected one of: ${Array.from(knownIds).sort().join(", ")}`);
  }

  expectNonEmptyString(payload.objective, "objective");
  expectNonEmptyStringList(payload.success_criteria, "success_criteria");

  const outputFormat = expectObject(payload.output_format, "output_format");
  const extraOutput = Object.keys(outputFormat).filter((k) => !ALLOWED_OUTPUT_FORMAT_FIELDS.has(k)).sort();
  if (extraOutput.length) {
    fail(`output_format contains unsupported field(s): ${extraOutput.join(", ")}`);
  }
  const missingOutput = Array.from(REQUIRED_OUTPUT_FORMAT_FIELDS).filter((k) => !(k in outputFormat)).sort();
  if (missingOutput.length) {
    fail(`output_format missing required field(s): ${missingOutput.join(", ")}`);
  }
  expectNonEmptyString(outputFormat.type, "output_format.type");
  expectNonEmptyStringList(outputFormat.sections, "output_format.sections");

  const timeoutRetry = expectObject(payload.timeout_retry_policy, "timeout_retry_policy");
  const extraTimeout = Object.keys(timeoutRetry).filter((k) => !ALLOWED_TIMEOUT_FIELDS.has(k)).sort();
  if (extraTimeout.length) {
    fail(`timeout_retry_policy contains unsupported field(s): ${extraTimeout.join(", ")}`);
  }
  const missingTimeout = Array.from(REQUIRED_TIMEOUT_FIELDS).filter((k) => !(k in timeoutRetry)).sort();
  if (missingTimeout.length) {
    fail(`timeout_retry_policy missing required field(s): ${missingTimeout.join(", ")}`);
  }

  if (!Number.isInteger(timeoutRetry.timeout_seconds) || timeoutRetry.timeout_seconds <= 0) {
    fail("'timeout_retry_policy.timeout_seconds' must be a positive integer");
  }
  if (!Number.isInteger(timeoutRetry.max_retries) || timeoutRetry.max_retries < 0) {
    fail("'timeout_retry_policy.max_retries' must be a non-negative integer");
  }
  expectNonEmptyStringList(timeoutRetry.retry_on, "timeout_retry_policy.retry_on");
  expectNonEmptyStringList(timeoutRetry.escalate_on, "timeout_retry_policy.escalate_on");

  const callback = expectObject(payload.callback, "callback");
  const extraCallback = Object.keys(callback).filter((k) => !ALLOWED_CALLBACK_FIELDS.has(k)).sort();
  if (extraCallback.length) {
    fail(`callback contains unsupported field(s): ${extraCallback.join(", ")}`);
  }
  const missingCallback = Array.from(REQUIRED_CALLBACK_FIELDS).filter((k) => !(k in callback)).sort();
  if (missingCallback.length) {
    fail(`callback missing required field(s): ${missingCallback.join(", ")}`);
  }
  expectNonEmptyString(callback.update_channel, "callback.update_channel");

  const constraints = payload.constraints;
  if (constraints !== undefined) {
    const cobj = expectObject(constraints, "constraints");
    const extraConstraints = Object.keys(cobj).filter((k) => !ALLOWED_CONSTRAINT_FIELDS.has(k)).sort();
    if (extraConstraints.length) {
      fail(`constraints contains unsupported field(s): ${extraConstraints.join(", ")}`);
    }
    if ("workspace_root" in cobj) expectNonEmptyString(cobj.workspace_root, "constraints.workspace_root");
    if ("allowed_paths" in cobj) expectNonEmptyStringList(cobj.allowed_paths, "constraints.allowed_paths");
    if ("forbidden_actions" in cobj) {
      expectNonEmptyStringList(cobj.forbidden_actions, "constraints.forbidden_actions");
    }
  }

  const metadata = payload.metadata;
  if (metadata !== undefined) {
    const mobj = expectObject(metadata, "metadata");
    const extraMeta = Object.keys(mobj).filter((k) => !ALLOWED_METADATA_FIELDS.has(k)).sort();
    if (extraMeta.length) {
      fail(`metadata contains unsupported field(s): ${extraMeta.join(", ")}`);
    }
    if ("chain_id" in mobj) expectNonEmptyString(mobj.chain_id, "metadata.chain_id");
    if ("trace_id" in mobj) expectNonEmptyString(mobj.trace_id, "metadata.trace_id");
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error("Usage: validate_spawn_handshake.py <payload.json>");
    process.exit(2);
  }

  const payloadPath = path.resolve(args[0]);
  if (!fs.existsSync(payloadPath)) fail(`payload file not found: ${payloadPath}`);

  let payload: any;
  try {
    payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  } catch (err) {
    fail(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("payload root must be an object");
  }

  validate(payload as Record<string, any>);
  console.log("HANDSHAKE_VALID");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
