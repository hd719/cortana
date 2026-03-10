import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readJsonFile } from "../lib/json-file.js";

export const STATE_PATH = "/Users/hd/openclaw/memory/circuit-breaker-state.json";
export const POLICY_PATH = "/Users/hd/openclaw/config/provider-fallback-policy.json";
export const DEFAULT_ORDER = ["opus", "codex", "sonnet", "4o-mini"];

const STATE_VERSION = 2;
const WINDOW_SIZE = 10;
const NON_RETRYABLE_TRIP_THRESHOLD = 0.2;
const RETRYABLE_TRIP_COUNT = 3;
const RETRYABLE_TRIP_RATE = 0.5;
const DEFAULT_COOLDOWN_SEC = 300;
const RECOVERY_PROBE_PCT = 0.01;
const SUCCESS_TO_CLOSE = 3;
const ERROR_BURST_WINDOW_SEC = 120;
const ERROR_BURST_COUNT = 3;

const RETRYABLE_CODES = new Set([429, 500, 502, 503, 529]);
const TIMEOUT_CODES = new Set([408, 504, 524]);
const FATAL_CODES = new Set([401, 403]);

export const TIER_MAP: Record<string, number> = {
  opus: 1,
  codex: 1,
  sonnet: 2,
  "4o-mini": 2,
};

export type FailureType = "success" | "auth" | "timeout" | "rate_limit" | "overload" | "non_retryable";
export type Classification = "success" | "retryable" | "fatal" | "non_retryable";

export type CircuitConfig = {
  window_size: number;
  trip_threshold: number;
  retryable_trip_count: number;
  retryable_trip_rate: number;
  cooldown_sec: number;
  recovery_probe_pct: number;
  success_to_close: number;
  error_burst_window_sec: number;
  error_burst_count: number;
};

export type RoutePolicy = {
  circuit_breaker?: Partial<CircuitConfig>;
  providers?: Record<
    string,
    {
      fallback_order?: string[];
      auth?: string;
      timeout?: string;
      rate_limit?: string;
      overload?: string;
      non_retryable?: string;
    }
  >;
};

export type ProviderMetrics = {
  total: number;
  retryable: number;
  retryable_rate: number;
  non_retryable: number;
  fatal: number;
  success: number;
  non_retryable_rate: number;
};

export type ProviderWindowEntry = {
  ts: number;
  status_code: number;
  kind: Classification;
};

export type ProviderErrorBurst = {
  active: boolean;
  count: number;
  threshold: number;
  window_seconds: number;
  started_at: number | null;
  last_error_at: number | null;
  last_status_code: number | null;
  last_triggered_at: string | null;
};

export type ProviderState = {
  provider: string;
  tier: number;
  circuit: "closed" | "open" | "half_open";
  opened_at: number | null;
  half_open_since: number | null;
  window: ProviderWindowEntry[];
  metrics: ProviderMetrics;
  consecutive_successes: number;
  needs_human_page: boolean;
  last_error_code: number | null;
  last_error_kind: Classification | null;
  last_trip_reason: string | null;
  last_trip_at: string | null;
  error_burst: ProviderErrorBurst;
  updated_at: string;
};

export type CircuitState = {
  version: number;
  updated_at: string;
  config: CircuitConfig;
  providers: Record<string, ProviderState>;
};

export type ProviderAvailability = {
  provider: string;
  circuit: "closed" | "open" | "half_open";
  attempt_allowed: boolean;
  probe_required: boolean;
  opened_at: number | null;
  last_trip_reason: string | null;
};

function nowTs(): number {
  return Date.now() / 1000;
}

function iso(ts?: number): string {
  return new Date((ts ?? nowTs()) * 1000).toISOString();
}

function stableStringify(value: unknown, indent = 2): string {
  const seen = new WeakSet();
  const sorter = (val: any): any => {
    if (val && typeof val === "object") {
      if (seen.has(val)) return val;
      seen.add(val);
      if (Array.isArray(val)) return val.map((entry) => sorter(entry));
      const out: Record<string, any> = {};
      for (const key of Object.keys(val).sort()) out[key] = sorter(val[key]);
      return out;
    }
    return val;
  };
  return JSON.stringify(sorter(value), null, indent);
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, stableStringify(data, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function defaultConfig(policy?: RoutePolicy): CircuitConfig {
  return {
    window_size: Number(policy?.circuit_breaker?.window_size ?? WINDOW_SIZE),
    trip_threshold: Number(policy?.circuit_breaker?.trip_threshold ?? NON_RETRYABLE_TRIP_THRESHOLD),
    retryable_trip_count: Number(policy?.circuit_breaker?.retryable_trip_count ?? RETRYABLE_TRIP_COUNT),
    retryable_trip_rate: Number(policy?.circuit_breaker?.retryable_trip_rate ?? RETRYABLE_TRIP_RATE),
    cooldown_sec: Number(policy?.circuit_breaker?.cooldown_sec ?? DEFAULT_COOLDOWN_SEC),
    recovery_probe_pct: Number(policy?.circuit_breaker?.recovery_probe_pct ?? RECOVERY_PROBE_PCT),
    success_to_close: Number(policy?.circuit_breaker?.success_to_close ?? SUCCESS_TO_CLOSE),
    error_burst_window_sec: Number(policy?.circuit_breaker?.error_burst_window_sec ?? ERROR_BURST_WINDOW_SEC),
    error_burst_count: Number(policy?.circuit_breaker?.error_burst_count ?? ERROR_BURST_COUNT),
  };
}

function defaultMetrics(): ProviderMetrics {
  return {
    total: 0,
    retryable: 0,
    retryable_rate: 0,
    non_retryable: 0,
    fatal: 0,
    success: 0,
    non_retryable_rate: 0,
  };
}

function defaultErrorBurst(cfg?: Partial<CircuitConfig>): ProviderErrorBurst {
  return {
    active: false,
    count: 0,
    threshold: Number(cfg?.error_burst_count ?? ERROR_BURST_COUNT),
    window_seconds: Number(cfg?.error_burst_window_sec ?? ERROR_BURST_WINDOW_SEC),
    started_at: null,
    last_error_at: null,
    last_status_code: null,
    last_triggered_at: null,
  };
}

export function defaultState(policy?: RoutePolicy): CircuitState {
  return {
    version: STATE_VERSION,
    updated_at: iso(),
    config: defaultConfig(policy),
    providers: {},
  };
}

export function loadRoutePolicy(): RoutePolicy {
  if (!fs.existsSync(POLICY_PATH)) return {};
  try {
    const data = readJsonFile<RoutePolicy>(POLICY_PATH);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export function loadState(policy?: RoutePolicy): CircuitState {
  const effectivePolicy = policy ?? loadRoutePolicy();
  if (!fs.existsSync(STATE_PATH)) return defaultState(effectivePolicy);

  try {
    const data = readJsonFile<Record<string, any>>(STATE_PATH);
    if (!data || typeof data !== "object") return defaultState(effectivePolicy);

    const migrated = Number(data.version ?? 0) >= STATE_VERSION;
    const config = migrated ? { ...defaultConfig(effectivePolicy), ...(data.config ?? {}) } : defaultConfig(effectivePolicy);
    return {
      version: STATE_VERSION,
      updated_at: String(data.updated_at ?? iso()),
      config,
      providers: (data.providers ?? {}) as Record<string, ProviderState>,
    };
  } catch {
    return defaultState(effectivePolicy);
  }
}

export function saveState(state: CircuitState): void {
  state.version = STATE_VERSION;
  state.updated_at = iso();
  writeJsonAtomic(STATE_PATH, state);
}

export function failureType(statusCode: number): FailureType {
  if (statusCode >= 200 && statusCode < 400) return "success";
  if (FATAL_CODES.has(statusCode)) return "auth";
  if (TIMEOUT_CODES.has(statusCode)) return "timeout";
  if (statusCode === 429) return "rate_limit";
  if ([500, 502, 503, 529].includes(statusCode)) return "overload";
  return "non_retryable";
}

export function classify(statusCode: number): Classification {
  if (statusCode >= 200 && statusCode < 400) return "success";
  if (FATAL_CODES.has(statusCode)) return "fatal";
  if (RETRYABLE_CODES.has(statusCode) || TIMEOUT_CODES.has(statusCode)) return "retryable";
  if (statusCode >= 400) return "non_retryable";
  return "non_retryable";
}

export function providerState(state: CircuitState, provider: string): ProviderState {
  const cfg = state.config ?? defaultConfig();
  if (!state.providers[provider]) {
    state.providers[provider] = {
      provider,
      tier: TIER_MAP[provider] ?? 2,
      circuit: "closed",
      opened_at: null,
      half_open_since: null,
      window: [],
      metrics: defaultMetrics(),
      consecutive_successes: 0,
      needs_human_page: false,
      last_error_code: null,
      last_error_kind: null,
      last_trip_reason: null,
      last_trip_at: null,
      error_burst: defaultErrorBurst(cfg),
      updated_at: iso(),
    };
  }
  const p = state.providers[provider] as ProviderState & Record<string, any>;
  p.provider = String(p.provider ?? provider);
  p.tier = Number(p.tier ?? (TIER_MAP[provider] ?? 2));
  p.circuit = p.circuit === "open" || p.circuit === "half_open" ? p.circuit : "closed";
  p.opened_at = p.opened_at ?? null;
  p.half_open_since = p.half_open_since ?? null;
  p.window = Array.isArray(p.window) ? p.window : [];
  p.metrics = { ...defaultMetrics(), ...(p.metrics ?? {}) };
  p.consecutive_successes = Number(p.consecutive_successes ?? 0);
  p.needs_human_page = Boolean(p.needs_human_page);
  p.last_error_code = p.last_error_code ?? null;
  p.last_error_kind = p.last_error_kind ?? null;
  p.last_trip_reason = p.last_trip_reason ?? null;
  p.last_trip_at = p.last_trip_at ?? null;
  p.error_burst = { ...defaultErrorBurst(cfg), ...(p.error_burst ?? {}) };
  p.updated_at = String(p.updated_at ?? iso());
  refreshErrorBurst(p, cfg);
  return p;
}

function openCircuit(p: ProviderState, reason: string): void {
  p.circuit = "open";
  p.opened_at = nowTs();
  p.half_open_since = null;
  p.consecutive_successes = 0;
  p.last_trip_reason = reason;
  p.last_trip_at = iso();
}

function recomputeMetrics(p: ProviderState, cfg: CircuitConfig): void {
  const window = (p.window ?? []).slice(-Math.max(1, Number(cfg.window_size ?? WINDOW_SIZE)));
  p.window = window;
  const total = window.length;
  const retryable = window.filter((entry) => entry.kind === "retryable").length;
  const nonRetryable = window.filter((entry) => entry.kind === "non_retryable" || entry.kind === "fatal").length;
  const fatal = window.filter((entry) => entry.kind === "fatal").length;
  const success = window.filter((entry) => entry.kind === "success").length;
  p.metrics = {
    total,
    retryable,
    retryable_rate: total ? retryable / total : 0,
    non_retryable: nonRetryable,
    fatal,
    success,
    non_retryable_rate: total ? nonRetryable / total : 0,
  };
}

function refreshErrorBurst(p: ProviderState, cfg: CircuitConfig, referenceTs = nowTs()): void {
  const windowSeconds = Math.max(1, Number(cfg.error_burst_window_sec ?? ERROR_BURST_WINDOW_SEC));
  const threshold = Math.max(1, Number(cfg.error_burst_count ?? ERROR_BURST_COUNT));
  const recentErrors = (p.window ?? []).filter(
    (entry) => entry.kind !== "success" && referenceTs - Number(entry.ts ?? 0) <= windowSeconds,
  );
  const latest = recentErrors[recentErrors.length - 1] ?? null;
  const active = recentErrors.length >= threshold;
  const prior = p.error_burst ?? defaultErrorBurst(cfg);
  p.error_burst = {
    ...prior,
    active,
    count: recentErrors.length,
    threshold,
    window_seconds: windowSeconds,
    started_at: recentErrors[0]?.ts ?? null,
    last_error_at: latest?.ts ?? prior.last_error_at ?? null,
    last_status_code: latest?.status_code ?? prior.last_status_code ?? null,
    last_triggered_at: active ? prior.last_triggered_at ?? iso(referenceTs) : prior.last_triggered_at ?? null,
  };
}

function maybeTransitionForTime(p: ProviderState, cfg: CircuitConfig): void {
  if (p.circuit !== "open" || !p.opened_at) return;
  if (nowTs() - Number(p.opened_at) >= Number(cfg.cooldown_sec ?? DEFAULT_COOLDOWN_SEC)) {
    p.circuit = "half_open";
    p.half_open_since = nowTs();
    p.consecutive_successes = 0;
  }
}

function probeAllowed(provider: string, pct: number): boolean {
  const seed = `${provider}:${Math.floor(Date.now() / 1000)}`;
  const hash = crypto.createHash("sha256").update(seed).digest("hex");
  const bucket = Number.parseInt(hash.slice(0, 8), 16) / 0xffffffff;
  return bucket < pct;
}

export function providerAvailability(state: CircuitState, provider: string): ProviderAvailability {
  const p = providerState(state, provider);
  const cfg = state.config ?? defaultConfig();
  maybeTransitionForTime(p, cfg);
  refreshErrorBurst(p, cfg);

  if (p.circuit === "closed") {
    return {
      provider,
      circuit: p.circuit,
      attempt_allowed: true,
      probe_required: false,
      opened_at: p.opened_at,
      last_trip_reason: p.last_trip_reason,
    };
  }

  if (p.circuit === "half_open") {
    const attemptAllowed = probeAllowed(provider, Number(cfg.recovery_probe_pct ?? RECOVERY_PROBE_PCT));
    return {
      provider,
      circuit: p.circuit,
      attempt_allowed: attemptAllowed,
      probe_required: true,
      opened_at: p.opened_at,
      last_trip_reason: p.last_trip_reason,
    };
  }

  return {
    provider,
    circuit: p.circuit,
    attempt_allowed: false,
    probe_required: false,
    opened_at: p.opened_at,
    last_trip_reason: p.last_trip_reason,
  };
}

export function recordRequest(state: CircuitState, provider: string, statusCode: number): ProviderState {
  const p = providerState(state, provider);
  const cfg = state.config ?? defaultConfig();

  maybeTransitionForTime(p, cfg);

  const kind = classify(statusCode);
  p.last_error_code = kind === "success" ? null : statusCode;
  p.last_error_kind = kind === "success" ? null : kind;

  if (kind === "fatal") {
    p.needs_human_page = true;
  }

  p.window.push({ ts: nowTs(), status_code: statusCode, kind });
  recomputeMetrics(p, cfg);
  refreshErrorBurst(p, cfg);

  if (p.circuit === "closed") {
    if (kind === "fatal") {
      openCircuit(p, "fatal_auth");
    } else if (
      p.metrics.retryable >= Number(cfg.retryable_trip_count ?? RETRYABLE_TRIP_COUNT) &&
      p.metrics.retryable_rate >= Number(cfg.retryable_trip_rate ?? RETRYABLE_TRIP_RATE)
    ) {
      openCircuit(p, "retryable_threshold");
    } else if (p.metrics.non_retryable_rate >= Number(cfg.trip_threshold ?? NON_RETRYABLE_TRIP_THRESHOLD) && p.metrics.total >= 5) {
      openCircuit(p, "non_retryable_threshold");
    }
  } else if (p.circuit === "open") {
    maybeTransitionForTime(p, cfg);
  } else if (p.circuit === "half_open") {
    if (kind === "success") {
      p.consecutive_successes += 1;
      if (p.consecutive_successes >= Number(cfg.success_to_close ?? SUCCESS_TO_CLOSE)) {
        p.circuit = "closed";
        p.opened_at = null;
        p.half_open_since = null;
        p.consecutive_successes = 0;
        p.needs_human_page = false;
      }
    } else {
      openCircuit(p, `half_open_${kind}`);
    }
  }

  if (kind === "success" && p.circuit === "closed") {
    p.needs_human_page = false;
  }

  p.updated_at = iso();
  return p;
}

export function routeFor(provider: string, statusCode: number, state: CircuitState, policy: RoutePolicy): Record<string, any> {
  const kind = failureType(statusCode);
  const cfg = state.config ?? defaultConfig(policy);
  const providerPolicy = policy.providers?.[provider] ?? {};
  const p = providerState(state, provider);
  maybeTransitionForTime(p, cfg);
  refreshErrorBurst(p, cfg);

  const fallbackOrder = (providerPolicy.fallback_order ?? DEFAULT_ORDER).filter((name) => name !== provider);
  const fallbackProvider =
    fallbackOrder.find((name) => providerAvailability(state, name).attempt_allowed) ?? null;

  const availability = providerAvailability(state, provider);

  const configuredAction =
    kind === "auth"
      ? providerPolicy.auth
      : kind === "timeout"
        ? providerPolicy.timeout
        : kind === "rate_limit"
          ? providerPolicy.rate_limit
          : kind === "overload"
            ? providerPolicy.overload
            : providerPolicy.non_retryable;

  let action =
    configuredAction ??
    (kind === "auth"
      ? "page_human"
      : kind === "timeout"
        ? "retry_then_fallback"
        : kind === "rate_limit"
          ? "fallback"
          : kind === "overload"
            ? "fallback"
            : kind === "success"
              ? "none"
              : "page_human");

  if (!availability.attempt_allowed) {
    action = p.needs_human_page ? "page_human" : fallbackProvider ? "fallback" : "backoff";
  }

  return {
    provider,
    status_code: statusCode,
    failure_type: kind,
    action,
    fallback_provider: action === "fallback" || action === "retry_then_fallback" ? fallbackProvider : null,
    fallback_order: fallbackOrder,
    provider_circuit: p.circuit,
    provider_available: availability.attempt_allowed,
    provider_probe_required: availability.probe_required,
    needs_human_page: p.needs_human_page,
    circuit_reason: p.last_trip_reason,
    error_burst_active: p.error_burst.active,
    error_burst: p.error_burst,
  };
}

export function recommendation(state: CircuitState): Record<string, any> {
  const cfg = state.config ?? defaultConfig();

  for (const name of Object.keys(state.providers ?? {})) {
    maybeTransitionForTime(state.providers[name], cfg);
  }

  const tier1 = DEFAULT_ORDER.filter((provider) => (TIER_MAP[provider] ?? 2) === 1);
  const candidates: Array<[string, number, ProviderState]> = [];
  for (const name of tier1) {
    const p = providerState(state, name);
    const availability = providerAvailability(state, name);
    if (availability.attempt_allowed && p.circuit === "closed") {
      candidates.push([name, 0, p]);
    } else if (availability.attempt_allowed && p.circuit === "half_open") {
      candidates.push([name, 1, p]);
    }
  }

  if (candidates.length) {
    candidates.sort((a, b) => {
      if (a[1] !== b[1]) return a[1] - b[1];
      const sa = Number(a[2]?.metrics?.success ?? 0);
      const sb = Number(b[2]?.metrics?.success ?? 0);
      if (sa !== sb) return sb - sa;
      return a[0].localeCompare(b[0]);
    });
    return {
      recommended_provider: candidates[0][0],
      tier: 1,
      reason: "tier1_available",
      tier2_blocked_by_policy: true,
    };
  }

  return {
    recommended_provider: null,
    tier: 1,
    reason: "all_tier1_open_or_probe_not_allowed",
    tier2_blocked_by_policy: true,
  };
}
