#!/usr/bin/env npx tsx
import db from "../lib/db.js";
const { runPsql, withPostgresPath } = db;

function usage(): void {
  console.error("Usage: resolve-approval.ts <approval_id> <action> [reason]");
}

const argv = process.argv.slice(2);
if (argv.length < 2) {
  usage();
  process.exit(1);
}

const approvalId = argv[0] ?? "";
const action = (argv[1] ?? "").toLowerCase();
const reason = argv[2] ?? "";

const uuidRegex =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

if (!uuidRegex.test(approvalId)) {
  console.error("Error: approval_id must be a UUID");
  process.exit(1);
}

let newStatus = "";
let eventType = "";
if (action === "approve") {
  newStatus = "approved";
  eventType = "approved";
} else if (action === "reject") {
  newStatus = "rejected";
  eventType = "rejected";
} else {
  console.error("Error: action must be approve|reject");
  process.exit(1);
}

const safeReason = reason.replace(/'/g, "''");

const exists = runPsql(`SELECT COUNT(*) FROM mc_approval_requests WHERE id = '${approvalId}'::uuid;`, {
  db: "cortana",
  args: ["-t", "-A"],
  env: withPostgresPath(process.env),
  stdio: ["ignore", "pipe", "pipe"],
});

const existsCount = (exists.stdout ?? "").toString().trim();
if (exists.status !== 0 || existsCount !== "1") {
  console.error(`Error: approval request not found: ${approvalId}`);
  process.exit(1);
}

const res = runPsql(
  `
UPDATE mc_approval_requests
SET
  status = '${newStatus}',
  approved_at = CASE WHEN '${newStatus}' = 'approved' THEN NOW() ELSE approved_at END,
  rejected_at = CASE WHEN '${newStatus}' = 'rejected' THEN NOW() ELSE rejected_at END,
  approved_by = CASE WHEN '${newStatus}' = 'approved' THEN COALESCE(approved_by, 'user') ELSE approved_by END,
  rejected_by = CASE WHEN '${newStatus}' = 'rejected' THEN COALESCE(rejected_by, 'user') ELSE rejected_by END,
  decision = COALESCE(decision, '{}'::jsonb) || jsonb_build_object('action', '${action}', 'reason', NULLIF('${safeReason}', ''))
WHERE id = '${approvalId}'::uuid;

INSERT INTO mc_approval_events (approval_id, event_type, actor, payload)
VALUES (
  '${approvalId}'::uuid,
  '${eventType}',
  'user',
  jsonb_build_object('reason', NULLIF('${safeReason}', ''))
);
`,
  {
    db: "cortana",
    env: withPostgresPath(process.env),
    stdio: ["ignore", "ignore", "pipe"],
  }
);

if (res.status !== 0) {
  process.exit(1);
}

console.log(`OK ${approvalId} ${newStatus}`);
