#!/usr/bin/env npx tsx

/** Validate Covenant status/completion protocol payloads. */

import fs from "fs";
import path from "path";
import { resolveRepoPath } from "../lib/paths.js";

const WORKSPACE_ROOT = resolveRepoPath();
const SCHEMA_PATH = path.join(WORKSPACE_ROOT, "agents", "identities", "schema.json");
const STATUS_PREFIX = "COVENANT_STATUS_JSON:";
const COMPLETION_PREFIX = "COVENANT_COMPLETION_JSON:";
const KNOWN_IDENTITIES = new Set([
  "agent.monitor.v1",
  "agent.huragok.v1",
  "agent.researcher.v1",
  "agent.oracle.v1",
  "agent.librarian.v1",
]);

class ValidationError extends Error {}

type Json = Record<string, any>;

function fail(msg: string): never {
  console.error(`PROTOCOL_INVALID: ${msg}`);
  process.exit(1);
}

function loadJson(filePath: string, label: string): any {
  if (!fs.existsSync(filePath)) throw new ValidationError(`${label} not found: ${filePath}`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new ValidationError(`${label} invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function expectDict(value: any, field: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`'${field}' must be an object`);
  }
  return value as Json;
}

function expectStr(value: any, field: string, minLen = 1): void {
  if (typeof value !== "string" || value.trim().length < minLen) {
    throw new ValidationError(`'${field}' must be a non-empty string`);
  }
}

function expectNumRange(value: any, field: string, lo: number, hi: number): void {
  if (typeof value !== "number") throw new ValidationError(`'${field}' must be a number`);
  if (value < lo || value > hi) throw new ValidationError(`'${field}' must be between ${lo} and ${hi}`);
}

function expectIntMin(value: any, field: string, minValue: number): void {
  if (!Number.isInteger(value) || value < minValue) {
    throw new ValidationError(`'${field}' must be an integer >= ${minValue}`);
  }
}

function expectArray(value: any, field: string): any[] {
  if (!Array.isArray(value)) throw new ValidationError(`'${field}' must be an array`);
  return value;
}

function expectArrayOfStrings(value: any, field: string): void {
  const arr = expectArray(value, field);
  arr.forEach((item, idx) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new ValidationError(`'${field}[${idx}]' must be a non-empty string`);
    }
  });
}

function enforceNoExtra(payload: Json, allowed: Set<string>, label: string): void {
  const extra = Object.keys(payload).filter((k) => !allowed.has(k)).sort();
  if (extra.length) {
    throw new ValidationError(`${label} contains unsupported field(s): ${extra.join(", ")}`);
  }
}

function loadSchemaDefs(): Json {
  const schema = loadJson(SCHEMA_PATH, "schema");
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new ValidationError("schema root must be an object");
  }
  const defs = schema.$defs;
  if (!defs || typeof defs !== "object" || Array.isArray(defs)) {
    throw new ValidationError("schema missing $defs");
  }
  return defs as Json;
}

function validateStatus(payload: Json, defs: Json): void {
  const statusDef = expectDict(defs.status_update, "$defs.status_update");
  const allowed = new Set(Object.keys(statusDef.properties ?? {}));
  const required = new Set(statusDef.required ?? []);

  const missing = [...required].filter((k) => !(k in payload)).sort();
  if (missing.length) {
    throw new ValidationError(`status missing required field(s): ${missing.join(", ")}`);
  }
  enforceNoExtra(payload, allowed, "status");

  expectStr(payload.request_id, "request_id");
  expectStr(payload.agent_identity_id, "agent_identity_id");
  if (!KNOWN_IDENTITIES.has(payload.agent_identity_id)) {
    throw new ValidationError("'agent_identity_id' must be a known Covenant identity");
  }

  const state = payload.state;
  const allowedStates = new Set(statusDef.properties?.state?.enum ?? []);
  if (typeof state !== "string" || !allowedStates.has(state)) {
    throw new ValidationError(`'state' must be one of: ${Array.from(allowedStates).sort().join(", ")}`);
  }

  expectNumRange(payload.confidence, "confidence", 0.0, 1.0);
  expectStr(payload.timestamp, "timestamp");

  if ("blockers" in payload) expectArray(payload.blockers, "blockers");
  if ("evidence" in payload) expectArrayOfStrings(payload.evidence, "evidence");
  if ("next_action" in payload) expectStr(payload.next_action, "next_action");
  if ("eta_seconds" in payload) expectIntMin(payload.eta_seconds, "eta_seconds", 0);
}

function validateCompletion(payload: Json, defs: Json): void {
  const completionDef = expectDict(defs.completion, "$defs.completion");
  const allowed = new Set(Object.keys(completionDef.properties ?? {}));
  const required = new Set(completionDef.required ?? []);

  const missing = [...required].filter((k) => !(k in payload)).sort();
  if (missing.length) {
    throw new ValidationError(`completion missing required field(s): ${missing.join(", ")}`);
  }
  enforceNoExtra(payload, allowed, "completion");

  expectStr(payload.request_id, "request_id");
  expectStr(payload.agent_identity_id, "agent_identity_id");
  if (!KNOWN_IDENTITIES.has(payload.agent_identity_id)) {
    throw new ValidationError("'agent_identity_id' must be a known Covenant identity");
  }

  if (payload.state !== "completed") {
    throw new ValidationError("completion 'state' must be 'completed'");
  }

  expectStr(payload.summary, "summary");
  expectArray(payload.artifacts, "artifacts");
  expectArrayOfStrings(payload.risks, "risks");
  expectArrayOfStrings(payload.follow_ups, "follow_ups");
  expectNumRange(payload.confidence, "confidence", 0.0, 1.0);
  expectStr(payload.timestamp, "timestamp");
}

function extractLineJson(text: string, prefix: string): Json | null {
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(prefix)) {
      const raw = line.slice(prefix.length).trim();
      let obj: any;
      try {
        obj = JSON.parse(raw);
      } catch (err) {
        throw new ValidationError(`invalid JSON after '${prefix}': ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        throw new ValidationError(`payload after '${prefix}' must be a JSON object`);
      }
      return obj as Json;
    }
  }
  return null;
}

function validateExtracted(filePath: string, defs: Json): void {
  if (!fs.existsSync(filePath)) throw new ValidationError(`extract file not found: ${filePath}`);
  const text = fs.readFileSync(filePath, "utf8");

  const status = extractLineJson(text, STATUS_PREFIX);
  const completion = extractLineJson(text, COMPLETION_PREFIX);

  if (!status) throw new ValidationError(`missing '${STATUS_PREFIX}' line`);
  if (!completion) throw new ValidationError(`missing '${COMPLETION_PREFIX}' line`);

  validateStatus(status, defs);
  validateCompletion(completion, defs);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const payload = args.find((a) => !a.startsWith("--"));
  const typeIdx = args.indexOf("--type");
  const extractIdx = args.indexOf("--extract");
  const type = typeIdx >= 0 ? args[typeIdx + 1] : undefined;
  const extract = extractIdx >= 0 ? args[extractIdx + 1] : undefined;

  if (!!extract === !!type) {
    console.error(
      "Usage: validate_agent_protocol.py --type <status|completion> <payload.json>\n" +
        "   or: validate_agent_protocol.py --extract <agent-output.txt>"
    );
    process.exit(2);
  }

  const defs = loadSchemaDefs();

  try {
    if (extract) {
      validateExtracted(path.resolve(extract), defs);
      console.log("PROTOCOL_VALID: extracted status/completion payloads");
      return;
    }

    if (!payload) throw new ValidationError("missing payload path");
    const payloadPath = path.resolve(payload);
    const obj = loadJson(payloadPath, "payload");
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      throw new ValidationError("payload root must be an object");
    }

    if (type === "status") {
      validateStatus(obj, defs);
      console.log("STATUS_VALID");
    } else {
      validateCompletion(obj, defs);
      console.log("COMPLETION_VALID");
    }
  } catch (err) {
    if (err instanceof ValidationError) fail(err.message);
    throw err;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
