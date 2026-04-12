import { describe, expect, it } from "vitest";
import { isApprovedManagedRuntimeOnlyJob, normalizeRuntimeCronConfig, splitRuntimeOnlyJobs, stableCronSemanticDigest } from "../../tools/lib/runtime-cron-jobs.js";

describe("runtime cron managed job classification", () => {
  it("treats approved memory-core managed runtime jobs as preserved runtime-only jobs", () => {
    const repoConfig = {
      jobs: [{ id: "repo-1", name: "Repo Job" }],
    };
    const runtimeConfig = {
      jobs: [
        { id: "repo-1", name: "Repo Job", state: { nextRunAtMs: 123 } },
        {
          id: "managed-1",
          name: "Memory Dreaming Promotion",
          description: "[managed-by=memory-core.short-term-promotion] Promote recalls.",
        },
      ],
    };

    const split = splitRuntimeOnlyJobs(repoConfig, runtimeConfig);
    expect(split.approvedManagedRuntimeOnlyJobs).toHaveLength(1);
    expect(split.unexpectedRuntimeOnlyJobs).toHaveLength(0);
    expect(isApprovedManagedRuntimeOnlyJob(split.approvedManagedRuntimeOnlyJobs[0]!)).toBe(true);

    const normalized = normalizeRuntimeCronConfig(repoConfig, runtimeConfig) as { jobs: Array<{ id: string }> };
    expect(normalized.jobs.map((job) => job.id)).toEqual(["repo-1"]);
  });

  it("keeps unknown runtime-only jobs actionable", () => {
    const repoConfig = {
      jobs: [{ id: "repo-1", name: "Repo Job" }],
    };
    const runtimeConfig = {
      jobs: [
        { id: "repo-1", name: "Repo Job" },
        { id: "unknown-1", name: "Unexpected Runtime Job", description: "[managed-by=unknown.plugin] Surprise." },
      ],
    };

    const split = splitRuntimeOnlyJobs(repoConfig, runtimeConfig);
    expect(split.approvedManagedRuntimeOnlyJobs).toHaveLength(0);
    expect(split.unexpectedRuntimeOnlyJobs).toHaveLength(1);
    expect(split.unexpectedRuntimeOnlyJobs[0]?.id).toBe("unknown-1");
  });

  it("ignores trailing prompt whitespace in semantic cron comparisons", () => {
    const repoConfig = {
      version: 1,
      jobs: [{ id: "repo-1", name: "Repo Job", payload: { kind: "agentTurn", message: "hello\n" } }],
    };
    const runtimeConfig = {
      version: 1,
      jobs: [{ id: "repo-1", name: "Repo Job", payload: { kind: "agentTurn", message: "hello" } }],
    };

    expect(stableCronSemanticDigest(repoConfig)).toBe(stableCronSemanticDigest(runtimeConfig));
  });
});
