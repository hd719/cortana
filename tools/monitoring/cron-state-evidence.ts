import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type CronJob = {
  id?: string;
  name?: string;
  enabled?: boolean;
  schedule?: {
    kind?: string;
    expr?: string;
    everyMs?: number;
    tz?: string;
  };
  payload?: unknown;
  delivery?: unknown;
  state?: CronJobState;
  [key: string]: unknown;
};

export type CronJobState = {
  lastRunAtMs?: number;
  lastStatus?: string;
  lastRunStatus?: string;
  lastDurationMs?: number;
  nextRunAtMs?: number;
  consecutiveErrors?: number;
  runningAtMs?: number;
  [key: string]: unknown;
};

export type CronRunEntry = {
  ts?: number;
  jobId?: string;
  action?: string;
  status?: string;
  error?: string;
  summary?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
  [key: string]: unknown;
};

export type RuntimeStateFileKind = "jobs-state" | "jobs-json" | "missing";

export type LoadedCronEvidence = {
  sourceConfigPath: string;
  runtimeConfigPath: string;
  runtimeStatePath: string | null;
  runtimeStateFileKind: RuntimeStateFileKind;
  runsDir: string;
  jobs: JobEvidence[];
};

export type JobEvidence = {
  id: string;
  name: string;
  sourceJob: CronJob | null;
  runtimeJob: CronJob | null;
  state: CronJobState;
  stateSource: RuntimeStateFileKind;
  latestFinished: CronRunEntry | null;
  latestSuccess: CronRunEntry | null;
  latestError: CronRunEntry | null;
  semanticDrift: boolean;
};

export type JobClassification =
  | "healthy"
  | "active_failure"
  | "stale_error_state"
  | "unknown"
  | "needs_human"
  | "disabled";

export type ClassifiedCronJob = {
  id: string;
  name: string;
  enabled: boolean;
  classification: JobClassification;
  evidence: string;
  severity: "info" | "warning" | "critical";
  repairable: boolean;
  freshUntil: string | null;
  lastRuntimeStatus: string;
  stateSource: RuntimeStateFileKind;
  latestSuccessAtMs: number | null;
  latestErrorAtMs: number | null;
  semanticDrift: boolean;
};

export type ClassifyOptions = {
  nowMs?: number;
};

export type LoadCronEvidenceOptions = {
  repoRoot?: string;
  runtimeHome?: string;
  sourceConfigPath?: string;
  runtimeConfigPath?: string;
  runtimeStatePath?: string;
  runsDir?: string;
};

const MIN_FRESHNESS_MS = 30 * 60 * 1000;
const DAILY_CAP_MS = 24 * 60 * 60 * 1000;

export function defaultRepoRoot(): string {
  return process.env.CORTANA_SOURCE_REPO ?? process.cwd();
}

export function defaultRuntimeHome(): string {
  return process.env.CORTANA_RUNTIME_HOME ?? os.homedir();
}

export function loadCronEvidence(options: LoadCronEvidenceOptions = {}): LoadedCronEvidence {
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const runtimeHome = options.runtimeHome ?? defaultRuntimeHome();
  const sourceConfigPath = options.sourceConfigPath ?? path.join(repoRoot, "config", "cron", "jobs.json");
  const runtimeConfigPath = options.runtimeConfigPath ?? path.join(runtimeHome, ".openclaw", "cron", "jobs.json");
  const preferredRuntimeStatePath = options.runtimeStatePath ?? path.join(runtimeHome, ".openclaw", "cron", "jobs-state.json");
  const runsDir = options.runsDir ?? path.join(runtimeHome, ".openclaw", "cron", "runs");

  const sourceConfig = readJsonFile(sourceConfigPath);
  const runtimeConfig = readJsonFile(runtimeConfigPath);
  const runtimeState = fs.existsSync(preferredRuntimeStatePath) ? readJsonFile(preferredRuntimeStatePath) : null;
  const runtimeStateFileKind: RuntimeStateFileKind = runtimeState ? "jobs-state" : "jobs-json";
  const runtimeStatePath = runtimeState ? preferredRuntimeStatePath : runtimeConfigPath;

  const sourceJobs = toJobMap(Array.isArray(sourceConfig?.jobs) ? sourceConfig.jobs : []);
  const runtimeJobs = toJobMap(Array.isArray(runtimeConfig?.jobs) ? runtimeConfig.jobs : []);
  const ids = new Set([...sourceJobs.keys(), ...runtimeJobs.keys()]);

  const jobs = [...ids].sort().map((id) => {
    const sourceJob = sourceJobs.get(id) ?? null;
    const runtimeJob = runtimeJobs.get(id) ?? null;
    const state = readRuntimeState(id, runtimeJob, runtimeState, runtimeStateFileKind);
    const runEntries = readRunEntries(path.join(runsDir, `${id}.jsonl`));
    const finished = runEntries.filter((entry) => String(entry.action ?? "") === "finished");
    const latestFinished = latestByTime(finished);
    const latestSuccess = latestByTime(finished.filter((entry) => isOkStatus(entry.status)));
    const latestError = latestByTime(finished.filter((entry) => isErrorStatus(entry.status)));

    const stateSource: RuntimeStateFileKind = runtimeJob ? runtimeStateFileKind : "missing";

    return {
      id,
      name: String(runtimeJob?.name ?? sourceJob?.name ?? id),
      sourceJob,
      runtimeJob,
      state,
      stateSource,
      latestFinished,
      latestSuccess,
      latestError,
      semanticDrift: Boolean(sourceJob && runtimeJob && jobSemanticDigest(sourceJob) !== jobSemanticDigest(runtimeJob)),
    };
  });

  return {
    sourceConfigPath,
    runtimeConfigPath,
    runtimeStatePath,
    runtimeStateFileKind,
    runsDir,
    jobs,
  };
}

export function classifyCronJobs(evidence: LoadedCronEvidence, options: ClassifyOptions = {}): ClassifiedCronJob[] {
  const nowMs = options.nowMs ?? Date.now();
  return evidence.jobs.map((job) => classifyCronJob(job, nowMs));
}

export function classifyCronJob(job: JobEvidence, nowMs: number): ClassifiedCronJob {
  const enabled = job.runtimeJob?.enabled ?? job.sourceJob?.enabled ?? true;
  const stateStatus = normalizeStatus(job.state.lastRunStatus ?? job.state.lastStatus);
  const consecutiveErrors = toNumber(job.state.consecutiveErrors);
  const stateRunAtMs = toNumber(job.state.lastRunAtMs);
  const stateErrorAtMs = (isErrorStatus(stateStatus) || consecutiveErrors > 0) ? stateRunAtMs : 0;
  const latestSuccessAtMs = entryTime(job.latestSuccess);
  const latestErrorAtMs = Math.max(entryTime(job.latestError), stateErrorAtMs);
  const freshnessMs = freshnessWindowMs(job.runtimeJob ?? job.sourceJob);
  const freshAfterMs = nowMs - freshnessMs;
  const freshUntilMs = latestSuccessAtMs > 0 ? latestSuccessAtMs + freshnessMs : null;
  const hasRuntimeState = job.stateSource !== "missing";
  const hasErrorState = isErrorStatus(stateStatus) || consecutiveErrors > 0;
  const hasFreshError = latestErrorAtMs > 0 && latestErrorAtMs >= freshAfterMs && latestErrorAtMs >= latestSuccessAtMs;
  const hasFreshSuccessAfterError = latestSuccessAtMs > 0 && latestSuccessAtMs > latestErrorAtMs && latestSuccessAtMs >= freshAfterMs;
  const hasAnySuccess = latestSuccessAtMs > 0 || isOkStatus(stateStatus);

  const base = {
    id: job.id,
    name: job.name,
    enabled,
    freshUntil: freshUntilMs ? new Date(freshUntilMs).toISOString() : null,
    lastRuntimeStatus: stateStatus || "unknown",
    stateSource: job.stateSource,
    latestSuccessAtMs: latestSuccessAtMs || null,
    latestErrorAtMs: latestErrorAtMs || null,
    semanticDrift: job.semanticDrift,
  };

  if (!enabled) {
    return {
      ...base,
      classification: "disabled",
      evidence: "job_disabled",
      severity: "info",
      repairable: false,
    };
  }

  if (!job.runtimeJob || !hasRuntimeState) {
    return {
      ...base,
      classification: "unknown",
      evidence: "runtime_state_missing",
      severity: "warning",
      repairable: false,
    };
  }

  if (job.semanticDrift) {
    return {
      ...base,
      classification: "unknown",
      evidence: "source_runtime_semantic_drift",
      severity: "warning",
      repairable: false,
    };
  }

  if (hasErrorState && hasFreshSuccessAfterError) {
    return {
      ...base,
      classification: "stale_error_state",
      evidence: "latest_success_after_error",
      severity: "info",
      repairable: true,
    };
  }

  if (hasFreshError) {
    return {
      ...base,
      classification: "active_failure",
      evidence: "fresh_error_evidence",
      severity: "critical",
      repairable: false,
    };
  }

  if (hasErrorState) {
    return {
      ...base,
      classification: "unknown",
      evidence: "stale_error_without_fresh_success",
      severity: "warning",
      repairable: false,
    };
  }

  if (hasAnySuccess) {
    return {
      ...base,
      classification: "healthy",
      evidence: latestSuccessAtMs ? "latest_success" : "runtime_state_ok",
      severity: "info",
      repairable: false,
    };
  }

  return {
    ...base,
    classification: "unknown",
    evidence: "no_run_evidence",
    severity: "warning",
    repairable: false,
  };
}

export function freshnessWindowMs(job: CronJob | null): number {
  const intervalMs = scheduleIntervalMs(job);
  return Math.min(Math.max(intervalMs * 2, MIN_FRESHNESS_MS), DAILY_CAP_MS);
}

export function scheduleIntervalMs(job: CronJob | null): number {
  if (!job?.schedule) return DAILY_CAP_MS;
  if (job.schedule.kind === "interval" && Number.isFinite(Number(job.schedule.everyMs))) {
    return Math.max(1, Number(job.schedule.everyMs));
  }
  if (job.schedule.kind !== "cron" || typeof job.schedule.expr !== "string") {
    return DAILY_CAP_MS;
  }

  const fields = job.schedule.expr.trim().split(/\s+/);
  if (fields.length !== 5) return DAILY_CAP_MS;
  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = fields;

  if (dayOfMonthField !== "*" || monthField !== "*" || dayOfWeekField !== "*") {
    return DAILY_CAP_MS;
  }

  const minuteInterval = intervalFromField(minuteField, 0, 59);
  const hourInterval = intervalFromField(hourField, 0, 23);
  const minuteValues = valuesFromField(minuteField, 0, 59);
  const hourValues = valuesFromField(hourField, 0, 23);

  if (hourField === "*" && minuteInterval > 0) return minuteInterval * 60 * 1000;
  if (minuteValues.length === 1 && hourInterval > 0) return hourInterval * 60 * 60 * 1000;
  if (minuteValues.length === 1 && hourValues.length > 1) return minGap(hourValues) * 60 * 60 * 1000;
  return DAILY_CAP_MS;
}

function readJsonFile(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function toJobMap(jobs: unknown[]): Map<string, CronJob> {
  const map = new Map<string, CronJob>();
  for (const value of jobs) {
    const job = value as CronJob;
    const id = typeof job.id === "string" ? job.id : "";
    if (id) map.set(id, job);
  }
  return map;
}

function readRuntimeState(
  id: string,
  runtimeJob: CronJob | null,
  runtimeState: any,
  stateFileKind: RuntimeStateFileKind,
): CronJobState {
  if (stateFileKind === "jobs-state") {
    const state = runtimeState?.jobs?.[id]?.state;
    return isObject(state) ? { ...state } : {};
  }
  return isObject(runtimeJob?.state) ? { ...runtimeJob?.state } : {};
}

function readRunEntries(filePath: string): CronRunEntry[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-500)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as CronRunEntry];
      } catch {
        return [];
      }
    });
}

function latestByTime(entries: CronRunEntry[]): CronRunEntry | null {
  let latest: CronRunEntry | null = null;
  for (const entry of entries) {
    if (!latest || entryTime(entry) > entryTime(latest)) latest = entry;
  }
  return latest;
}

function entryTime(entry: CronRunEntry | null): number {
  if (!entry) return 0;
  return Math.max(toNumber(entry.runAtMs), toNumber(entry.ts));
}

function normalizeStatus(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function isOkStatus(value: unknown): boolean {
  return normalizeStatus(value) === "ok" || normalizeStatus(value) === "success";
}

function isErrorStatus(value: unknown): boolean {
  const status = normalizeStatus(value);
  return status === "error" || status === "failed" || status === "failure";
}

function toNumber(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function jobSemanticDigest(job: CronJob): string {
  return stableStringify({
    enabled: job.enabled,
    schedule: job.schedule ?? null,
    payload: job.payload ?? null,
    delivery: job.delivery ?? null,
  });
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (typeof value === "string") return value.trimEnd();
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortObject(value[key])]),
  );
}

function intervalFromField(field: string, min: number, max: number): number {
  const trimmed = field.trim();
  if (trimmed === "*") return 1;
  const stepMatch = trimmed.match(/^\*\/(\d+)$/);
  if (stepMatch) return Number(stepMatch[1]);
  const values = valuesFromField(trimmed, min, max);
  if (values.length < 2) return 0;
  return minGap(values);
}

function valuesFromField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const token of field.split(",")) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const stepMatch = trimmed.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = Number(stepMatch[1]);
      for (let value = min; value <= max; value += step) values.add(value);
      continue;
    }
    if (trimmed === "*") {
      for (let value = min; value <= max; value += 1) values.add(value);
      continue;
    }
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      for (let value = start; value <= end; value += 1) {
        if (value >= min && value <= max) values.add(value);
      }
      continue;
    }
    const value = Number(trimmed);
    if (Number.isFinite(value) && value >= min && value <= max) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

function minGap(values: number[]): number {
  if (values.length < 2) return 24;
  let gap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < values.length; i += 1) {
    gap = Math.min(gap, values[i] - values[i - 1]);
  }
  return gap;
}
