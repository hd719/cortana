import { describe, expect, it } from "vitest";
import { expectsSilentSuccess, mergeRuntimeCronState, splitRuntimeOnlyJobs } from "../../tools/cron/control-plane.ts";

describe("cron control plane", () => {
  it("merges only runtime state and approved managed runtime-only jobs", () => {
    const repo = { jobs: [{ id: "brief", name: "Brief", payload: { timeoutSeconds: 60 } }] };
    const runtime = {
      jobs: [
        { id: "brief", name: "Runtime name drift", payload: { timeoutSeconds: 10 }, state: { lastStatus: "ok" }, lastDurationMs: 123 },
        {
          id: "memory-promotion",
          description: "[managed-by=memory-core.short-term-promotion] Promote recalls.",
          schedule: { kind: "cron", expr: "0 3 * * *" },
        },
        { id: "surprise", name: "Unexpected runtime job" },
      ],
    };

    const merged = mergeRuntimeCronState(repo, runtime);
    expect(merged.jobs).toHaveLength(2);
    expect(merged.jobs?.[0]).toMatchObject({
      id: "brief",
      name: "Brief",
      payload: { timeoutSeconds: 60 },
      state: { lastStatus: "ok" },
      lastDurationMs: 123,
    });
    expect(merged.jobs?.map((job) => job.id)).toEqual(["brief", "memory-promotion"]);
  });

  it("classifies unexpected runtime-only jobs separately", () => {
    const split = splitRuntimeOnlyJobs({ jobs: [{ id: "tracked" }] }, { jobs: [{ id: "tracked" }, { id: "runtime-only" }] });
    expect(split.approvedManagedRuntimeOnlyJobs).toEqual([]);
    expect(split.unexpectedRuntimeOnlyJobs).toEqual([{ id: "runtime-only" }]);
  });

  it("recognizes silent-success cron contracts", () => {
    expect(expectsSilentSuccess({ delivery: { mode: "none" } })).toBe(true);
    expect(expectsSilentSuccess({ delivery: { to: "NO_REPLY" } })).toBe(true);
    expect(expectsSilentSuccess({ payload: { message: "If healthy: output NOTHING" } })).toBe(true);
    expect(expectsSilentSuccess({ payload: { message: "If no substantive change, return exactly NO_REPLY" } })).toBe(true);
    expect(expectsSilentSuccess({ delivery: { mode: "announce" }, payload: { message: "Send a summary" } })).toBe(false);
  });
});
