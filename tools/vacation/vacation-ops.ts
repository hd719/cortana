#!/usr/bin/env -S npx tsx
import { createVacationOpsCoordinator } from "./vacation-coordinator.js";
import type { VacationRunRow } from "./types.js";

export { recommendVacationWindow } from "./vacation-coordinator.js";

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

export function runVacationOps(argv = process.argv.slice(2)): number {
  const args = parseVacationOpsArgs(argv);
  const coordinator = createVacationOpsCoordinator();
  try {
    switch (args.command) {
      case "recommend": {
        const payload = coordinator.recommendWindow({
          start: args.start,
          end: args.end,
          timezone: args.timezone,
        });
        console.log(args.json ? JSON.stringify(payload, null, 2) : payload.reason);
        return 0;
      }
      case "prep": {
        const payload = coordinator.prepareWindow({
          windowId: args.windowId,
          start: args.start,
          end: args.end,
          timezone: args.timezone,
        });
        console.log(args.json ? JSON.stringify(payload, null, 2) : `Prep ${payload.readiness.outcome.toUpperCase().replace("_", "-")} for ${payload.window.label}`);
        return payload.readiness.outcome === "fail" || payload.readiness.outcome === "no_go" ? 1 : 0;
      }
      case "readiness": {
        const payload = coordinator.runReadiness({ vacationWindowId: args.windowId ?? null });
        console.log(args.json ? JSON.stringify(payload, null, 2) : payload.outcome.toUpperCase().replace("_", "-"));
        return payload.outcome === "fail" || payload.outcome === "no_go" ? 1 : 0;
      }
      case "enable": {
        const payload = coordinator.enableWindow({
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
        const payload = coordinator.disableWindow({ reason });
        console.log(args.json ? JSON.stringify(payload, null, 2) : payload.summaryText);
        return 0;
      }
      case "cancel": {
        const payload = coordinator.cancelWindow({ windowId: args.windowId });
        console.log(args.json ? JSON.stringify(payload, null, 2) : payload.summaryText);
        return 0;
      }
      case "unpause": {
        const payload = coordinator.unpauseJobs();
        console.log(args.json ? JSON.stringify(payload, null, 2) : payload.summaryText);
        return 0;
      }
      case "summary": {
        const payload = coordinator.summarizeWindow(args.period ?? "morning");
        if (!payload) {
          console.log(args.json ? JSON.stringify({ active: false }, null, 2) : "NO_REPLY");
          return 0;
        }
        console.log(args.json ? JSON.stringify(payload, null, 2) : payload.text);
        return 0;
      }
      case "status": {
        const payload = coordinator.getStatus();
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
