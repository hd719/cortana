#!/usr/bin/env npx tsx

import fs from "node:fs";
import path from "node:path";
import { getScriptDir } from "../lib/paths.js";
import { runPsql } from "../lib/db.js";
type GovernorDecision = {
  task_id: number | null;
  action_type: string;
  risk_score: number;
  threshold: number;
  requires_human_approval: boolean;
  decision: "approved" | "escalated" | "denied";
  rationale: string;
  queued_for_approval: boolean;
  metadata: Record<string, unknown>;
};

const DEFAULT_POLICY_FILE = path.join(getScriptDir(import.meta.url), "policy.json");

class RiskScorer {
  policy: Record<string, any>;
  actionTypes: Record<string, Record<string, any>>;
  autoApproveThreshold: number;
  defaultActionType: string;
  denyUnknownActionType: boolean;
  commandHints: Array<Record<string, string>>;

  constructor(policyFile: string) {
    const raw = fs.readFileSync(policyFile, "utf8");
    this.policy = JSON.parse(raw) as Record<string, any>;
    this.actionTypes = this.policy.action_types ?? {};
    this.autoApproveThreshold = Number(this.policy.auto_approve_threshold ?? 0.5);
    this.defaultActionType = String(this.policy.default_action_type ?? "internal-write");
    this.denyUnknownActionType = Boolean(this.policy.deny_unknown_action_type ?? true);
    this.commandHints = Array.isArray(this.policy.command_action_hints) ? this.policy.command_action_hints : [];
  }

  inferActionType(task: Record<string, any>): string {
    const metadata = task.metadata ?? {};
    const execMeta = metadata.exec ?? {};

    for (const key of ["action_type", "risk_action_type"]) {
      if (metadata[key]) return String(metadata[key]);
      if (execMeta[key]) return String(execMeta[key]);
    }

    const cmd = String(execMeta.command ?? task.execution_plan ?? "").trim();
    for (const hint of this.commandHints) {
      const pattern = hint.pattern;
      const actionType = hint.action_type;
      if (!pattern || !actionType) continue;
      if (new RegExp(pattern).test(cmd)) return actionType;
    }

    return this.defaultActionType;
  }

  evaluateTask(task: Record<string, any>, actor = "auto-executor"): GovernorDecision {
    let actionType = this.inferActionType(task);
    let policy = this.actionTypes[actionType];
    if (!policy) {
      if (this.denyUnknownActionType) {
        return {
          task_id: task.id ?? null,
          action_type: actionType,
          risk_score: 1.0,
          threshold: this.autoApproveThreshold,
          requires_human_approval: true,
          decision: "denied",
          rationale: `Unknown action_type '${actionType}' and deny_unknown_action_type=true`,
          queued_for_approval: false,
          metadata: { actor, policy_version: this.policy.version ?? 1 },
        };
      }
      policy = this.actionTypes[this.defaultActionType];
      actionType = this.defaultActionType;
    }

    const riskScore = Number(policy?.risk_score ?? 1.0);
    const requiresHumanApproval = Boolean(policy?.requires_human_approval ?? false);

    let decision: GovernorDecision["decision"];
    let queuedForApproval: boolean;
    let rationale: string;

    if (requiresHumanApproval || riskScore >= this.autoApproveThreshold) {
      decision = "escalated";
      queuedForApproval = true;
      rationale = `risk=${riskScore.toFixed(2)} >= threshold=${this.autoApproveThreshold.toFixed(2)} or action explicitly requires human approval`;
    } else {
      decision = "approved";
      queuedForApproval = false;
      rationale = `risk=${riskScore.toFixed(2)} < threshold=${this.autoApproveThreshold.toFixed(2)}; auto-approved`;
    }

    return {
      task_id: task.id ?? null,
      action_type: actionType,
      risk_score: riskScore,
      threshold: this.autoApproveThreshold,
      requires_human_approval: requiresHumanApproval,
      decision,
      rationale,
      queued_for_approval: queuedForApproval,
      metadata: { actor, policy_version: this.policy.version ?? 1 },
    };
  }
}

function sqlStr(value: string): string {
  return value.replace(/'/g, "''");
}

function runPsqlChecked(db: string, sql: string): void {
  const proc = runPsql(sql, { db, args: ["-v", "ON_ERROR_STOP=1"], stdio: "pipe" });
  if (proc.status !== 0) {
    throw new Error((proc.stderr || "").trim() || (proc.stdout || "").trim() || "psql failed");
  }
}

function logDecision(db: string, dec: GovernorDecision): void {
  const metadataJson = sqlStr(JSON.stringify(dec.metadata, null, 0));
  const rationale = sqlStr(dec.rationale);
  const actionType = sqlStr(dec.action_type);
  const decision = sqlStr(dec.decision);
  const taskIdSql = dec.task_id === null ? "NULL" : String(Number(dec.task_id));

  const sql = `
    INSERT INTO cortana_governor_decisions (
      task_id, action_type, risk_score, threshold, requires_human_approval,
      decision, rationale, queued_for_approval, metadata
    ) VALUES (
      ${taskIdSql}, '${actionType}', ${dec.risk_score}, ${dec.threshold}, ${dec.requires_human_approval
        .toString()
        .toUpperCase()},
      '${decision}', '${rationale}', ${dec.queued_for_approval.toString().toUpperCase()}, '${metadataJson}'::jsonb
    );
    `;
  runPsqlChecked(db, sql);
}

function updateTaskQueueState(db: string, dec: GovernorDecision): void {
  if (dec.task_id === null || dec.decision !== "escalated") return;
  const rationale = sqlStr(`Queued for human approval by governor: ${dec.rationale}`);
  const sql = `
    UPDATE cortana_tasks
    SET status='ready',
        assigned_to='governor',
        outcome='${rationale}',
        metadata = COALESCE(metadata, '{}'::jsonb)
            || jsonb_build_object(
                'governor', jsonb_build_object(
                    'decision', '${sqlStr(dec.decision)}',
                    'action_type', '${sqlStr(dec.action_type)}',
                    'risk_score', ${dec.risk_score},
                    'threshold', ${dec.threshold},
                    'queued_for_approval', true,
                    'evaluated_at', NOW()::text
                )
            )
    WHERE id=${Number(dec.task_id)};
    `;
  runPsqlChecked(db, sql);
}

function updateTaskDeniedState(db: string, dec: GovernorDecision): void {
  if (dec.task_id === null || dec.decision !== "denied") return;
  const rationale = sqlStr(`Denied by governor: ${dec.rationale}`);
  const sql = `
    UPDATE cortana_tasks
    SET status='cancelled',
        assigned_to='governor',
        outcome='${rationale}',
        completed_at=NOW(),
        metadata = COALESCE(metadata, '{}'::jsonb)
            || jsonb_build_object(
                'governor', jsonb_build_object(
                    'decision', '${sqlStr(dec.decision)}',
                    'action_type', '${sqlStr(dec.action_type)}',
                    'risk_score', ${dec.risk_score},
                    'threshold', ${dec.threshold},
                    'queued_for_approval', false,
                    'evaluated_at', NOW()::text
                )
            )
    WHERE id=${Number(dec.task_id)};
    `;
  runPsqlChecked(db, sql);
}

function stringifySortedCompact(value: any): string {
  const seen = new WeakSet();
  const render = (val: any): string => {
    if (val === null || val === undefined) return "null";
    if (typeof val === "number" || typeof val === "boolean") return String(val);
    if (typeof val === "string") return JSON.stringify(val);
    if (Array.isArray(val)) {
      return `[${val.map((v) => render(v)).join(", ")}]`;
    }
    if (typeof val === "object") {
      if (seen.has(val)) return "{}";
      seen.add(val);
      const keys = Object.keys(val).sort();
      const body = keys.map((k) => `${JSON.stringify(k)}: ${render(val[k])}`).join(", ");
      return `{${body}}`;
    }
    return JSON.stringify(String(val));
  };
  return render(value);
}

function parseArgs(argv: string[]) {
  const args = {
    policy: DEFAULT_POLICY_FILE,
    db: "cortana",
    taskJson: "",
    actor: "auto-executor",
    log: false,
    applyTaskState: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--policy") {
      args.policy = argv[++i] ?? args.policy;
    } else if (a === "--db") {
      args.db = argv[++i] ?? args.db;
    } else if (a === "--task-json") {
      args.taskJson = argv[++i] ?? "";
    } else if (a === "--actor") {
      args.actor = argv[++i] ?? args.actor;
    } else if (a === "--log") {
      args.log = true;
    } else if (a === "--apply-task-state") {
      args.applyTaskState = true;
    }
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.taskJson) {
    console.error("--task-json is required");
    return 2;
  }

  const task = JSON.parse(args.taskJson) as Record<string, any>;
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new Error("task-json must decode to an object");
  }

  const scorer = new RiskScorer(args.policy);
  const decision = scorer.evaluateTask(task, args.actor);

  if (args.log) {
    logDecision(args.db, decision);
  }

  if (args.applyTaskState) {
    updateTaskQueueState(args.db, decision);
    updateTaskDeniedState(args.db, decision);
  }

  const payload = {
    timestamp: new Date().toISOString(),
    task_id: decision.task_id,
    action_type: decision.action_type,
    risk_score: decision.risk_score,
    threshold: decision.threshold,
    requires_human_approval: decision.requires_human_approval,
    decision: decision.decision,
    rationale: decision.rationale,
    queued_for_approval: decision.queued_for_approval,
    metadata: decision.metadata,
  };

  console.log(stringifySortedCompact(payload));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
