export type VacationTier = 0 | 1 | 2 | 3;

export type VacationWindowStatus =
  | "prep"
  | "ready"
  | "active"
  | "completed"
  | "cancelled"
  | "expired"
  | "failed";

export type VacationDisableReason = "manual" | "expired" | "cancelled" | "failed_enable";
export type VacationTriggerSource = "manual_command" | "natural_language" | "calendar_recommendation" | "cron" | "auto_expire";
export type VacationRunType =
  | "recommend"
  | "prep"
  | "readiness"
  | "enable"
  | "disable"
  | "summary_morning"
  | "summary_evening"
  | "manual_recheck";

export type VacationReadinessOutcome = "pass" | "warn" | "fail" | "no_go";
export type VacationRunState = "running" | "completed" | "failed" | "cancelled";
export type VacationCheckStatus = "green" | "yellow" | "red" | "info" | "warn" | "fail" | "skipped";
export type VacationIncidentStatus = "open" | "degraded" | "human_required" | "resolved";
export type VacationActionStatus = "started" | "succeeded" | "failed" | "skipped" | "blocked";
export type VacationSummaryStatus = "green" | "yellow" | "red";
export type VacationSummaryPeriod = "morning" | "evening";
export type VacationActionKind =
  | "retry"
  | "restart_service"
  | "runtime_sync"
  | "restore_env"
  | "rotate_session"
  | "rerun_smoke"
  | "alert_only";

export type Tier2ThresholdClass = "market_trading" | "fitness_news" | "background_intel";

export type VacationSystemDefinition = {
  tier: VacationTier;
  required: boolean;
  tier2Class?: Tier2ThresholdClass;
  probe: string;
  freshnessSource: string;
  remediation: VacationActionKind[];
};

export type VacationTier2Thresholds = {
  market_trading: {
    warnAfterMinutesMarketHours: number;
    warnBeforeNextOpenMinutes: number;
    warnAfterConsecutiveFailures: number;
  };
  fitness_news: {
    warnAfterConsecutiveFailures: number;
    warnAfterStaleHours: number;
  };
  background_intel: {
    warnAfterConsecutiveFailures: number;
    warnAfterStaleHours: number;
  };
};

export type VacationOpsConfig = {
  version: number;
  timezone: string;
  summaryTimes: {
    morning: string;
    evening: string;
  };
  readinessFreshnessHours: number;
  authorizationFreshnessHours: number;
  pausedJobIds: string[];
  remediationLadder: VacationActionKind[];
  guard: {
    fragileCronMatchers: string[];
    quarantineAfterConsecutiveErrors: number;
  };
  tier2Thresholds: VacationTier2Thresholds;
  systems: Record<string, VacationSystemDefinition>;
};

export type VacationWindowRow = {
  id: number;
  label: string;
  status: VacationWindowStatus;
  timezone: string;
  start_at: string;
  end_at: string;
  prep_recommended_at?: string | null;
  prep_started_at?: string | null;
  prep_completed_at?: string | null;
  enabled_at?: string | null;
  disabled_at?: string | null;
  disable_reason?: VacationDisableReason | null;
  trigger_source: VacationTriggerSource;
  created_by: string;
  config_snapshot: Record<string, unknown>;
  state_snapshot: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type VacationRunRow = {
  id: number;
  vacation_window_id?: number | null;
  run_type: VacationRunType;
  trigger_source: VacationTriggerSource;
  dry_run: boolean;
  readiness_outcome?: VacationReadinessOutcome | null;
  summary_status?: VacationSummaryStatus | null;
  summary_payload: Record<string, unknown>;
  summary_text: string;
  started_at: string;
  completed_at?: string | null;
  state: VacationRunState;
};

export type VacationCheckResultRow = {
  id?: number;
  run_id?: number;
  system_key: string;
  tier: VacationTier;
  status: VacationCheckStatus;
  observed_at: string;
  freshness_at?: string | null;
  remediation_attempted?: boolean;
  remediation_succeeded?: boolean;
  autonomy_incident_id?: number | null;
  incident_key?: string | null;
  detail: Record<string, unknown>;
};

export type VacationIncidentRow = {
  id: number;
  vacation_window_id: number;
  run_id?: number | null;
  latest_check_result_id?: number | null;
  latest_action_id?: number | null;
  system_key: string;
  tier: VacationTier;
  status: VacationIncidentStatus;
  human_required: boolean;
  first_observed_at: string;
  last_observed_at: string;
  resolved_at?: string | null;
  resolution_reason?: string | null;
  symptom?: string | null;
  detail: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type VacationActionRow = {
  id?: number;
  vacation_window_id: number;
  run_id?: number | null;
  autonomy_incident_id?: number | null;
  incident_key?: string | null;
  system_key: string;
  step_order: number;
  action_kind: VacationActionKind;
  action_status: VacationActionStatus;
  verification_status?: VacationCheckStatus | null;
  started_at?: string;
  completed_at?: string | null;
  detail: Record<string, unknown>;
};

export type VacationSummaryPayload = {
  window_id: number;
  period: VacationSummaryPeriod;
  overall_status: VacationSummaryStatus;
  readiness_outcome: VacationReadinessOutcome | null;
  active_incident_count: number;
  resolved_incident_count: number;
  human_required_count: number;
  paused_job_ids: string[];
  last_transition_at: string | null;
  latest_readiness_run_id: number | null;
  active_systems: string[];
  degraded_systems: string[];
  self_heal_count: number;
  degradation_summary: string;
};

export type VacationMirrorState = {
  enabled: boolean;
  windowId: number;
  status: VacationWindowStatus;
  timezone: string;
  startAt: string;
  endAt: string;
  pausedJobIds: string[];
  latestReadinessRunId: number | null;
  lastTransitionAt: string | null;
};

export type VacationRecommendation = {
  timezone: string;
  recommended_prep_at: string;
  start_at: string;
  end_at: string;
  reason: string;
};
