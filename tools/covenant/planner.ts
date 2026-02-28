#!/usr/bin/env npx tsx

/** Roland module for Covenant orchestration v2. */

import fs from "fs";
import path from "path";

const AGENT_MONITOR = "agent.monitor.v1";
const AGENT_HURAGOK = "agent.huragok.v1";
const AGENT_RESEARCHER = "agent.researcher.v1";
const AGENT_ORACLE = "agent.oracle.v1";
const AGENT_LIBRARIAN = "agent.librarian.v1";

const HANDOFF_PATTERNS: Record<string, [string, string[]]> = {
  researcher_to_librarian: [
    "Research evidence first, then transform findings into durable documentation.",
    [AGENT_RESEARCHER, AGENT_LIBRARIAN],
  ],
  researcher_to_oracle: [
    "Gather and compare evidence first, then perform strategic/risk analysis.",
    [AGENT_RESEARCHER, AGENT_ORACLE],
  ],
  researcher_to_oracle_to_huragok: [
    "Research options, choose strategy, then implement execution changes.",
    [AGENT_RESEARCHER, AGENT_ORACLE, AGENT_HURAGOK],
  ],
  parallel_research: [
    "Fan-out research across multiple Researchers in parallel, then fan-in to Oracle synthesis.",
    [AGENT_RESEARCHER, AGENT_RESEARCHER, AGENT_RESEARCHER, AGENT_ORACLE],
  ],
  monitor_to_huragok: [
    "Detect/triage issue patterns, then implement the corrective fix.",
    [AGENT_MONITOR, AGENT_HURAGOK],
  ],
  librarian_huragok_librarian: [
    "Define contract, implement, then align documentation/spec integrity.",
    [AGENT_LIBRARIAN, AGENT_HURAGOK, AGENT_LIBRARIAN],
  ],
};

const KEYWORDS: Record<string, Set<string>> = {
  [AGENT_HURAGOK]: new Set([
    "build",
    "install",
    "wire",
    "migrate",
    "setup",
    "set",
    "up",
    "deploy",
    "configure",
    "automate",
    "automation",
    "infra",
    "service",
    "daemon",
    "launchd",
    "cron",
    "implement",
    "implementation",
    "code",
    "fix",
    "patch",
    "test",
    "refactor",
  ]),
  [AGENT_RESEARCHER]: new Set([
    "research",
    "compare",
    "evaluate",
    "find",
    "investigate",
    "analyze_data",
    "deep_dive",
    "gather",
    "scout",
    "synthesize",
    "sources",
    "synthesize_sources",
    "look_into",
    "what_are_the_options",
    "options",
    "benchmark",
  ]),
  [AGENT_MONITOR]: new Set([
    "monitor",
    "alert",
    "detect",
    "anomaly",
    "health",
    "check",
    "health_check",
    "watch",
    "triage",
    "pattern",
    "escalate",
    "uptime",
    "incident",
    "verification",
    "verify",
  ]),
  [AGENT_ORACLE]: new Set([
    "forecast",
    "predict",
    "strategy",
    "risk",
    "plan",
    "model",
    "should",
    "we",
    "should_we",
    "tradeoff",
    "decision",
    "advise",
    "scenario",
    "probability",
    "timing",
  ]),
  [AGENT_LIBRARIAN]: new Set([
    "document",
    "readme",
    "summarize",
    "index",
    "tag",
    "organize",
    "write",
    "docs",
    "knowledge",
    "base",
    "catalog",
    "spec",
    "contract",
    "runbook",
    "architecture",
    "documentation",
    "doc",
    "align",
  ]),
};

const DEFAULT_RETRY = {
  max_retries: 2,
  retry_on: ["transient_tool_failure", "network_timeout", "timeout"],
  escalate_on: ["auth_failure", "permission_denied", "requirements_ambiguous"],
  timeout_seconds: 1800,
};

const DEFAULT_STEP_THRESHOLD = 0.6;

type Json = Record<string, any>;

type PatternResult = [string | null, string[], string];

function normalizeTokens(payload: Json): Set<string> {
  const tokens = new Set<string>();
  const objective = payload.objective;
  if (typeof objective === "string") {
    const objectiveLc = objective.toLowerCase();
    const normalized = objectiveLc
      .replace(/→/g, " ")
      .replace(/->/g, " ")
      .replace(/-/g, " ")
      .replace(/\//g, " ");
    for (const part of normalized.split(/\s+/)) {
      const clean = Array.from(part)
        .filter((c) => /[a-z0-9_]/i.test(c))
        .join("");
      if (clean) tokens.add(clean);
    }

    const phraseSignals: Record<string, string> = {
      "analyze data": "analyze_data",
      "deep dive": "deep_dive",
      "look into": "look_into",
      "synthesize sources": "synthesize_sources",
      "what are the options": "what_are_the_options",
      "health check": "health_check",
      "should we": "should_we",
      "parallel research": "parallel_research",
      "fan out": "fan_out",
      "fan-out": "fan_out",
      parallel: "parallel",
    };
    for (const [phrase, token] of Object.entries(phraseSignals)) {
      if (objectiveLc.includes(phrase)) tokens.add(token);
    }
  }

  for (const key of ["intents", "workflow_type"]) {
    const value = payload[key];
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (typeof item === "string" && item.trim()) {
          const normalized = item.trim().toLowerCase().replace(/-/g, " ");
          normalized.split(/\s+/).forEach((piece) => {
            if (piece) tokens.add(piece);
          });
        }
      });
    } else if (typeof value === "string" && value.trim()) {
      const normalized = value.trim().toLowerCase().replace(/-/g, " ");
      normalized.split(/\s+/).forEach((piece) => {
        if (piece) tokens.add(piece);
      });
    }
  }

  return tokens;
}

function choosePattern(tokens: Set<string>, explicit?: string | null): PatternResult {
  if (explicit) {
    const key = explicit.trim().toLowerCase();
    if (!HANDOFF_PATTERNS[key]) throw new Error(`unsupported handoff_pattern '${key}'`);
    const [reason, chain] = HANDOFF_PATTERNS[key];
    return [key, chain, reason];
  }

  const hasResearch = Array.from(KEYWORDS[AGENT_RESEARCHER]).some((k) => tokens.has(k));
  const hasOracle = Array.from(KEYWORDS[AGENT_ORACLE]).some((k) => tokens.has(k));
  const hasSpec = Array.from(KEYWORDS[AGENT_LIBRARIAN]).some((k) => tokens.has(k));
  const hasImpl = Array.from(KEYWORDS[AGENT_HURAGOK]).some((k) => tokens.has(k));
  const hasMonitor = Array.from(KEYWORDS[AGENT_MONITOR]).some((k) => tokens.has(k));
  const hasParallel = ["parallel", "fan_out", "parallel_research"].some((k) => tokens.has(k));

  if (hasParallel && hasResearch) {
    const [reason, chain] = HANDOFF_PATTERNS.parallel_research;
    return ["parallel_research", chain, reason];
  }
  if (hasResearch && hasOracle && hasImpl) {
    const [reason, chain] = HANDOFF_PATTERNS.researcher_to_oracle_to_huragok;
    return ["researcher_to_oracle_to_huragok", chain, reason];
  }
  if (hasResearch && hasSpec) {
    const [reason, chain] = HANDOFF_PATTERNS.researcher_to_librarian;
    return ["researcher_to_librarian", chain, reason];
  }
  if (hasResearch && hasOracle) {
    const [reason, chain] = HANDOFF_PATTERNS.researcher_to_oracle;
    return ["researcher_to_oracle", chain, reason];
  }
  if (hasMonitor && hasImpl) {
    const [reason, chain] = HANDOFF_PATTERNS.monitor_to_huragok;
    return ["monitor_to_huragok", chain, reason];
  }
  if (hasSpec && hasImpl) {
    const [reason, chain] = HANDOFF_PATTERNS.librarian_huragok_librarian;
    return ["librarian_huragok_librarian", chain, reason];
  }

  const scores: Record<string, number> = {};
  Object.entries(KEYWORDS).forEach(([agent, words]) => {
    scores[agent] = Array.from(tokens).filter((t) => words.has(t)).length;
  });
  const primary = Object.keys(scores).sort((a, b) => scores[b] - scores[a])[0];
  if (!primary || scores[primary] === 0) {
    return [
      null,
      [AGENT_ORACLE],
      "Weak/ambiguous routing signal; defaulted to Oracle for triage and recommendation.",
    ];
  }

  const reasons: Record<string, string> = {
    [AGENT_MONITOR]: "Detected monitoring/health/anomaly signals.",
    [AGENT_HURAGOK]: "Detected implementation/automation/infrastructure signals.",
    [AGENT_RESEARCHER]: "Detected research/comparison/evidence-gathering signals.",
    [AGENT_ORACLE]: "Detected forecasting/risk/decision-modeling signals.",
    [AGENT_LIBRARIAN]: "Detected documentation/knowledge-organization signals.",
  };
  return [null, [primary], reasons[primary]];
}

function stepConfidence(agent: string, tokens: Set<string>): number {
  const matched = Array.from(KEYWORDS[agent] ?? []).filter((t) => tokens.has(t)).length;
  const raw = Math.min(0.95, 0.55 + matched * 0.08);
  return Math.round(raw * 100) / 100;
}

function researchAngles(payload: Json): string[] {
  const angles = payload.parallel_research_angles;
  if (Array.isArray(angles)) {
    const normalized = angles.map((x) => String(x).trim()).filter((x) => x);
    if (normalized.length) return normalized;
  }
  return ["angle_1", "angle_2", "angle_3"];
}

export function buildPlan(payload: Json): Json {
  const tokens = normalizeTokens(payload);
  const [pattern, chain, reason] = choosePattern(tokens, payload.handoff_pattern);

  const objective = payload.objective ?? "Execute routed task";
  const steps: Json[] = [];

  if (pattern === "parallel_research") {
    const angles = researchAngles(payload);
    const parallelGroup = payload.parallel_group || "research_fanout_1";
    const confidenceThreshold = payload.confidence_threshold ?? DEFAULT_STEP_THRESHOLD;

    angles.forEach((angle, idx) => {
      const stepId = `step_${idx + 1}`;
      steps.push({
        step_id: stepId,
        agent_identity_id: AGENT_RESEARCHER,
        objective: `${objective} :: Research angle [${angle}]`,
        depends_on: [],
        parallel_group: parallelGroup,
        confidence: stepConfidence(AGENT_RESEARCHER, tokens),
        confidence_threshold: confidenceThreshold,
        retry_policy: { ...DEFAULT_RETRY },
        quality_gate: {
          name: `gate_${stepId}`,
          required: true,
          checks: ["outputs_match_contract", "no_boundary_violations", "confidence_meets_threshold"],
        },
        handoff: {
          input_contract: ["objective", "upstream_artifacts", "constraints"],
          output_contract: ["summary", "artifacts", "risks", "confidence"],
          deliver_to_step_id: `step_${angles.length + 1}`,
        },
      });
    });

    const finalStepId = `step_${angles.length + 1}`;
    steps.push({
      step_id: finalStepId,
      agent_identity_id: AGENT_ORACLE,
      objective: `Synthesize parallel findings for objective: ${objective}`,
      depends_on: ["step_1"],
      parallel_group: null,
      confidence: stepConfidence(AGENT_ORACLE, tokens),
      confidence_threshold: confidenceThreshold,
      retry_policy: { ...DEFAULT_RETRY },
      quality_gate: {
        name: `gate_${finalStepId}`,
        required: true,
        checks: ["outputs_match_contract", "no_boundary_violations", "confidence_meets_threshold"],
      },
      handoff: {
        input_contract: ["objective", "upstream_artifacts", "constraints"],
        output_contract: ["summary", "artifacts", "risks", "confidence"],
        deliver_to_step_id: null,
      },
    });
  } else {
    chain.forEach((agent, idx) => {
      const stepId = `step_${idx + 1}`;
      const deps = idx > 0 ? [`step_${idx}`] : [];
      const nextStep = idx < chain.length - 1 ? `step_${idx + 2}` : null;
      steps.push({
        step_id: stepId,
        agent_identity_id: agent,
        objective: idx === 0 ? objective : `Continue objective after ${deps[0]} outputs`,
        depends_on: deps,
        parallel_group: null,
        confidence: stepConfidence(agent, tokens),
        confidence_threshold: payload.confidence_threshold ?? DEFAULT_STEP_THRESHOLD,
        retry_policy: { ...DEFAULT_RETRY },
        quality_gate: {
          name: `gate_${stepId}`,
          required: true,
          checks: ["outputs_match_contract", "no_boundary_violations", "confidence_meets_threshold"],
        },
        handoff: {
          input_contract: ["objective", "upstream_artifacts", "constraints"],
          output_contract: ["summary", "artifacts", "risks", "confidence"],
          deliver_to_step_id: nextStep,
        },
      });
    });
  }

  return {
    version: "covenant-pce-v2",
    mode: chain.length > 1 ? "handoff_chain" : "single_agent",
    selected_pattern: pattern,
    primary_agent_identity_id: chain[0],
    handoff_chain: chain,
    routing_reason: reason,
    steps,
    quality_gates: {
      pre_execution: {
        name: "plan_approved_by_arbiter",
        required: true,
        checks: ["dependencies_acyclic", "budget_within_limits", "agent_selection_valid"],
      },
      pre_completion: {
        name: "execution_outputs_validated",
        required: true,
        checks: [
          "all_required_steps_completed",
          "all_gates_passed",
          "final_confidence_above_threshold",
        ],
      },
    },
  };
}

function usageError(): never {
  console.error("usage: planner.py <payload.json>");
  process.exit(2);
}

async function main(): Promise<void> {
  const payloadPath = process.argv[2];
  if (!payloadPath) usageError();
  const resolved = path.resolve(payloadPath);
  const payload = JSON.parse(fs.readFileSync(resolved, "utf8"));
  console.log(JSON.stringify(buildPlan(payload), null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
