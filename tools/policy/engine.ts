#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { getScriptDir } from "../lib/paths.js";

type Json = Record<string, any>;

type ActionRequest = {
  action_key: string;
  action_category?: string | null;
  operation?: string | null;
  target?: string | null;
  confidence: number;
  tags: string[];
  projected_cost: Record<string, number>;
  metadata: Record<string, any>;
};

type Override = {
  override_key: string;
  decision_override?: string | null;
  max_risk_allowed?: number | null;
  active: boolean;
  starts_at?: string | null;
  expires_at?: string | null;
  action_key?: string | null;
  action_category?: string | null;
  budget_adjustments: Record<string, number>;
};

const DECISION_ORDER: Record<string, number> = {
  allow: 0,
  alert: 1,
  ask: 2,
  deny: 3,
};

function sortObject(value: any): any {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  const out: Json = {};
  Object.keys(value)
    .sort()
    .forEach((key) => {
      out[key] = sortObject(value[key]);
    });
  return out;
}

function tryYamlParse(text: string): any {
  const require = createRequire(import.meta.url);
  try {
    // Optional dependency.
    const yaml = require("yaml");
    if (yaml && typeof yaml.parse === "function") {
      const parsed = yaml.parse(text);
      return parsed ?? {};
    }
  } catch {
    // ignore
  }
  return null;
}

function loadPolicy(policyFile: string): Json {
  const raw = fs.readFileSync(policyFile, "utf8");
  const yamlParsed = tryYamlParse(raw);
  if (yamlParsed) return yamlParsed as Json;
  return JSON.parse(raw) as Json;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function appliesTo(override: Override, req: ActionRequest, now: Date): boolean {
  if (!override.active) return false;
  const startsAt = parseDate(override.starts_at ?? undefined);
  if (startsAt && now < startsAt) return false;
  const expiresAt = parseDate(override.expires_at ?? undefined);
  if (expiresAt && now > expiresAt) return false;
  if (override.action_key && override.action_key !== req.action_key) return false;
  if (override.action_category && override.action_category !== req.action_category) return false;
  return true;
}

class PolicyEngine {
  private policyFile: string;
  private policy: Json;
  private actionPolicies: Json[];
  private budgetPolicies: Json[];
  private thresholds: Json;
  private defaults: Json;
  private modifiers: Json;
  private immutableCategories: Set<string>;

  constructor(policyFile: string) {
    this.policyFile = policyFile;
    this.policy = loadPolicy(policyFile);
    this.actionPolicies = this.policy.action_policies ?? [];
    this.budgetPolicies = this.policy.budget_policies ?? [];
    this.thresholds = this.policy.thresholds ?? { low: 35, medium: 65, high: 85 };
    this.defaults = this.policy.defaults ?? {};
    this.modifiers = this.policy.risk_modifiers ?? {};
    const imm = this.policy.overrides?.immutable_categories ?? [];
    this.immutableCategories = new Set(Array.isArray(imm) ? imm : []);
  }

  private findActionPolicy(req: ActionRequest): Json {
    for (const p of this.actionPolicies) {
      if (p?.key === req.action_key) return p;
    }
    if (req.action_category) {
      for (const p of this.actionPolicies) {
        if (p?.category === req.action_category) return p;
      }
    }
    throw new Error(
      `No action policy found for key=${JSON.stringify(req.action_key)} category=${JSON.stringify(
        req.action_category
      )}`
    );
  }

  private riskScore(req: ActionRequest, policy: Json): number {
    let score = Number(policy.risk_base ?? 0);
    const tags = new Set<string>([...req.tags, ...(policy.tags ?? [])]);

    if (tags.has("external")) score += Number(this.modifiers.external ?? 0);
    if (tags.has("destructive")) score += Number(this.modifiers.destructive ?? 0);
    if (tags.has("infra")) score += Number(this.modifiers.infra ?? 0);
    if (tags.has("finance")) score += Number(this.modifiers.finance ?? 0);
    if (tags.has("privacy")) score += Number(this.modifiers.privacy ?? 0);

    const confDefault = Number(this.defaults.confidence_default ?? 0.75);
    const confRaw = typeof req.confidence === "number" ? req.confidence : confDefault;
    const conf = Math.max(0, Math.min(1, confRaw || confDefault));
    const confPenalty = Number(this.defaults.risk?.confidence_penalty_weight ?? 20);
    score += (1 - conf) * confPenalty;

    if (!req.target) score += Number(this.defaults.risk?.unknown_target_penalty ?? 10);
    if (req.metadata?.bulk) score += Number(this.defaults.risk?.bulk_operation_penalty ?? 15);

    const maxScore = Number(this.defaults.risk?.max_score ?? 100);
    const bounded = Math.max(0, Math.min(maxScore, score));
    return Math.round(bounded * 100) / 100;
  }

  private budgetEval(
    req: ActionRequest,
    usageSnapshot: Record<string, number>,
    override?: Override | null
  ): Record<string, any> {
    const results: Record<string, any>[] = [];
    let worstDecision = "allow";

    for (const b of this.budgetPolicies) {
      if (!b?.hard_stop && (b?.on_exceed ?? "allow") === "allow") {
        // no-op, but preserve loop
      }

      const scope = b?.scope ?? "global";
      const scopeValue = b?.scope_value;
      if (scope === "category" && scopeValue !== req.action_category) continue;
      if (scope === "action" && scopeValue !== req.action_key) continue;

      const costType = b?.cost_type;
      const current = Number(usageSnapshot?.[costType] ?? 0);
      const projected = Number(req.projected_cost?.[costType] ?? 0);
      let limit = Number(b?.limit ?? 0);

      if (override?.budget_adjustments) {
        limit += Number(override.budget_adjustments[costType] ?? 0);
      }

      const nextTotal = current + projected;
      const pct = limit > 0 ? (nextTotal / limit) * 100 : 0;
      const warnAtPct = Number(b?.warn_at_pct ?? 80);

      let status = "ok";
      let decision = "allow";
      if (pct >= 100) {
        status = "exceeded";
        decision = b?.on_exceed ?? "ask";
        if (b?.hard_stop ?? true) {
          decision = decision === "deny" ? "deny" : "ask";
        }
      } else if (pct >= warnAtPct) {
        status = "warn";
        decision = "alert";
      }

      if (DECISION_ORDER[decision] > DECISION_ORDER[worstDecision]) {
        worstDecision = decision;
      }

      results.push({
        budget_key: b?.key,
        cost_type: costType,
        current: Math.round(current * 10000) / 10000,
        projected: Math.round(projected * 10000) / 10000,
        next_total: Math.round(nextTotal * 10000) / 10000,
        limit: Math.round(limit * 10000) / 10000,
        pct: Math.round(pct * 100) / 100,
        status,
        decision,
      });
    }

    return { decision: worstDecision, checks: results };
  }

  private selectOverride(req: ActionRequest, overrides: Override[], now: Date): Override | null {
    for (const o of overrides) {
      if (appliesTo(o, req, now)) return o;
    }
    return null;
  }

  evaluate(
    req: ActionRequest,
    usageSnapshot?: Record<string, number> | null,
    overrides?: Override[] | null,
    now?: Date | null
  ): Record<string, any> {
    const nowDate = now ?? new Date();
    const usage = usageSnapshot ?? {};
    const overrideList = overrides ?? [];

    const actionPolicy = this.findActionPolicy(req);
    req.action_category = req.action_category ?? actionPolicy.category;

    const riskScore = this.riskScore(req, actionPolicy);
    let decision = actionPolicy.base_decision ?? "ask";
    const rationale: string[] = [`base:${decision}`];

    if (actionPolicy.requires_approval) {
      decision = DECISION_ORDER[decision] < DECISION_ORDER.ask ? "ask" : decision;
      rationale.push("requires_approval");
    }

    const riskAsk = Number(actionPolicy.risk_threshold_ask ?? this.thresholds.medium ?? 65);
    const riskDeny = Number(actionPolicy.risk_threshold_deny ?? this.thresholds.high ?? 85);
    if (riskScore >= riskDeny) {
      decision = DECISION_ORDER[decision] < DECISION_ORDER.deny ? "deny" : decision;
      rationale.push(`risk>=${riskDeny}`);
    } else if (riskScore >= riskAsk) {
      decision = DECISION_ORDER[decision] < DECISION_ORDER.ask ? "ask" : decision;
      rationale.push(`risk>=${riskAsk}`);
    }

    let budgetResult = this.budgetEval(req, usage);
    if (DECISION_ORDER[budgetResult.decision] > DECISION_ORDER[decision]) {
      decision = budgetResult.decision;
      rationale.push(`budget:${budgetResult.decision}`);
    }

    const selectedOverride = this.selectOverride(req, overrideList, nowDate);
    if (selectedOverride) {
      const isImmutable =
        (req.action_category && this.immutableCategories.has(req.action_category)) ||
        Boolean(actionPolicy.immutable);
      if (isImmutable) {
        rationale.push("override_blocked_immutable");
      } else if (
        selectedOverride.max_risk_allowed != null &&
        riskScore > Number(selectedOverride.max_risk_allowed)
      ) {
        rationale.push("override_max_risk_exceeded");
      } else {
        if (selectedOverride.decision_override) {
          decision = selectedOverride.decision_override;
          rationale.push(`override:${selectedOverride.override_key}`);
        }
        const budgetWithOverride = this.budgetEval(req, usage, selectedOverride);
        if (DECISION_ORDER[budgetWithOverride.decision] > DECISION_ORDER[decision]) {
          decision = budgetWithOverride.decision;
          rationale.push(`budget_after_override:${budgetWithOverride.decision}`);
        }
        budgetResult = budgetWithOverride;
      }
    }

    const escalationTier = Number(actionPolicy.escalation_tier ?? 3);
    if (decision === "allow" && escalationTier === 2) {
      decision = "alert";
      rationale.push("tier2_alert");
    }

    return {
      timestamp: nowDate.toISOString(),
      action_key: req.action_key,
      action_category: req.action_category ?? null,
      policy_key: actionPolicy.key,
      override_key: selectedOverride ? selectedOverride.override_key : null,
      risk_score: riskScore,
      confidence: req.confidence,
      decision,
      escalation_tier: escalationTier,
      rationale: rationale.join(";"),
      budget: budgetResult,
      request: {
        action_key: req.action_key,
        action_category: req.action_category ?? null,
        operation: req.operation ?? null,
        target: req.target ?? null,
        confidence: req.confidence,
        tags: req.tags,
        projected_cost: req.projected_cost,
        metadata: req.metadata,
      },
    };
  }
}

function usage(): string {
  return (
    "Usage: engine.ts --action-key <key> [--policies <file>] [--category <cat>] " +
    "[--operation <op>] [--target <target>] [--confidence <float>] [--tags a,b] " +
    "[--projected <json>] [--usage <json>]"
  );
}

type ParsedArgs = {
  policies: string;
  actionKey: string | null;
  category: string | null;
  operation: string | null;
  target: string | null;
  confidence: number;
  tags: string;
  projected: string;
  usage: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  const defaults: ParsedArgs = {
    policies: path.join(getScriptDir(import.meta.url), "policies.yaml"),
    actionKey: null,
    category: null,
    operation: null,
    target: null,
    confidence: 0.75,
    tags: "",
    projected: "{}",
    usage: "{}",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--policies":
        defaults.policies = argv[i + 1] ?? defaults.policies;
        i += 1;
        break;
      case "--action-key":
        defaults.actionKey = argv[i + 1] ?? null;
        i += 1;
        break;
      case "--category":
        defaults.category = argv[i + 1] ?? null;
        i += 1;
        break;
      case "--operation":
        defaults.operation = argv[i + 1] ?? null;
        i += 1;
        break;
      case "--target":
        defaults.target = argv[i + 1] ?? null;
        i += 1;
        break;
      case "--confidence":
        defaults.confidence = Number(argv[i + 1]);
        i += 1;
        break;
      case "--tags":
        defaults.tags = argv[i + 1] ?? "";
        i += 1;
        break;
      case "--projected":
        defaults.projected = argv[i + 1] ?? "{}";
        i += 1;
        break;
      case "--usage":
        defaults.usage = argv[i + 1] ?? "{}";
        i += 1;
        break;
      default:
        break;
    }
  }

  return defaults;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.actionKey) {
    console.error(usage());
    process.exit(2);
  }

  const engine = new PolicyEngine(args.policies);
  const req: ActionRequest = {
    action_key: args.actionKey,
    action_category: args.category,
    operation: args.operation,
    target: args.target,
    confidence: args.confidence,
    tags: args.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    projected_cost: JSON.parse(args.projected),
    metadata: {},
  };

  const result = engine.evaluate(req, JSON.parse(args.usage));
  console.log(JSON.stringify(sortObject(result), null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
