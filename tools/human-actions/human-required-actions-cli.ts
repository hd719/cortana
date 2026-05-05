#!/usr/bin/env npx tsx
import {
  closeHumanRequiredAction,
  digestHumanRequiredActions,
  fixtureInput,
  listHumanRequiredActions,
  upsertHumanRequiredAction,
  verifyHumanRequiredAction,
  type HumanRequiredActionInput,
} from "./human-required-actions.js";
import { normalizeHumanActionStatus } from "./human-required-taxonomy.js";

type Args = {
  command: string;
  json: boolean;
  status: string;
  limit: number;
  id: number | null;
  fixture: string | null;
  inputJson: string | null;
  reason: string;
  note: string | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: argv[0] ?? "list",
    json: false,
    status: "open",
    limit: 50,
    id: null,
    fixture: null,
    inputJson: null,
    reason: "resolved",
    note: null,
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--status" && argv[i + 1]) args.status = argv[++i];
    else if (arg === "--limit" && argv[i + 1]) args.limit = Number(argv[++i]);
    else if (arg === "--id" && argv[i + 1]) args.id = Number(argv[++i]);
    else if (arg === "--fixture" && argv[i + 1]) args.fixture = argv[++i];
    else if (arg === "--input-json" && argv[i + 1]) args.inputJson = argv[++i];
    else if (arg === "--reason" && argv[i + 1]) args.reason = argv[++i];
    else if (arg === "--note" && argv[i + 1]) args.note = argv[++i];
  }

  return args;
}

function print(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (typeof value === "string") {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value));
}

function inputFromArgs(args: Args): HumanRequiredActionInput {
  if (args.fixture) return fixtureInput(args.fixture);
  if (args.inputJson) return JSON.parse(args.inputJson) as HumanRequiredActionInput;
  throw new Error("upsert requires --fixture <name> or --input-json <json>");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "upsert") {
    const result = upsertHumanRequiredAction(inputFromArgs(args));
    print(result, true);
    return;
  }

  if (args.command === "list") {
    const status = args.status === "all" ? "all" : normalizeHumanActionStatus(args.status);
    const rows = listHumanRequiredActions({ status, limit: args.limit });
    if (args.json) {
      print({ ok: true, count: rows.length, items: rows }, true);
      return;
    }
    if (rows.length === 0) {
      console.log("NO_REPLY");
      return;
    }
    for (const row of rows) {
      console.log(`#${row.id} [${row.severity}] ${row.system}: ${row.summary}`);
      console.log(`  next: ${row.required_action}`);
    }
    return;
  }

  if (args.command === "digest") {
    print(digestHumanRequiredActions({ limit: args.limit }), args.json);
    return;
  }

  if (args.command === "close") {
    if (!args.id || !Number.isFinite(args.id)) throw new Error("close requires --id <id>");
    const status = normalizeHumanActionStatus(args.reason);
    if (status === "open") throw new Error("close reason cannot be open");
    const row = closeHumanRequiredAction(args.id, { status, resolvedBy: "monitor", note: args.note });
    print({ ok: true, item: row }, true);
    return;
  }

  if (args.command === "verify") {
    if (!args.id || !Number.isFinite(args.id)) throw new Error("verify requires --id <id>");
    const result = verifyHumanRequiredAction(args.id);
    print(result, true);
    process.exit(result.ok ? 0 : 1);
  }

  throw new Error(`unknown command: ${args.command}`);
}

main();
