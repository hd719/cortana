#!/usr/bin/env npx tsx

import path from "path";
import { pathToFileURL } from "url";
import { query } from "../lib/db.js";
import {
  assertCategory,
  sqlEscape,
  type Category,
  type Priority,
  type Status,
} from "./decision-utils.js";

export type PendingDecision = {
  id: number;
  created_at: string;
  category: Category;
  summary: string;
  details: unknown;
  status: Status;
  priority: Priority;
  expires_at: string | null;
  age_hours: number;
  expired: boolean;
  flag: string | null;
};

function runPsql(sql: string): string {
  return query(sql).trim();
}

function fetchJson(sql: string): Array<Record<string, any>> {
  const wrapped = `SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (${sql}) t;`;
  const raw = runPsql(wrapped);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Array<Record<string, any>>) : [];
  } catch {
    return [];
  }
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseIso(value: unknown): string {
  return value == null ? "" : String(value);
}

export function checkPendingDecisions(category?: string): PendingDecision[] {
  if (category) {
    assertCategory(category);
  }

  const whereCategory = category ? `AND category = '${sqlEscape(category)}'` : "";
  const rows = fetchJson(
    "SELECT id, created_at, category, summary, details, status, priority, expires_at " +
      "FROM cortana_decisions " +
      "WHERE status = 'pending' " +
      `${whereCategory} ` +
      "ORDER BY created_at ASC"
  );

  const nowMs = Date.now();

  return rows.map((row) => {
    const createdAt = parseIso(row.created_at);
    const expiresAt = row.expires_at == null ? null : parseIso(row.expires_at);
    const createdMs = createdAt ? Date.parse(createdAt) : nowMs;
    const expiresMs = expiresAt ? Date.parse(expiresAt) : NaN;
    const ageHours = Math.max(0, (nowMs - createdMs) / 3_600_000);
    const expired = Number.isFinite(expiresMs) && expiresMs <= nowMs;

    return {
      id: toNumber(row.id),
      created_at: createdAt,
      category: row.category as Category,
      summary: String(row.summary ?? ""),
      details: row.details ?? null,
      status: row.status as Status,
      priority: row.priority as Priority,
      expires_at: expiresAt,
      age_hours: Number(ageHours.toFixed(2)),
      expired,
      flag: expired ? "EXPIRED - NEEDS ATTENTION" : null,
    };
  });
}

function formatDecisionLine(d: PendingDecision): string {
  const flag = d.flag ? `${d.flag} ` : "";
  const expires = d.expires_at ? `expires ${d.expires_at}` : "no expiry";
  return `${flag}#${d.id} [${d.category}] [${d.priority}] ${d.summary} (${d.age_hours}h; ${expires})`;
}

function usage(): void {
  const script = path.basename(process.argv[1] ?? "check-pending.ts");
  process.stderr.write(`Usage: ${script} [category] [--json]\n`);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let category: string | undefined;
  let jsonOutput = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--json") {
      jsonOutput = true;
      continue;
    }
    if (arg === "--category") {
      category = argv[i + 1];
      i += 1;
      continue;
    }
    if (!category) {
      category = arg;
      continue;
    }
    usage();
    return 1;
  }

  try {
    const pending = checkPendingDecisions(category);

    if (jsonOutput) {
      const payload = {
        ok: true,
        now: new Date().toISOString(),
        count: pending.length,
        pending,
      };
      process.stdout.write(`${JSON.stringify(payload)}\n`);
      return 0;
    }

    if (pending.length === 0) {
      process.stdout.write("No pending decisions.\n");
      return 0;
    }

    process.stdout.write(`Pending decisions: ${pending.length}\n`);
    for (const decision of pending) {
      process.stdout.write(`${formatDecisionLine(decision)}\n`);
    }

    return 0;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${msg}\n`);
    return 1;
  }
}

const invoked = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : "";

if (import.meta.url === invoked) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
