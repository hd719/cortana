import { describe, expect, it } from "vitest";
import { buildRuntimeDeployPlan, validateRuntimeDeployPreflight } from "../../tools/deploy/runtime-deploy-plan.ts";

describe("runtime deploy planner", () => {
  it("builds the default deploy and verification sequence", () => {
    const plan = buildRuntimeDeployPlan({ sourceRepo: "/src", compatRepo: "/openclaw", runtimeHome: "/home", targetCommit: "abc" });
    expect(plan.steps).toEqual([
      "ensure_compat_shim",
      "sync_openclaw_config_preserving_secrets",
      "sync_system_routing_state",
      "install_gog_runtime_shim",
      "sync_gog_skill_instructions",
      "sync_cron_config",
      "write_runtime_deploy_state",
    ]);
    expect(plan.verification).toContain("verify_openclaw_gateway");
  });

  it("honors skip flags", () => {
    const plan = buildRuntimeDeployPlan({ sourceRepo: "/src", compatRepo: "/openclaw", runtimeHome: "/home", targetCommit: "abc", skipCronSync: true, skipCompatShim: true, skipOpenclawCheck: true });
    expect(plan.steps).not.toContain("sync_cron_config");
    expect(plan.steps).not.toContain("ensure_compat_shim");
    expect(plan.verification).not.toContain("verify_openclaw_gateway");
  });

  it("returns preflight failures without touching runtime files", () => {
    expect(validateRuntimeDeployPreflight({ clean: false, branch: "feature", upstream: null, head: "a", remoteHead: "b" })).toEqual([
      "source repo has local changes",
      "source repo must be on main (found feature)",
      "source repo must track a remote main branch",
      "source repo is not synced with upstream",
    ]);
  });
});
