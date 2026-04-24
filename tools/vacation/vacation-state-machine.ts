import fs from "node:fs";
import path from "node:path";
import { loadVacationOpsConfig } from "./vacation-config.js";
import { isFreshReadinessRun } from "./readiness-engine.js";
import { sourceRepoRoot } from "../lib/paths.js";
import {
  archiveVacationMirror,
  buildVacationMirror,
  cancelRunningVacationRuns,
  clearVacationMirror,
  createVacationWindow,
  finishVacationRun,
  getActiveVacationWindow,
  getLatestStagedVacationWindow,
  getLatestReadinessRun,
  getVacationWindow,
  setRuntimeCronJobsEnabled,
  startVacationRun,
  updateVacationWindow,
  writeVacationMirror,
} from "./vacation-state.js";
import type { VacationOpsConfig, VacationRunRow, VacationWindowRow } from "./types.js";

function snapshotJobIds(window: VacationWindowRow | null | undefined, key: string): string[] {
  const value = window?.state_snapshot?.[key];
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function activeStatusForDisable(reason: string): VacationWindowRow["status"] {
  if (reason === "expired") return "expired";
  if (reason === "cancelled") return "cancelled";
  return "completed";
}

function resolveJobNames(jobIds: string[]): string[] {
  if (!jobIds.length) return [];
  try {
    const raw = fs.readFileSync(path.join(sourceRepoRoot(), "config", "cron", "jobs.json"), "utf8");
    const parsed = JSON.parse(raw) as { jobs?: Array<{ id?: string; name?: string }> };
    const nameMap = new Map(
      (parsed.jobs ?? [])
        .map((job) => [String(job.id ?? ""), String(job.name ?? "").trim()] as const)
        .filter(([id, name]) => Boolean(id) && Boolean(name)),
    );
    return jobIds.map((id) => nameMap.get(id) ?? id);
  } catch {
    return jobIds;
  }
}

function buildTransitionSummary(window: VacationWindowRow, kind: "enabled" | "disabled", pausedJobIds: string[]): string {
  const labels = resolveJobNames(pausedJobIds);
  const jobsLine = labels.length ? labels.join(", ") : "none";
  if (kind === "enabled") {
    return `🏖️ Vacation mode enabled.\nWindow ${window.label} active until ${window.end_at}.\nPaused jobs: ${jobsLine}.`;
  }
  return `🏁 Vacation mode disabled.\nWindow ${window.label} resumed normal ops.\nRestored jobs: ${jobsLine}.`;
}

export function unpauseVacationJobs(): {
  window: VacationWindowRow | null;
  summaryText: string;
  restoredJobIds: string[];
  run: VacationRunRow | null;
} {
  const active = getActiveVacationWindow();
  if (!active) {
    return {
      window: null,
      summaryText: "Vacation mode is inactive. No vacation-managed jobs are paused.",
      restoredJobIds: [],
      run: null,
    };
  }

  const pausedJobIds = snapshotJobIds(active, "paused_job_ids");
  if (!pausedJobIds.length) {
    return {
      window: active,
      summaryText: "Vacation mode is active, but no vacation-managed jobs are currently paused.",
      restoredJobIds: [],
      run: null,
    };
  }

  const run = startVacationRun({
    vacationWindowId: active.id,
    runType: "disable",
    triggerSource: "manual_command",
    dryRun: false,
  });
  const restoredJobIds = setRuntimeCronJobsEnabled(pausedJobIds, true);
  const window = updateVacationWindow(active.id, {
    stateSnapshot: {
      ...(active.state_snapshot ?? {}),
      paused_job_ids: [],
      manually_restored_job_ids: restoredJobIds,
    },
  });
  writeVacationMirror(buildVacationMirror(window, getLatestReadinessRun(active.id)?.id ?? null));
  const summaryText = restoredJobIds.length
    ? `⏯️ Vacation jobs resumed.\nWindow ${window.label} kept vacation mode active.\nRestored jobs: ${resolveJobNames(restoredJobIds).join(", ")}.`
    : "Vacation job unpause requested, but no runtime jobs needed changes.";
  const completedRun = finishVacationRun(run.id, {
    state: "completed",
    summaryPayload: { restoredJobIds, kind: "manual_unpause" },
    summaryText,
  });
  return { window, summaryText, restoredJobIds, run: completedRun };
}

export function enableVacationMode(params: {
  config?: VacationOpsConfig;
  vacationWindowId?: number;
  startAt?: string;
  endAt?: string;
  timezone?: string;
  triggerSource?: VacationRunRow["trigger_source"];
}): { window: VacationWindowRow; summaryText: string; pausedJobIds: string[]; run: VacationRunRow } {
  const config = params.config ?? loadVacationOpsConfig();
  if (getActiveVacationWindow()) {
    throw new Error("Vacation mode is already active.");
  }

  let window = params.vacationWindowId ? getVacationWindow(params.vacationWindowId) : null;
  if (!window) {
    if (!params.startAt || !params.endAt) throw new Error("Enable requires an existing prep window or explicit --start and --end.");
    window = createVacationWindow({
      label: `vacation-${String(params.startAt).slice(0, 10)}`,
      status: "prep",
      timezone: params.timezone ?? config.timezone,
      startAt: params.startAt,
      endAt: params.endAt,
      triggerSource: params.triggerSource ?? "manual_command",
      configSnapshot: config as unknown as Record<string, unknown>,
      stateSnapshot: {},
    });
  }

  const latestReadiness = getLatestReadinessRun(window.id);
  if (!isFreshReadinessRun(latestReadiness, config.readinessFreshnessHours)) {
    throw new Error("Cannot enable vacation mode from a stale or non-green readiness run.");
  }
  if (latestReadiness.readiness_outcome !== "pass" && latestReadiness.readiness_outcome !== "warn") {
    throw new Error(`Cannot enable vacation mode from readiness outcome ${String(latestReadiness.readiness_outcome)}`);
  }

  const run = startVacationRun({
    vacationWindowId: window.id,
    runType: "enable",
    triggerSource: params.triggerSource ?? "manual_command",
  });

  const pausedJobIds = setRuntimeCronJobsEnabled(config.pausedJobIds, false);

  window = updateVacationWindow(window.id, {
    status: "active",
    enabledAt: new Date().toISOString(),
    stateSnapshot: {
      ...(window.state_snapshot ?? {}),
      paused_job_ids: pausedJobIds,
      quarantined_job_ids: snapshotJobIds(window, "quarantined_job_ids"),
      latest_readiness_run_id: latestReadiness.id,
    },
  });
  writeVacationMirror(buildVacationMirror(window, latestReadiness.id));
  const summaryText = buildTransitionSummary(window, "enabled", pausedJobIds);
  const completedRun = finishVacationRun(run.id, {
    state: "completed",
    summaryPayload: { pausedJobIds, latestReadinessRunId: latestReadiness.id },
    summaryText,
  });
  return { window, summaryText, pausedJobIds, run: completedRun };
}

export function disableVacationMode(params: {
  config?: VacationOpsConfig;
  reason: "manual" | "expired" | "cancelled";
}): { window: VacationWindowRow | null; summaryText: string; restoredJobIds: string[]; archivedMirrorPath: string | null; run: VacationRunRow | null } {
  const config = params.config ?? loadVacationOpsConfig();
  const active = getActiveVacationWindow();
  if (!active) {
    return {
      window: null,
      summaryText: "Vacation mode was already inactive.",
      restoredJobIds: [],
      archivedMirrorPath: null,
      run: null,
    };
  }

  const run = startVacationRun({
    vacationWindowId: active.id,
    runType: "disable",
    triggerSource: params.reason === "expired" ? "auto_expire" : "manual_command",
  });
  const pausedJobIds = snapshotJobIds(active, "paused_job_ids");
  const restoredJobIds = pausedJobIds.length ? setRuntimeCronJobsEnabled(pausedJobIds, true) : [];

  const window = updateVacationWindow(active.id, {
    status: activeStatusForDisable(params.reason),
    disabledAt: new Date().toISOString(),
    disableReason: params.reason,
    stateSnapshot: {
      ...(active.state_snapshot ?? {}),
      paused_job_ids: [],
      restored_job_ids: restoredJobIds,
    },
  });
  const archivedMirrorPath = archiveVacationMirror();
  clearVacationMirror();
  const summaryText = buildTransitionSummary(window, "disabled", restoredJobIds);
  const completedRun = finishVacationRun(run.id, {
    state: "completed",
    summaryPayload: { restoredJobIds, disableReason: params.reason },
    summaryText,
  });
  return { window, summaryText, restoredJobIds, archivedMirrorPath, run: completedRun };
}

export function cancelStagedVacationWindow(params: {
  windowId?: number;
} = {}): { window: VacationWindowRow | null; summaryText: string; archivedMirrorPath: string | null; cancelledRunCount: number; run: VacationRunRow | null } {
  const active = getActiveVacationWindow();
  if (active && (!params.windowId || active.id === params.windowId)) {
    throw new Error("Vacation mode is active. Disable the active window instead of cancelling staging.");
  }

  const window = params.windowId ? getVacationWindow(params.windowId) : getLatestStagedVacationWindow();
  if (!window || !["prep", "ready", "failed"].includes(window.status)) {
    return {
      window: null,
      summaryText: "No staged vacation window is waiting in preflight or ready state.",
      archivedMirrorPath: null,
      cancelledRunCount: 0,
      run: null,
    };
  }

  const note = `Cancelled staged vacation window ${window.label}.`;
  const cancelledRunCount = cancelRunningVacationRuns(window.id, note);
  const run = startVacationRun({
    vacationWindowId: window.id,
    runType: "disable",
    triggerSource: "manual_command",
  });
  const updated = updateVacationWindow(window.id, {
    status: "cancelled",
    prepCompletedAt: window.prep_completed_at ?? new Date().toISOString(),
    disabledAt: new Date().toISOString(),
    disableReason: "cancelled",
    stateSnapshot: {
      ...(window.state_snapshot ?? {}),
      paused_job_ids: [],
    },
  });
  const archivedMirrorPath = archiveVacationMirror();
  clearVacationMirror();
  const summaryText = `🛑 Vacation staging cancelled.\nWindow ${updated.label} removed from staging.\nCancelled running prep jobs: ${cancelledRunCount}.`;
  const completedRun = finishVacationRun(run.id, {
    state: "completed",
    summaryPayload: { cancelledRunCount, kind: "cancel_staged_window" },
    summaryText,
  });
  return { window: updated, summaryText, archivedMirrorPath, cancelledRunCount, run: completedRun };
}
