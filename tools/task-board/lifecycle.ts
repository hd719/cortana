export type TaskStatus = "ready" | "in_progress" | "completed" | "failed";

export type SessionRow = {
  key?: string;
  label?: string;
  run_id?: string;
  runId?: string;
  sessionId?: string;
  status?: string;
  lastStatus?: string;
  abortedLastRun?: boolean;
};

export type TerminalOutcome = {
  outcome: "completed" | "failed";
  lifecycleEvent: "completed" | "failed" | "timeout" | "killed";
};

export type TransitionRequest = {
  taskId: number;
  from: TaskStatus;
  to: TaskStatus;
  actor: string;
  reason?: string;
  runId?: string;
};

export function classifyTerminalOutcome(row: SessionRow): TerminalOutcome | null {
  const status = String(row.status ?? row.lastStatus ?? "unknown").trim().toLowerCase();

  if (["ok", "done", "completed", "success"].includes(status)) return { outcome: "completed", lifecycleEvent: "completed" };
  if (["timeout", "timed_out"].includes(status)) return { outcome: "failed", lifecycleEvent: "timeout" };
  if (["killed", "kill", "terminated", "aborted", "cancelled", "canceled"].includes(status)) return { outcome: "failed", lifecycleEvent: "killed" };
  if (["failed", "error"].includes(status)) return { outcome: "failed", lifecycleEvent: "failed" };
  if (row.abortedLastRun === true) return { outcome: "failed", lifecycleEvent: "killed" };
  return null;
}

export function buildTransitionEvent(request: TransitionRequest): { eventType: string; severity: "info" | "warning"; message: string; metadata: Record<string, unknown> } {
  const ok = request.from !== request.to;
  return {
    eventType: ok ? "task_state_transition" : "task_state_transition_rejected",
    severity: request.to === "failed" || !ok ? "warning" : "info",
    message: ok
      ? `Task ${request.taskId} moved ${request.from} -> ${request.to}`
      : `Rejected ${request.to} transition for task ${request.taskId}`,
    metadata: {
      task_id: request.taskId,
      actor: request.actor,
      previous_status: request.from,
      result_status: ok ? request.to : request.from,
      reason: request.reason ?? null,
      run_id: request.runId ?? null,
      ok,
    },
  };
}

export function normalizeAssignedAgent(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized === "null" || normalized === "undefined") return null;
  return normalized;
}
