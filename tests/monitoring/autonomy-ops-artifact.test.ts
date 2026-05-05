import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTONOMY_OPS_ARTIFACT_SCHEMA_VERSION,
  buildAutonomyOpsArtifact,
  writeAutonomyOpsArtifact,
  type AutonomyOpsSource,
} from "../../tools/monitoring/write-autonomy-ops-artifact.ts";

function summary(overrides: Record<string, unknown> = {}) {
  return {
    posture: "balanced",
    operatorState: "live",
    autoFixed: [],
    degraded: [],
    waitingOnHamel: [],
    blocked: [],
    familyCritical: {
      tracked: [],
      failures: 0,
      stricterEscalation: true,
    },
    counts: {
      autoRemediated: 0,
      escalated: 0,
      needsHuman: 0,
      actionable: 0,
      suppressed: 0,
    },
    scorecard: {
      counts: {
        autoFixAttempted: 0,
        autoFixSucceeded: 0,
        escalations: 0,
        blockedOrExceededAuthority: 0,
        staleReportSuppressions: 0,
        familyCriticalFailures: 0,
      },
      activeFollowUps: [],
    },
    ...overrides,
  } as any;
}

function source(status: AutonomyOpsSource["status"]): AutonomyOpsSource {
  return {
    key: `source_${status}`,
    label: `Source ${status}`,
    required: true,
    status,
    confidence: status === "fresh" ? "high" : "low",
    generatedAt: status === "missing" ? null : "2026-05-05T12:00:00.000Z",
    freshUntil: status === "missing" ? null : "2026-05-05T12:10:00.000Z",
    detail: status === "fresh" ? null : `${status}_fixture`,
  };
}

describe("autonomy ops artifact", () => {
  it("builds the stable v1 artifact shape for Mission Control", () => {
    const artifact = buildAutonomyOpsArtifact(summary({
      autoFixed: ["gateway"],
      degraded: ["channel:escalate"],
      waitingOnHamel: ["1 escalated check(s)"],
      blocked: ["oauth:manual_reauth"],
      counts: {
        autoRemediated: 1,
        escalated: 1,
        needsHuman: 1,
        actionable: 0,
        suppressed: 2,
      },
    }), {
      nowMs: Date.parse("2026-05-05T12:00:00.000Z"),
    });

    expect(artifact.schemaVersion).toBe(AUTONOMY_OPS_ARTIFACT_SCHEMA_VERSION);
    expect(artifact.generatedAt).toBe("2026-05-05T12:00:00.000Z");
    expect(artifact.freshUntil).toBe("2026-05-05T12:10:00.000Z");
    expect(artifact.operatorState).toBe("live");
    expect(artifact.sections.autoFixed).toEqual(["gateway"]);
    expect(artifact.sections.degraded).toEqual(["channel:escalate"]);
    expect(artifact.sections.waitingOnHamel).toEqual(["1 escalated check(s)"]);
    expect(artifact.sections.blockers).toEqual(["oauth:manual_reauth"]);
    expect(artifact.sources.every((item) => item.status === "fresh")).toBe(true);
  });

  it("prevents a fresh artifact with a stale required source from reporting live", () => {
    const artifact = buildAutonomyOpsArtifact(summary(), {
      nowMs: Date.parse("2026-05-05T12:00:00.000Z"),
      sourceFreshness: [source("fresh"), source("stale")],
    });

    expect(artifact.stale).toBe(true);
    expect(artifact.operatorState).toBe("watch");
    expect(artifact.sources.map((item) => item.status)).toEqual(["fresh", "stale"]);
  });

  it("marks missing required source data as attention", () => {
    const artifact = buildAutonomyOpsArtifact(summary(), {
      nowMs: Date.parse("2026-05-05T12:00:00.000Z"),
      sourceFreshness: [source("missing")],
    });

    expect(artifact.stale).toBe(true);
    expect(artifact.operatorState).toBe("attention");
  });

  it("writes the artifact atomically to the requested path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "autonomy-ops-artifact-"));
    const outputPath = path.join(root, "reports", "autonomy-ops", "latest.json");

    const artifact = writeAutonomyOpsArtifact({
      outputPath,
      summary: summary(),
      nowMs: Date.parse("2026-05-05T12:00:00.000Z"),
    });

    const written = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    const leftovers = fs.readdirSync(path.dirname(outputPath)).filter((name) => name.includes(".tmp"));
    expect(written).toEqual(artifact);
    expect(leftovers).toEqual([]);
  });
});
