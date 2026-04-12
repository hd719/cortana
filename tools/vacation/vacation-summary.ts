import { getActiveVacationWindow, getLatestReadinessRun, listVacationIncidents } from "./vacation-state.js";
import type {
  VacationIncidentRow,
  VacationReadinessOutcome,
  VacationSummaryPayload,
  VacationSummaryPeriod,
  VacationSummaryStatus,
  VacationWindowRow,
} from "./types.js";

function summaryStatus(incidents: VacationIncidentRow[], readinessOutcome: VacationReadinessOutcome | null): VacationSummaryStatus {
  if (incidents.some((incident) => incident.human_required || incident.tier <= 1)) return "red";
  if (incidents.length > 0 || readinessOutcome === "warn") return "yellow";
  return "green";
}

export function buildVacationSummaryPayload(params: {
  window: VacationWindowRow;
  period: VacationSummaryPeriod;
  incidents: VacationIncidentRow[];
  readinessOutcome: VacationReadinessOutcome | null;
  latestReadinessRunId: number | null;
}): VacationSummaryPayload {
  const activeIncidents = params.incidents.filter((incident) => incident.status !== "resolved");
  const resolvedIncidents = params.incidents.filter((incident) => incident.status === "resolved");
  const pausedJobIds = Array.isArray(params.window.state_snapshot?.paused_job_ids)
    ? params.window.state_snapshot.paused_job_ids.map((value: unknown) => String(value))
    : [];
  const degradedSystems = activeIncidents.map((incident) => incident.system_key);
  const overall = summaryStatus(activeIncidents, params.readinessOutcome);
  return {
    window_id: params.window.id,
    period: params.period,
    overall_status: overall,
    readiness_outcome: params.readinessOutcome,
    active_incident_count: activeIncidents.length,
    resolved_incident_count: resolvedIncidents.length,
    human_required_count: activeIncidents.filter((incident) => incident.human_required).length,
    paused_job_ids: pausedJobIds,
    last_transition_at: params.window.disabled_at ?? params.window.enabled_at ?? params.window.updated_at,
    latest_readiness_run_id: params.latestReadinessRunId,
    active_systems: activeIncidents.map((incident) => incident.system_key),
    degraded_systems: degradedSystems,
    self_heal_count: resolvedIncidents.filter((incident) => incident.resolution_reason === "remediated").length,
    degradation_summary: degradedSystems.length ? degradedSystems.slice(0, 3).join(", ") : "none",
  };
}

export function renderVacationSummaryText(payload: VacationSummaryPayload): string {
  const outcome = payload.readiness_outcome ? payload.readiness_outcome.toUpperCase().replace("_", "-") : "N/A";
  const header = `🏖️ Vacation Ops ${payload.period === "morning" ? "AM" : "PM"} | ${payload.overall_status.toUpperCase()}`;
  const line2 = `Readiness ${outcome}. Active ${payload.active_incident_count}, resolved ${payload.resolved_incident_count}, human ${payload.human_required_count}, self-heals ${payload.self_heal_count}.`;
  const line3 = payload.paused_job_ids.length ? `Paused jobs: ${payload.paused_job_ids.length}.` : "Paused jobs: none.";
  const line4 = `Degradations: ${payload.degradation_summary}.`;
  return [header, line2, line3, line4].join("\n");
}

export function summarizeActiveVacation(period: VacationSummaryPeriod): { payload: VacationSummaryPayload; text: string } | null {
  const window = getActiveVacationWindow();
  if (!window) return null;
  const incidents = listVacationIncidents(window.id);
  const latestReadiness = getLatestReadinessRun(window.id);
  const payload = buildVacationSummaryPayload({
    window,
    period,
    incidents,
    readinessOutcome: latestReadiness?.readiness_outcome ?? null,
    latestReadinessRunId: latestReadiness?.id ?? null,
  });
  return { payload, text: renderVacationSummaryText(payload) };
}
