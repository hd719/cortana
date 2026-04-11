import { loadVacationOpsConfig } from "./vacation-config.js";
import { isFreshReadinessRun } from "./readiness-engine.js";
import {
  archiveVacationMirror,
  buildVacationMirror,
  clearVacationMirror,
  createVacationWindow,
  finishVacationRun,
  getActiveVacationWindow,
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

function buildTransitionSummary(window: VacationWindowRow, kind: "enabled" | "disabled", pausedJobIds: string[]): string {
  if (kind === "enabled") {
    return `🏖️ Vacation mode enabled.\nWindow ${window.label} active until ${window.end_at}.\nPaused jobs: ${pausedJobIds.length}.`;
  }
  return `🏁 Vacation mode disabled.\nWindow ${window.label} resumed normal ops.\nRestored jobs: ${pausedJobIds.length}.`;
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
  const latestReadiness = getLatestReadinessRun(params.vacationWindowId ?? null);
  if (!isFreshReadinessRun(latestReadiness, config.readinessFreshnessHours)) {
    throw new Error("Cannot enable vacation mode from a stale or non-green readiness run.");
  }
  if (latestReadiness.readiness_outcome !== "pass" && latestReadiness.readiness_outcome !== "warn") {
    throw new Error(`Cannot enable vacation mode from readiness outcome ${String(latestReadiness.readiness_outcome)}`);
  }
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
