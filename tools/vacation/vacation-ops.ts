#!/usr/bin/env -S npx tsx
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
import { disableVacationMode, enableVacationMode, unpauseVacationJobs } from "./vacation-state-machine.js";
import { summarizeActiveVacation } from "./vacation-summary.js";
import type { VacationRecommendation, VacationRunRow } from "./types.js";

type ParsedArgs = {
  command: string;
  json: boolean;
  windowId?: number;
  start?: string;
  end?: string;
  timezone?: string;
  period?: "morning" | "evening";
  reason?: string;
};

export function parseVacationOpsArgs(argv: string[]): ParsedArgs {
  const [command = "status", ...rest] = argv;
  const parsed: ParsedArgs = { command, json: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--window-id" && rest[i + 1]) parsed.windowId = Number(rest[++i]);
    else if (arg === "--start" && rest[i + 1]) parsed.start = rest[++i];
    else if (arg === "--end" && rest[i + 1]) parsed.end = rest[++i];
    else if (arg === "--timezone" && rest[i + 1]) parsed.timezone = rest[++i];
    else if (arg === "--period" && rest[i + 1]) parsed.period = rest[++i] as "morning" | "evening";
    else if (arg === "--reason" && rest[i + 1]) parsed.reason = rest[++i];
  }
  return parsed;
}

function defaultWindow(configTimezone: string): { start: string; end: string; timezone: string } {
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
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

function prepVacationWindow(args: ParsedArgs) {
  const config = loadVacationOpsConfig();
  const active = getActiveVacationWindow();
  if (active) {
    throw new Error(`Cannot start vacation preflight while vacation mode is already active for ${active.label}. Disable the active window before starting a new prep window.`);
  }
  const defaults = defaultWindow(args.timezone ?? config.timezone);
  let window = args.windowId ? getVacationWindow(args.windowId) : null;
  const recommendation = recommendVacationWindow(args.start ?? defaults.start, args.end ?? defaults.end, args.timezone ?? defaults.timezone);
  if (!window) {
    window = createVacationWindow({
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

  updateVacationWindow(window.id, {
    status: "prep",
    prepStartedAt: new Date().toISOString(),
  });
  const readiness = runVacationReadiness({ config, vacationWindowId: window.id });
  const nextStatus = readiness.outcome === "pass" || readiness.outcome === "warn" ? "ready" : "failed";
  const updated = updateVacationWindow(window.id, {
    status: nextStatus,
    prepCompletedAt: new Date().toISOString(),
  });
  return {
    recommendation,
    readiness,
    window: updated,
  };
}

function statusPayload() {
  const active = getActiveVacationWindow();
  const latestReadiness = active ? getLatestReadinessRun(active.id) : getLatestReadinessRun();
  return {
    activeWindow: active,
    latestReadiness,
    mirror: reconcileVacationMirror(),
  };
}

export function runVacationOps(argv = process.argv.slice(2)): number {
  const args = parseVacationOpsArgs(argv);
  try {
    switch (args.command) {
      case "recommend": {
        const config = loadVacationOpsConfig();
        const defaults = defaultWindow(args.timezone ?? config.timezone);
        const payload = recommendVacationWindow(args.start ?? defaults.start, args.end ?? defaults.end, args.timezone ?? defaults.timezone);
        console.log(args.json ? JSON.stringify(payload, null, 2) : payload.reason);
        return 0;
      }
      case "prep": {
        const payload = prepVacationWindow(args);
        console.log(args.json ? JSON.stringify(payload, null, 2) : `Prep ${payload.readiness.outcome.toUpperCase().replace("_", "-")} for ${payload.window.label}`);
        return payload.readiness.outcome === "fail" || payload.readiness.outcome === "no_go" ? 1 : 0;
      }
      case "readiness": {
        const config = loadVacationOpsConfig();
        const payload = runVacationReadiness({ config, vacationWindowId: args.windowId ?? null });
        console.log(args.json ? JSON.stringify(payload, null, 2) : payload.outcome.toUpperCase().replace("_", "-"));
        return payload.outcome === "fail" || payload.outcome === "no_go" ? 1 : 0;
      }
      case "enable": {
        const payload = enableVacationMode({
          vacationWindowId: args.windowId,
          startAt: args.start,
          endAt: args.end,
          timezone: args.timezone,
          triggerSource: "manual_command",
        });
        console.log(args.json ? JSON.stringify(payload, null, 2) : payload.summaryText);
        return 0;
      }
      case "disable": {
        const reason = (args.reason as "manual" | "expired" | "cancelled" | undefined) ?? "manual";
        const payload = disableVacationMode({ reason });
        console.log(args.json ? JSON.stringify(payload, null, 2) : payload.summaryText);
        return 0;
      }
      case "unpause": {
        const payload = unpauseVacationJobs();
        console.log(args.json ? JSON.stringify(payload, null, 2) : payload.summaryText);
        return 0;
      }
      case "summary": {
        const payload = summarizeActiveVacation(args.period ?? "morning");
        if (!payload) {
          console.log(args.json ? JSON.stringify({ active: false }, null, 2) : "NO_REPLY");
          return 0;
        }
        const run = startVacationRun({
          vacationWindowId: payload.payload.window_id,
          runType: args.period === "evening" ? "summary_evening" : "summary_morning",
          triggerSource: "cron",
          dryRun: false,
        });
        finishVacationRun(run.id, {
          state: "completed",
          summaryStatus: payload.payload.overall_status,
          summaryPayload: payload.payload as unknown as Record<string, unknown>,
          summaryText: payload.text,
        });
        console.log(args.json ? JSON.stringify(payload, null, 2) : payload.text);
        return 0;
      }
      case "status": {
        const payload = statusPayload();
        console.log(args.json ? JSON.stringify(payload, null, 2) : payload.activeWindow ? payload.activeWindow.status : "inactive");
        return 0;
      }
      default:
        throw new Error(`Unknown vacation-ops subcommand: ${args.command}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runVacationOps());
}
