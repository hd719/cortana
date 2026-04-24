export type RuntimeDeployPlanInput = {
  sourceRepo: string;
  compatRepo: string;
  runtimeHome: string;
  sourceBranch?: string;
  targetCommit: string;
  previousCompatCommit?: string | null;
  skipOpenclawCheck?: boolean;
  skipCronSync?: boolean;
  skipCompatShim?: boolean;
};

export type RuntimeDeployPlan = {
  sourceRepo: string;
  compatRepo: string;
  runtimeHome: string;
  sourceBranch: string;
  targetCommit: string;
  previousCompatCommit: string | null;
  steps: string[];
  verification: string[];
};

export function buildRuntimeDeployPlan(input: RuntimeDeployPlanInput): RuntimeDeployPlan {
  const sourceBranch = input.sourceBranch ?? "main";
  const steps = [
    ...(!input.skipCompatShim ? ["ensure_compat_shim"] : []),
    "sync_openclaw_config_preserving_secrets",
    "sync_system_routing_state",
    "install_gog_runtime_shim",
    "sync_gog_skill_instructions",
    ...(!input.skipCronSync ? ["sync_cron_config"] : []),
    "write_runtime_deploy_state",
  ];
  const verification = [
    ...(!input.skipCompatShim ? ["verify_compat_shim"] : []),
    "verify_runtime_config",
    ...(!input.skipCronSync ? ["verify_cron_config"] : []),
    ...(!input.skipOpenclawCheck ? ["verify_openclaw_gateway"] : []),
  ];

  return {
    sourceRepo: input.sourceRepo,
    compatRepo: input.compatRepo,
    runtimeHome: input.runtimeHome,
    sourceBranch,
    targetCommit: input.targetCommit,
    previousCompatCommit: input.previousCompatCommit ?? null,
    steps,
    verification,
  };
}

export function validateRuntimeDeployPreflight(input: { clean: boolean; branch: string; upstream: string | null; head: string; remoteHead: string }): string[] {
  const failures: string[] = [];
  if (!input.clean) failures.push("source repo has local changes");
  if (input.branch !== "main") failures.push(`source repo must be on main (found ${input.branch})`);
  if (!input.upstream) failures.push("source repo must track a remote main branch");
  if (input.head !== input.remoteHead) failures.push(`source repo is not synced with ${input.upstream ?? "upstream"}`);
  return failures;
}
