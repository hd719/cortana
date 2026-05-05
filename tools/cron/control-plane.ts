type CronJob = Record<string, unknown>;
type CronConfig = { jobs?: CronJob[]; [key: string]: unknown };

type CronDelivery = { mode?: string; to?: string };

export type CommandJobSpec = {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  quietSuccess: string;
  owner: string;
  alertType?: string;
  severity?: string;
  system?: string;
  actionNeeded?: string;
  allowEmptySuccess?: boolean;
};

type RuntimeStateKey =
  | "state"
  | "updatedAtMs"
  | "lastRunAtMs"
  | "nextRunAtMs"
  | "lastStatus"
  | "lastRunStatus"
  | "lastDurationMs"
  | "lastDeliveryStatus"
  | "lastDelivered"
  | "consecutiveErrors"
  | "reconciledAt"
  | "reconciledReason"
  | "runningAtMs"
  | "lastError";

const RUNTIME_STATE_KEYS = new Set<RuntimeStateKey>([
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

const APPROVED_MANAGED_RUNTIME_JOB_MARKERS = new Set(["memory-core.short-term-promotion"]);

const toRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const toText = (value: unknown): string => (typeof value === "string" ? value : "");
const toTextArray = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

function extractManagedByMarker(job: CronJob): string | null {
  const description = typeof job.description === "string" ? job.description : "";
  return description.match(/\[managed-by=([^\]]+)\]/)?.[1] ?? null;
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
  return { ...runtimeConfig, jobs: runtimeJobs.filter((job) => !isApprovedManagedRuntimeOnlyJob(job)) };
}

function normalizeCronSemanticValue(value: unknown): unknown {
  if (typeof value === "string") return value.trimEnd();
  if (Array.isArray(value)) return value.map(normalizeCronSemanticValue);
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (RUNTIME_STATE_KEYS.has(key as RuntimeStateKey)) continue;
    out[key] = normalizeCronSemanticValue(inner);
  }
  return out;
}

export function stableCronSemanticDigest(value: unknown): string {
  return JSON.stringify(normalizeCronSemanticValue(value));
}

export function mergeRuntimeCronState(repoConfig: CronConfig, runtimeConfig: CronConfig): CronConfig {
  const repoJobs = Array.isArray(repoConfig.jobs) ? repoConfig.jobs : [];
  const runtimeJobs = Array.isArray(runtimeConfig.jobs) ? runtimeConfig.jobs : [];
  const runtimeById = new Map(runtimeJobs.map((job) => [String(job.id ?? ""), job]));
  const { approvedManagedRuntimeOnlyJobs } = splitRuntimeOnlyJobs(repoConfig, runtimeConfig);

  const mergedJobs = repoJobs.map((repoJob) => {
    const runtimeJob = runtimeById.get(String(repoJob.id ?? ""));
    if (!runtimeJob) return repoJob;
    const merged: CronJob = { ...repoJob };
    for (const [key, value] of Object.entries(runtimeJob)) {
      if (RUNTIME_STATE_KEYS.has(key as RuntimeStateKey)) merged[key] = value;
    }
    return merged;
  });

  return { ...repoConfig, jobs: [...mergedJobs, ...approvedManagedRuntimeOnlyJobs] };
}

export function expectsSilentSuccess(job: CronJob): boolean {
  const delivery = toRecord(job.delivery) as CronDelivery | null;
  const mode = typeof delivery?.mode === "string" ? delivery.mode.trim().toLowerCase() : "";
  if (mode === "none") return true;

  const to = typeof delivery?.to === "string" ? delivery.to.trim().toUpperCase() : "";
  if (to === "NO_REPLY") return true;

  const payload = toRecord(job.payload);
  const message = toText(payload?.message);
  return ["NO_REPLY", "output NOTHING", "return NOTHING", "return exactly NO_REPLY", "stay silent", "silent, no message", "If healthy: output NOTHING"]
    .some((hint) => message.includes(hint));
}

function normalizeCommandJobSpec(raw: unknown, fallbackId: string): CommandJobSpec | null {
  const spec = toRecord(raw);
  if (!spec) return null;

  const command = toText(spec.command).trim();
  const cwd = toText(spec.cwd).trim();
  const quietSuccess = toText(spec.quietSuccess || "NO_REPLY").trim();
  const timeoutMs = Number(spec.timeoutMs);
  if (!command || !cwd || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;

  return {
    id: toText(spec.id).trim() || fallbackId,
    command,
    args: toTextArray(spec.args),
    cwd,
    timeoutMs,
    quietSuccess: quietSuccess || "NO_REPLY",
    owner: toText(spec.owner).trim() || "monitor",
    alertType: toText(spec.alertType).trim() || undefined,
    severity: toText(spec.severity).trim() || undefined,
    system: toText(spec.system).trim() || undefined,
    actionNeeded: toText(spec.actionNeeded).trim() || undefined,
    allowEmptySuccess: spec.allowEmptySuccess === true,
  };
}

export function getCommandJobSpec(job: CronJob): CommandJobSpec | null {
  const id = String(job.id ?? "");
  const metadata = toRecord(job.metadata);
  const fromMetadata = normalizeCommandJobSpec(metadata?.commandJobSpec, id);
  if (fromMetadata) return fromMetadata;

  const payload = toRecord(job.payload);
  if (payload?.kind !== "command") return null;
  return normalizeCommandJobSpec(payload, id);
}

export function validateCommandJobConfig(config: CronConfig): string[] {
  const jobs = Array.isArray(config.jobs) ? config.jobs : [];
  const errors: string[] = [];

  for (const job of jobs) {
    const id = String(job.id ?? "<missing-id>");
    if (job.type === "command") {
      errors.push(`${id}: top-level type=command is invalid; use payload.kind=command or metadata.commandJobSpec`);
    }

    const metadata = toRecord(job.metadata);
    if (metadata?.commandJobSpec !== undefined && !normalizeCommandJobSpec(metadata.commandJobSpec, id)) {
      errors.push(`${id}: metadata.commandJobSpec is incomplete or invalid`);
    }

    const payload = toRecord(job.payload);
    if (payload?.kind === "command" && !normalizeCommandJobSpec(payload, id)) {
      errors.push(`${id}: payload.kind=command is incomplete or invalid`);
    }
  }

  return errors;
}
