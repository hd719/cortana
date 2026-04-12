type CronJob = Record<string, unknown>;
type CronConfig = {
  jobs?: CronJob[];
  [key: string]: unknown;
};

const VOLATILE_CRON_KEYS = new Set([
  "state",
  "updatedAtMs",
  "lastRunAtMs",
  "nextRunAtMs",
  "lastStatus",
  "lastRunStatus",
  "lastDurationMs",
  "lastDeliveryStatus",
  "lastDelivered",
  "consecutiveErrors",
  "reconciledAt",
  "reconciledReason",
  "runningAtMs",
  "lastError",
]);

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

function normalizeCronSemanticValue(value: unknown): unknown {
  if (typeof value === "string") return value.trimEnd();
  if (Array.isArray(value)) return value.map(normalizeCronSemanticValue);
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (VOLATILE_CRON_KEYS.has(key)) continue;
    out[key] = normalizeCronSemanticValue(inner);
  }
  return out;
}

export function stableCronSemanticDigest(value: unknown): string {
  return JSON.stringify(normalizeCronSemanticValue(value));
}
