#!/usr/bin/env npx tsx
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectsSilentSuccess, getCommandJobSpec } from "./control-plane.js";

type CronJob = Record<string, unknown>;
type CronConfig = { jobs?: CronJob[] };
type InventoryRow = {
  id: string;
  name: string;
  enabled: boolean;
  included: boolean;
  reason: string;
  command: string | null;
  owner: string;
  timeoutSeconds: number | null;
  quietPath: string;
  migrationMode: "metadata-command-spec" | "candidate" | "excluded";
};

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const JUDGMENT_HEAVY = [
  /brief/i,
  /summary/i,
  /recap/i,
  /trading/i,
  /fitness/i,
  /whoop/i,
  /calendar/i,
  /reminders/i,
  /earnings/i,
  /morocco/i,
  /memory/i,
  /x session/i,
];

function parseArgs(argv: string[]): { repoRoot: string; json: boolean } {
  let repoRoot = process.env.CORTANA_SOURCE_REPO ?? DEFAULT_REPO_ROOT;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--repo-root" && argv[i + 1]) repoRoot = path.resolve(argv[++i]);
    else if (argv[i] === "--json") json = true;
  }
  return { repoRoot, json };
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function extractCommand(message: string): string | null {
  const patterns = [
    /First action:\s*exec exactly `([^`]+)`/i,
    /Run exactly:\s*`([^`]+)`/i,
    /Run `([^`]+)`/i,
    /Run:\s*([^\n]+)/i,
    /command:\s*([^\n]+)/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    const command = match?.[1]?.trim();
    if (command) return command;
  }
  return null;
}

export function inventoryCronJobs(config: CronConfig): InventoryRow[] {
  const jobs = Array.isArray(config.jobs) ? config.jobs : [];
  return jobs.map((job) => {
    const payload = toRecord(job.payload);
    const metadata = toRecord(job.metadata);
    const commandSpec = getCommandJobSpec(job);
    const message = text(payload?.message);
    const command = commandSpec ? [commandSpec.command, ...commandSpec.args].join(" ") : extractCommand(message);
    const name = text(job.name);
    const id = String(job.id ?? "");
    const owner = text(toRecord(job.delivery)?.accountId) || commandSpec?.owner || "monitor";
    const timeoutSeconds = Number(payload?.timeoutSeconds);
    const quietPath = commandSpec?.quietSuccess || (expectsSilentSuccess(job) ? "NO_REPLY" : "");
    const enabled = job.enabled !== false;

    if (!enabled && !commandSpec) {
      return { id, name, enabled, included: false, reason: "disabled job", command, owner, timeoutSeconds: Number.isFinite(timeoutSeconds) ? timeoutSeconds : null, quietPath, migrationMode: "excluded" };
    }

    if (commandSpec) {
      return {
        id,
        name,
        enabled,
        included: true,
        reason: "already carries metadata.commandJobSpec",
        command,
        owner,
        timeoutSeconds: Number.isFinite(timeoutSeconds) ? timeoutSeconds : Math.ceil(commandSpec.timeoutMs / 1000),
        quietPath,
        migrationMode: "metadata-command-spec",
      };
    }

    if (payload?.kind !== "agentTurn") {
      return { id, name, enabled, included: false, reason: "not an agentTurn cron", command: null, owner, timeoutSeconds: null, quietPath: "", migrationMode: "excluded" };
    }
    if (!command) {
      return { id, name, enabled, included: false, reason: "no fixed command found", command: null, owner, timeoutSeconds: Number.isFinite(timeoutSeconds) ? timeoutSeconds : null, quietPath, migrationMode: "excluded" };
    }
    if (!quietPath) {
      return { id, name, enabled, included: false, reason: "quiet success contract is unclear", command, owner, timeoutSeconds: Number.isFinite(timeoutSeconds) ? timeoutSeconds : null, quietPath, migrationMode: "excluded" };
    }
    if (JUDGMENT_HEAVY.some((pattern) => pattern.test(name))) {
      return { id, name, enabled, included: false, reason: "excluded as judgment-heavy or user-facing", command, owner, timeoutSeconds: Number.isFinite(timeoutSeconds) ? timeoutSeconds : null, quietPath, migrationMode: "excluded" };
    }

    return {
      id,
      name,
      enabled,
      included: true,
      reason: "fixed command with quiet-path contract",
      command,
      owner,
      timeoutSeconds: Number.isFinite(timeoutSeconds) ? timeoutSeconds : null,
      quietPath,
      migrationMode: "candidate",
    };
  });
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const file = path.join(args.repoRoot, "config", "cron", "jobs.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as CronConfig;
  const rows = inventoryCronJobs(config);

  if (args.json) {
    console.log(JSON.stringify({ total: rows.length, included: rows.filter((row) => row.included).length, rows }, null, 2));
    return;
  }

  for (const row of rows) {
    if (!row.included) continue;
    console.log(`${row.id}\t${row.name}\t${row.migrationMode}\t${row.command}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
