#!/usr/bin/env npx tsx

import path from "path";
import { pathToFileURL } from "url";
import { query } from "../lib/db.js";
import {
  assertCategory,
  assertPriority,
  ensureNonEmpty,
  parseExpiresMinutes,
  parseJsonArgument,
  sqlEscape,
  type Category,
  type Priority,
} from "./decision-utils.js";

export function logDecision(
  category: string,
  priority: string,
  summary: string,
  details?: unknown,
  expiresMinutes?: number
): number {
  assertCategory(category);
  assertPriority(priority);
  ensureNonEmpty(summary, "summary");

  const detailsExpr =
    details === undefined
      ? "NULL"
      : `'${sqlEscape(JSON.stringify(details))}'::jsonb`;
  const expiresExpr =
    typeof expiresMinutes === "number"
      ? `NOW() + INTERVAL '${expiresMinutes} minutes'`
      : "NULL";

  const sql = `
INSERT INTO cortana_decisions (
  category,
  summary,
  details,
  priority,
  expires_at,
  metadata
) VALUES (
  '${sqlEscape(category)}',
  '${sqlEscape(summary)}',
  ${detailsExpr},
  '${sqlEscape(priority)}',
  ${expiresExpr},
  jsonb_build_object('logged_by', 'tools/decisions/log-decision.ts')
)
RETURNING id;
`;

  const raw = query(sql).trim();
  if (!raw) {
    throw new Error("Failed to insert decision");
  }
  const id = Number(raw);
  if (!Number.isFinite(id)) {
    throw new Error(`Invalid id returned: ${raw}`);
  }
  return id;
}

function usage(): void {
  const script = path.basename(process.argv[1] ?? "log-decision.ts");
  process.stderr.write(
    `Usage: ${script} <category> <priority> <summary> [details_json] [expires_minutes]\n`
  );
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length < 3) {
    usage();
    return 1;
  }

  const category = argv[0] ?? "";
  const priority = argv[1] ?? "";
  const summary = argv[2] ?? "";
  const detailsRaw = argv[3];
  const expiresRaw = argv[4];

  try {
    const details = parseJsonArgument(detailsRaw);
    const expiresMinutes = parseExpiresMinutes(expiresRaw);
    const id = logDecision(
      category as Category,
      priority as Priority,
      summary,
      details,
      expiresMinutes
    );
    process.stdout.write(`${id}\n`);
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
