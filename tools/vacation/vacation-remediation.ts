import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { externalRepoRoot, sourceRepoRoot } from "../lib/paths.js";
import type {
  VacationActionRow,
  VacationCheckResultRow,
  VacationOpsConfig,
  VacationActionKind,
} from "./types.js";

export type RemediationEnvironment = {
  spawn?: typeof spawnSync;
};

export type RemediationResult = {
  actions: VacationActionRow[];
  finalCheck: VacationCheckResultRow;
  finalState: "resolved" | "unresolved" | "human_required";
};

export type RemediationCheckRunner = (systemKey: string) => VacationCheckResultRow;

function run(env: RemediationEnvironment, cmd: string, args: string[]): SpawnSyncReturns<string> {
  return (env.spawn ?? spawnSync)(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function compact(text: string, max = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

export function isHumanRequiredCheck(result: VacationCheckResultRow): boolean {
  const blob = JSON.stringify(result.detail ?? {});
  return /auth|oauth|token expired|reauth|login|consent|mfa|forbidden|privacy|system settings/i.test(blob);
}

function commandFor(systemKey: string, action: VacationActionKind): [string, string[]] | null {
  switch (action) {
    case "retry":
    case "rerun_smoke":
      return null;
    case "restart_service":
      if (systemKey === "mission_control") {
        return ["bash", [path.join(externalRepoRoot(), "apps", "mission-control", "scripts", "restart-mission-control.sh"), "--skip-build"]];
      }
      if (systemKey === "gateway_service") {
        return ["launchctl", ["kickstart", "-k", `gui/${process.getuid()}/ai.openclaw.gateway`]];
      }
      if (["fitness_service", "schwab_quote_smoke", "backtester_app"].includes(systemKey)) {
        return ["launchctl", ["kickstart", "-k", `gui/${process.getuid()}/com.cortana.fitness-service`]];
      }
      if (systemKey === "browser_cdp") {
        return ["npx", ["tsx", path.join(sourceRepoRoot(), "tools", "monitoring", "browser-cdp-watchdog.ts")]];
      }
      return null;
    case "runtime_sync":
      return ["npx", ["tsx", path.join(sourceRepoRoot(), "tools", "cron", "sync-cron-to-runtime.ts"), "--json"]];
    case "restore_env":
      return ["npx", ["tsx", path.join(sourceRepoRoot(), "tools", "openclaw", "runtime-integrity-check.ts"), "--repair", "--json"]];
    case "rotate_session":
      return ["openclaw", ["sessions", "cleanup", "--all-agents", "--enforce", "--json"]];
    case "alert_only":
      return null;
  }
}

export function runRemediationPlan(params: {
  config: VacationOpsConfig;
  systemKey: string;
  initialCheck: VacationCheckResultRow;
  checkRunner: RemediationCheckRunner;
  vacationWindowId: number;
  runId?: number | null;
  env?: RemediationEnvironment;
}): RemediationResult {
  if (isHumanRequiredCheck(params.initialCheck)) {
    return {
      actions: [],
      finalCheck: params.initialCheck,
      finalState: "human_required",
    };
  }

  const system = params.config.systems[params.systemKey];
  const actions: VacationActionRow[] = [];
  let finalCheck = params.initialCheck;

  for (let index = 0; index < params.config.remediationLadder.length; index += 1) {
    const step = params.config.remediationLadder[index];
    if (!system.remediation.includes(step)) continue;
    const startedAt = new Date().toISOString();
    const command = commandFor(params.systemKey, step);
    let actionStatus: VacationActionRow["action_status"] = "started";
    let verificationStatus: VacationActionRow["verification_status"] = null;
    const detail: Record<string, unknown> = { step, command };

    if (command) {
      const [cmd, args] = command;
      const proc = run(params.env ?? {}, cmd, args);
      detail.commandResult = {
        status: proc.status ?? 1,
        stderr: compact(String(proc.stderr ?? "")),
        stdout: compact(String(proc.stdout ?? "")),
      };
      actionStatus = (proc.status ?? 1) === 0 ? "succeeded" : "failed";
    } else {
      actionStatus = step === "alert_only" ? "blocked" : "succeeded";
    }

    const verification = params.checkRunner(params.systemKey);
    verificationStatus = verification.status;
    finalCheck = {
      ...verification,
      remediation_attempted: true,
      remediation_succeeded: verification.status === "green",
    };

    actions.push({
      vacation_window_id: params.vacationWindowId,
      run_id: params.runId ?? null,
      system_key: params.systemKey,
      step_order: index + 1,
      action_kind: step,
      action_status: actionStatus,
      verification_status: verificationStatus,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      detail,
    });

    if (verification.status === "green") {
      return { actions, finalCheck, finalState: "resolved" };
    }

    if (isHumanRequiredCheck(verification)) {
      return { actions, finalCheck, finalState: "human_required" };
    }
  }

  return { actions, finalCheck, finalState: "unresolved" };
}
