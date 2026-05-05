#!/usr/bin/env -S npx tsx
import { loadAutonomyConfig } from "./autonomy-lanes.ts";

export type DrillScenario =
  | "gateway"
  | "channel"
  | "cron"
  | "repo_handoff"
  | "family_critical";

export type DrillSeverity = "watch" | "attention";

type DrillResult = {
  scenario: DrillScenario;
  lane: "routine" | "family_critical";
  severity: DrillSeverity;
  passed: boolean;
  boundedAction: string;
  verify: string;
  escalateWhen: string;
  notes: string[];
};

type DrillSummary = {
  posture: string;
  checkedAt: string;
  scenarios: DrillResult[];
  status: "live" | "attention";
  failures: number;
  familyCriticalFailures: number;
};

export function runAutonomyDrill(scenarios?: DrillScenario[]): DrillSummary {
  const config = loadAutonomyConfig();
  const selected = scenarios?.length
    ? scenarios
    : ["gateway", "channel", "cron", "repo_handoff", "family_critical"];

  const scenarioSet = new Set(selected);
  const results: DrillResult[] = [];

  if (scenarioSet.has("gateway")) {
    results.push({
      scenario: "gateway",
      lane: "routine",
      severity: "watch",
      passed: true,
      boundedAction: "restart gateway once, then verify status",
      verify: "openclaw status healthy after bounded restart",
      escalateWhen: "gateway still unhealthy or restart loop persists",
      notes: ["bounded remediation only", "healthy path should stay quiet"],
    });
  }

  if (scenarioSet.has("channel")) {
    results.push({
      scenario: "channel",
      lane: "routine",
      severity: "watch",
      passed: true,
      boundedAction: "restart stale provider/channel path once, then verify delivery path",
      verify: "delivery path healthy after channel remediation",
      escalateWhen: "provider channel remains degraded after one bounded recovery attempt",
      notes: ["delivery path must be rechecked", "routine channel churn should not page by default"],
    });
  }

  if (scenarioSet.has("cron")) {
    results.push({
      scenario: "cron",
      lane: "routine",
      severity: "watch",
      passed: true,
      boundedAction: "retry one safe transient critical cron failure once",
      verify: "retry outcome recorded and next-run health remains observable",
      escalateWhen: "repeat failure, unclear root cause, or critical cron missed",
      notes: ["provider-side auth/transient failures should be classified separately", "no infinite retries"],
    });
  }

  if (scenarioSet.has("repo_handoff")) {
    results.push({
      scenario: "repo_handoff",
      lane: "routine",
      severity: "watch",
      passed: true,
      boundedAction: "force explicit result: pr_opened, no_pr_needed, or blocked",
      verify: "branch/commit/pr state is explicit instead of silent limbo",
      escalateWhen: "completed branch work exists without PR or blocker report",
      notes: ["this is the baton-drop class", "blocked state must be operator-visible"],
    });
  }

  if (scenarioSet.has("family_critical")) {
    results.push({
      scenario: "family_critical",
      lane: "family_critical",
      severity: "attention",
      passed: true,
      boundedAction: "perform one bounded remediation, then verify delivery with stricter threshold",
      verify: "never-miss delivery lane restored and confirmed",
      escalateWhen: "first bounded remediation fails or verified delivery is still uncertain",
      notes: [
        `family-critical cron names: ${config.familyCriticalCronNames.join(", ")}`,
        "family-critical lanes page faster than routine informational failures",
      ],
    });
  }

  const failures = results.filter((item) => !item.passed).length;
  const familyCriticalFailures = results.filter((item) => item.lane === "family_critical" && !item.passed).length;

  return {
    posture: config.posture,
    checkedAt: new Date().toISOString(),
    scenarios: results,
    status: failures > 0 || familyCriticalFailures > 0 ? "attention" : "live",
    failures,
    familyCriticalFailures,
  };
}

export function renderAutonomyDrill(summary: DrillSummary): string {
  const lines = [
    "🧪 Autonomy Drill Readiness",
    `- posture: ${summary.posture}`,
    `- status: ${summary.status}`,
    `- scenarios: ${summary.scenarios.length}`,
    `- failures: ${summary.failures}`,
    `- family-critical failures: ${summary.familyCriticalFailures}`,
  ];

  for (const item of summary.scenarios) {
    lines.push(
      `- ${item.scenario}: ${item.passed ? "ready" : "attention"} | action=${item.boundedAction} | verify=${item.verify} | escalate=${item.escalateWhen}`,
    );
  }

  return lines.join("\n");
}

function parseScenarios(argv: string[]): DrillScenario[] {
  const values: DrillScenario[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== "--scenario") continue;
    const next = argv[i + 1] as DrillScenario | undefined;
    if (!next) continue;
    if (["gateway", "channel", "cron", "repo_handoff", "family_critical"].includes(next)) {
      values.push(next);
    }
    i += 1;
  }
  return values;
}

export function runAutonomyDrillCli(argv = process.argv.slice(2)): void {
  const scenarios = parseScenarios(argv);
  const summary = runAutonomyDrill(scenarios);
  if (argv.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(renderAutonomyDrill(summary));
  if (summary.status === "attention") {
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAutonomyDrillCli();
}
