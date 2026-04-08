type CronJob = Record<string, unknown>;
type CronConfig = {
  jobs?: CronJob[];
  [key: string]: unknown;
};

const APPROVED_MANAGED_RUNTIME_JOB_MARKERS = new Set([
  "memory-core.short-term-promotion",
]);

function extractManagedByMarker(job: CronJob): string | null {
  const description = typeof job.description === "string" ? job.description : "";
  const match = description.match(/\[managed-by=([^\]]+)\]/);
  return match?.[1] ?? null;
}

export function isApprovedManagedRuntimeOnlyJob(job: CronJob): boolean {
  const marker = extractManagedByMarker(job);
  return marker !== null && APPROVED_MANAGED_RUNTIME_JOB_MARKERS.has(marker);
}

export function splitRuntimeOnlyJobs(repoConfig: CronConfig, runtimeConfig: CronConfig): {
  approvedManagedRuntimeOnlyJobs: CronJob[];
  unexpectedRuntimeOnlyJobs: CronJob[];
} {
  const repoJobs = Array.isArray(repoConfig.jobs) ? repoConfig.jobs : [];
  const runtimeJobs = Array.isArray(runtimeConfig.jobs) ? runtimeConfig.jobs : [];
  const repoIds = new Set(repoJobs.map((job) => String(job.id ?? "")));

  const approvedManagedRuntimeOnlyJobs: CronJob[] = [];
  const unexpectedRuntimeOnlyJobs: CronJob[] = [];

  for (const job of runtimeJobs) {
    const jobId = String(job.id ?? "");
    if (!jobId || repoIds.has(jobId)) continue;
    if (isApprovedManagedRuntimeOnlyJob(job)) approvedManagedRuntimeOnlyJobs.push(job);
    else unexpectedRuntimeOnlyJobs.push(job);
  }

  return { approvedManagedRuntimeOnlyJobs, unexpectedRuntimeOnlyJobs };
}

export function normalizeRuntimeCronConfig(repoConfig: CronConfig, runtimeConfig: CronConfig): CronConfig {
  const runtimeJobs = Array.isArray(runtimeConfig.jobs) ? runtimeConfig.jobs : [];
  const normalizedJobs = runtimeJobs.filter((job) => !isApprovedManagedRuntimeOnlyJob(job));

  return { ...runtimeConfig, jobs: normalizedJobs };
}
