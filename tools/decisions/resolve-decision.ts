#!/usr/bin/env npx tsx

import path from "path";
import { pathToFileURL } from "url";
import { query } from "../lib/db.js";
import {
  assertStatus,
  ensureNonEmpty,
  sqlEscape,
  type Status,
} from "./decision-utils.js";

export function resolveDecision(id: number, status: string, outcome: string): number {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid id: ${id}`);
  }
  assertStatus(status);
  ensureNonEmpty(outcome, "outcome");

  const sql = `
UPDATE cortana_decisions
SET
  status='${sqlEscape(status)}',
  resolved_at=NOW(),
  outcome='${sqlEscape(outcome)}'
WHERE id=${id}
RETURNING id;
`;

  const raw = query(sql).trim();
  if (!raw) {
    throw new Error(`Decision not found: ${id}`);
  }
  const resolvedId = Number(raw);
  if (!Number.isFinite(resolvedId)) {
    throw new Error(`Invalid id returned: ${raw}`);
  }
  return resolvedId;
}

function usage(): void {
  const script = path.basename(process.argv[1] ?? "resolve-decision.ts");
  process.stderr.write(`Usage: ${script} <id> <status> <outcome>\n`);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length < 3) {
    usage();
    return 1;
  }

  const id = Number.parseInt(argv[0] ?? "", 10);
  const status = argv[1] ?? "";
  const outcome = argv.slice(2).join(" ");

  try {
    const resolvedId = resolveDecision(id, status as Status, outcome);
    process.stdout.write(`${resolvedId}\n`);
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
