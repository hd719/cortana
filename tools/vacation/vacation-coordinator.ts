import { loadVacationOpsConfig } from "./vacation-config.js";
import { runVacationReadiness } from "./readiness-engine.js";
import {
  createVacationWindow,
  finishVacationRun,
  getActiveVacationWindow,
  getLatestReadinessRun,
  getVacationWindow,
  reconcileVacationMirror,
  startVacationRun,
  updateVacationWindow,
} from "./vacation-state.js";
import { cancelStagedVacationWindow, disableVacationMode, enableVacationMode, unpauseVacationJobs } from "./vacation-state-machine.js";
import { summarizeActiveVacation } from "./vacation-summary.js";
import type {
  VacationDisableReason,
  VacationMirrorState,
  VacationOpsConfig,
  VacationRecommendation,
  VacationRunRow,
  VacationSummaryPeriod,
  VacationWindowRow,
} from "./types.js";

export type VacationCoordinatorPrepareInput = {
  windowId?: number;
  start?: string;
  end?: string;
  timezone?: string;
};

export type VacationCoordinatorReadinessInput = {
  vacationWindowId?: number | null;
  systemKeys?: string[];
  triggerSource?: VacationRunRow["trigger_source"];
};

export type VacationCoordinatorEnableInput = {
  vacationWindowId?: number;
  startAt?: string;
  endAt?: string;
  timezone?: string;
  triggerSource?: VacationRunRow["trigger_source"];
};

export type VacationCoordinatorDisableInput = {
  reason: VacationDisableReason;
};

export type VacationCoordinatorStatus = {
  activeWindow: VacationWindowRow | null;
  latestReadiness: VacationRunRow | null;
  mirror: VacationMirrorState | null;
};

export type VacationPrepareResult = {
  recommendation: VacationRecommendation;
  readiness: ReturnType<typeof runVacationReadiness>;
  window: VacationWindowRow;
};

type VacationOpsCoordinatorDeps = {
  loadConfig: () => VacationOpsConfig;
  getActiveVacationWindow: () => VacationWindowRow | null;
  getVacationWindow: (windowId: number) => VacationWindowRow | null;
  createVacationWindow: typeof createVacationWindow;
  updateVacationWindow: typeof updateVacationWindow;
  getLatestReadinessRun: typeof getLatestReadinessRun;
  reconcileVacationMirror: () => VacationMirrorState | null;
  runVacationReadiness: typeof runVacationReadiness;
  startVacationRun: typeof startVacationRun;
  finishVacationRun: typeof finishVacationRun;
  enableVacationMode: typeof enableVacationMode;
  disableVacationMode: typeof disableVacationMode;
  cancelStagedVacationWindow: typeof cancelStagedVacationWindow;
  unpauseVacationJobs: typeof unpauseVacationJobs;
  summarizeActiveVacation: typeof summarizeActiveVacation;
  now: () => Date;
};

export type VacationOpsCoordinator = {
  recommendWindow: (input?: Pick<VacationCoordinatorPrepareInput, "start" | "end" | "timezone">) => VacationRecommendation;
  prepareWindow: (input: VacationCoordinatorPrepareInput) => VacationPrepareResult;
  runReadiness: (input?: VacationCoordinatorReadinessInput) => ReturnType<typeof runVacationReadiness>;
  enableWindow: (input?: VacationCoordinatorEnableInput) => ReturnType<typeof enableVacationMode>;
  disableWindow: (input: VacationCoordinatorDisableInput) => ReturnType<typeof disableVacationMode>;
  cancelWindow: (input?: { windowId?: number }) => ReturnType<typeof cancelStagedVacationWindow>;
  unpauseJobs: () => ReturnType<typeof unpauseVacationJobs>;
  summarizeWindow: (period: VacationSummaryPeriod) => (ReturnType<typeof summarizeActiveVacation> & { run: VacationRunRow | null }) | null;
  getStatus: () => VacationCoordinatorStatus;
};

const defaultDeps: VacationOpsCoordinatorDeps = {
  loadConfig: loadVacationOpsConfig,
  getActiveVacationWindow,
  getVacationWindow,
  createVacationWindow,
  updateVacationWindow,
  getLatestReadinessRun,
  reconcileVacationMirror,
  runVacationReadiness,
  startVacationRun,
  finishVacationRun,
  enableVacationMode,
  disableVacationMode,
  cancelStagedVacationWindow,
  unpauseVacationJobs,
  summarizeActiveVacation,
  now: () => new Date(),
};

function defaultWindow(now: Date, configTimezone: string): { start: string; end: string; timezone: string } {
  const start = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    timezone: configTimezone,
  };
}

export function recommendVacationWindow(startAt: string, endAt: string, timezone: string): VacationRecommendation {
  const recommended = new Date(Date.parse(startAt) - 24 * 60 * 60 * 1000).toISOString();
  return {
    timezone,
    recommended_prep_at: recommended,
    start_at: startAt,
    end_at: endAt,
    reason: "Start prep roughly 24 hours before departure so auth refreshes and exact smokes can be rerun before leaving.",
  };
}

export function createVacationOpsCoordinator(overrides: Partial<VacationOpsCoordinatorDeps> = {}): VacationOpsCoordinator {
  const deps = { ...defaultDeps, ...overrides };

  return {
    recommendWindow(input = {}) {
      const config = deps.loadConfig();
      const defaults = defaultWindow(deps.now(), input.timezone ?? config.timezone);
      return recommendVacationWindow(input.start ?? defaults.start, input.end ?? defaults.end, input.timezone ?? defaults.timezone);
    },

    prepareWindow(input) {
      const config = deps.loadConfig();
      const active = deps.getActiveVacationWindow();
      if (active) {
        throw new Error(`Cannot start vacation preflight while vacation mode is already active for ${active.label}. Disable the active window before starting a new prep window.`);
      }

      const defaults = defaultWindow(deps.now(), input.timezone ?? config.timezone);
      let window = input.windowId ? deps.getVacationWindow(input.windowId) : null;
      const recommendation = recommendVacationWindow(input.start ?? defaults.start, input.end ?? defaults.end, input.timezone ?? defaults.timezone);

      if (!window) {
        window = deps.createVacationWindow({
          label: `vacation-${recommendation.start_at.slice(0, 10)}`,
          status: "prep",
          timezone: recommendation.timezone,
          startAt: recommendation.start_at,
          endAt: recommendation.end_at,
          prepRecommendedAt: recommendation.recommended_prep_at,
          triggerSource: "manual_command",
          configSnapshot: config as unknown as Record<string, unknown>,
          stateSnapshot: {},
        });
      }

      deps.updateVacationWindow(window.id, {
        status: "prep",
        prepStartedAt: deps.now().toISOString(),
      });

      try {
        const readiness = deps.runVacationReadiness({ config, vacationWindowId: window.id });
        const nextStatus = readiness.outcome === "pass" || readiness.outcome === "warn" ? "ready" : "failed";
        const updated = deps.updateVacationWindow(window.id, {
          status: nextStatus,
          prepCompletedAt: deps.now().toISOString(),
        });
        return {
          recommendation,
          readiness,
          window: updated,
        };
      } catch (error) {
        deps.updateVacationWindow(window.id, {
          status: "failed",
          prepCompletedAt: deps.now().toISOString(),
        });
        throw error;
      }
    },

    runReadiness(input = {}) {
      const config = deps.loadConfig();
      return deps.runVacationReadiness({
        config,
        vacationWindowId: input.vacationWindowId ?? null,
        systemKeys: input.systemKeys,
        triggerSource: input.triggerSource,
      });
    },

    enableWindow(input = {}) {
      return deps.enableVacationMode(input);
    },

    disableWindow(input) {
      return deps.disableVacationMode(input);
    },

    cancelWindow(input = {}) {
      return deps.cancelStagedVacationWindow(input);
    },

    unpauseJobs() {
      return deps.unpauseVacationJobs();
    },

    summarizeWindow(period) {
      const summary = deps.summarizeActiveVacation(period);
      if (!summary) return null;
      const run = deps.startVacationRun({
        vacationWindowId: summary.payload.window_id,
        runType: period === "evening" ? "summary_evening" : "summary_morning",
        triggerSource: "cron",
        dryRun: false,
      });
      const completedRun = deps.finishVacationRun(run.id, {
        state: "completed",
        summaryStatus: summary.payload.overall_status,
        summaryPayload: summary.payload as unknown as Record<string, unknown>,
        summaryText: summary.text,
      });
      return {
        ...summary,
        run: completedRun,
      };
    },

    getStatus() {
      const active = deps.getActiveVacationWindow();
      const latestReadiness = active ? deps.getLatestReadinessRun(active.id) : deps.getLatestReadinessRun();
      return {
        activeWindow: active,
        latestReadiness,
        mirror: deps.reconcileVacationMirror(),
      };
    },
  };
}
