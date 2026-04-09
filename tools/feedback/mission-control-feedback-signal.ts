type FeedbackSignalState = "active" | "cleared";

type FeedbackSignalInput = {
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  recurrenceKey: string;
  details?: Record<string, unknown>;
  signalState: FeedbackSignalState;
  source?: "system" | "user" | "evaluator";
  actor?: string | null;
  agentId?: string | null;
  owner?: string | null;
  runId?: string | null;
  taskId?: string | null;
};

type FeedbackSignalResult = {
  ok: boolean;
  skipped?: boolean;
  state?: string;
  id?: string | null;
};

export function resolveMissionControlBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.MISSION_CONTROL_BASE_URL?.trim() || env.MISSION_CONTROL_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  if (env.NODE_ENV === "test" || env.VITEST) return null;
  return "http://127.0.0.1:3000";
}

function buildHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = env.MISSION_CONTROL_API_TOKEN?.trim();
  if (token) headers["x-api-key"] = token;
  return headers;
}

export async function reconcileMissionControlFeedbackSignal(
  input: FeedbackSignalInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FeedbackSignalResult> {
  const baseUrl = resolveMissionControlBaseUrl(env);
  if (!baseUrl) return { ok: true, skipped: true };

  try {
    const response = await fetch(`${baseUrl}/api/feedback/ingest`, {
      method: "POST",
      headers: buildHeaders(env),
      body: JSON.stringify({
        source: input.source ?? "system",
        category: input.category,
        severity: input.severity,
        summary: input.summary,
        details: {
          producer_kind: "signal",
          ...(input.details ?? {}),
        },
        recurrence_key: input.recurrenceKey,
        signal_state: input.signalState,
        actor: input.actor ?? null,
        agent_id: input.agentId ?? null,
        owner: input.owner ?? null,
        run_id: input.runId ?? null,
        task_id: input.taskId ?? null,
      }),
    });

    if (!response.ok) {
      return { ok: false };
    }

    const payload = await response.json().catch(() => ({}));
    return {
      ok: true,
      id: payload?.id ?? null,
      state: payload?.state ? String(payload.state) : undefined,
    };
  } catch {
    return { ok: false };
  }
}
