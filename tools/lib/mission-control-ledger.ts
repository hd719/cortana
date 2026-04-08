import { runPsql, withPostgresPath } from "./db.js";

type FeedbackInput = {
  source: string;
  category: string;
  severity: string;
  summary: string;
  details?: Record<string, unknown>;
  recurrenceKey?: string | null;
  status?: string;
  taskId?: string | null;
  agentId?: string | null;
};

type ApprovalInput = {
  agentId: string;
  actionType: string;
  proposal: Record<string, unknown>;
  rationale?: string | null;
  riskLevel: string;
  autoApprovable?: boolean;
  status?: string;
  expiresAtHours?: number | null;
  resumePayload?: Record<string, unknown> | null;
};

function esc(value: string): string {
  return value.replace(/'/g, "''");
}

function sqlString(value: string | null | undefined): string {
  if (value == null) return "NULL";
  return `'${esc(value)}'`;
}

function sqlJson(value: Record<string, unknown> | null | undefined): string {
  if (value == null) return "NULL";
  return `'${esc(JSON.stringify(value))}'::jsonb`;
}

function normalizeRiskLevel(value: string): string {
  const risk = value.trim().toLowerCase();
  if (risk === "p0" || risk === "critical") return "p0";
  if (risk === "p1" || risk === "high") return "p1";
  if (risk === "p2" || risk === "medium") return "p2";
  return "p3";
}

function runValue(sql: string): string {
  const result = runPsql(sql, {
    db: process.env.DB_NAME || "cortana",
    args: ["-q", "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A"],
    env: withPostgresPath(process.env),
  });
  if ((result.status ?? 1) !== 0) {
    const message = String(result.stderr || result.stdout || "psql failed").trim();
    throw new Error(message || "psql failed");
  }
  return String(result.stdout || "").trim();
}

export function insertFeedbackItem(input: FeedbackInput): string {
  const details = {
    ...(input.details ?? {}),
    feedback_type: (input.details?.feedback_type ?? input.category) as unknown,
  };
  const sql = `
WITH inserted AS (
  INSERT INTO mc_feedback_items (
    task_id,
    agent_id,
    source,
    category,
    severity,
    summary,
    details,
    recurrence_key,
    status,
    remediation_status
  )
  VALUES (
    ${sqlString(input.taskId ?? null)}::uuid,
    ${sqlString(input.agentId ?? null)},
    ${sqlString(input.source)},
    ${sqlString(input.category)},
    ${sqlString(input.severity)},
    ${sqlString(input.summary)},
    ${sqlJson(details)},
    ${sqlString(input.recurrenceKey ?? null)},
    ${sqlString(input.status ?? "new")},
    'open'
  )
  RETURNING id
)
SELECT id::text FROM inserted;
`;
  return runValue(sql);
}

export function createApprovalRequest(input: ApprovalInput): string {
  const expirySql = input.expiresAtHours && input.expiresAtHours > 0
    ? `NOW() + INTERVAL '${Math.trunc(input.expiresAtHours)} hours'`
    : "NULL";
  const sql = `
WITH inserted AS (
  INSERT INTO mc_approval_requests (
    agent_id,
    action_type,
    proposal,
    rationale,
    risk_level,
    auto_approvable,
    status,
    expires_at,
    resume_payload
  )
  VALUES (
    ${sqlString(input.agentId)},
    ${sqlString(input.actionType)},
    ${sqlJson(input.proposal)},
    ${sqlString(input.rationale ?? null)},
    ${sqlString(normalizeRiskLevel(input.riskLevel))},
    ${input.autoApprovable ? "TRUE" : "FALSE"},
    ${sqlString(input.status ?? "pending")},
    ${expirySql},
    ${sqlJson(input.resumePayload ?? null)}
  )
  RETURNING id
), ev AS (
  INSERT INTO mc_approval_events (approval_id, event_type, actor, payload)
  SELECT id, 'created', ${sqlString(input.agentId)}, ${sqlJson({ source: 'approval-gate' })}
  FROM inserted
)
SELECT id::text FROM inserted;
`;
  return runValue(sql);
}

export function recordApprovalDecision(
  approvalId: string,
  action: "approved" | "rejected" | "expired",
  actor: string,
  reason?: string | null,
): void {
  const payload = reason ? { reason } : {};
  const decision = { action, ...(reason ? { reason } : {}) };
  const sql = `
UPDATE mc_approval_requests
SET
  status = ${sqlString(action)},
  decision = COALESCE(decision, '{}'::jsonb) || ${sqlJson(decision)},
  approved_by = CASE WHEN ${sqlString(action)} = 'approved' THEN COALESCE(approved_by, ${sqlString(actor)}) ELSE approved_by END,
  approved_at = CASE WHEN ${sqlString(action)} = 'approved' THEN COALESCE(approved_at, NOW()) ELSE approved_at END,
  rejected_by = CASE WHEN ${sqlString(action)} = 'rejected' THEN COALESCE(rejected_by, ${sqlString(actor)}) ELSE rejected_by END,
  rejected_at = CASE WHEN ${sqlString(action)} = 'rejected' THEN COALESCE(rejected_at, NOW()) ELSE rejected_at END
WHERE id = ${sqlString(approvalId)}::uuid;

INSERT INTO mc_approval_events (approval_id, event_type, actor, payload)
VALUES (${sqlString(approvalId)}::uuid, ${sqlString(action)}, ${sqlString(actor)}, ${sqlJson(payload)});
`;
  runValue(sql);
}
