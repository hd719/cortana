#!/usr/bin/env npx tsx

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readJsonFile } from "../lib/json-file.js";

const STATE_PATH = "/Users/hd/openclaw/memory/circuit-breaker-state.json";
const POLICY_PATH = "/Users/hd/openclaw/config/provider-fallback-policy.json";
const WINDOW_SIZE = 50;
const TRIP_THRESHOLD = 0.2;
const DEFAULT_COOLDOWN_SEC = 60;
const RECOVERY_PROBE_PCT = 0.01;
const SUCCESS_TO_CLOSE = 50;

const RETRYABLE_CODES = new Set([429, 500, 502, 503, 529]);
const TIMEOUT_CODES = new Set([408, 504, 524]);
const FATAL_CODES = new Set([401, 403]);

const TIER_MAP: Record<string, number> = {
  opus: 1,
  codex: 1,
  sonnet: 2,
  "4o-mini": 2,
};
const DEFAULT_ORDER = ["opus", "codex", "sonnet", "4o-mini"];

type CircuitState = {
  version: number;
  updated_at: string;
  config: {
    window_size: number;
    trip_threshold: number;
    cooldown_sec: number;
    recovery_probe_pct: number;
    success_to_close: number;
  };
  providers: Record<string, any>;
};

type FailureType = "success" | "auth" | "timeout" | "rate_limit" | "overload" | "non_retryable";
type RoutePolicy = {
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

function nowTs(): number {
  return Date.now() / 1000;
}

function iso(ts?: number): string {
  return new Date((ts ?? nowTs()) * 1000).toISOString();
}

function stableStringify(value: any, indent = 2): string {
  const seen = new WeakSet();
  const sorter = (val: any): any => {
    if (val && typeof val === "object") {
      if (seen.has(val)) return val;
      seen.add(val);
      if (Array.isArray(val)) return val.map((v) => sorter(v));
      const out: Record<string, any> = {};
      for (const key of Object.keys(val).sort()) {
        out[key] = sorter(val[key]);
      }
      return out;
    }
    return val;
  };
  return JSON.stringify(sorter(value), null, indent);
}

function writeJsonAtomic(filePath: string, data: any): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, stableStringify(data, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function defaultState(): CircuitState {
  return {
    version: 1,
    updated_at: iso(),
    config: {
      window_size: WINDOW_SIZE,
      trip_threshold: TRIP_THRESHOLD,
      cooldown_sec: DEFAULT_COOLDOWN_SEC,
      recovery_probe_pct: RECOVERY_PROBE_PCT,
      success_to_close: SUCCESS_TO_CLOSE,
    },
    providers: {},
  };
}

function loadState(): CircuitState {
  if (!fs.existsSync(STATE_PATH)) return defaultState();
  try {
    const data = readJsonFile<Record<string, any>>(STATE_PATH);
    if (!data || typeof data !== "object") return defaultState();
    data.config = data.config ?? {};
    data.config.window_size ??= WINDOW_SIZE;
    data.config.trip_threshold ??= TRIP_THRESHOLD;
    data.config.cooldown_sec ??= DEFAULT_COOLDOWN_SEC;
    data.config.recovery_probe_pct ??= RECOVERY_PROBE_PCT;
    data.config.success_to_close ??= SUCCESS_TO_CLOSE;
    data.providers = data.providers ?? {};
    return data as CircuitState;
  } catch {
    return defaultState();
  }
}

function saveState(state: CircuitState): void {
  state.updated_at = iso();
  writeJsonAtomic(STATE_PATH, state);
}

function loadRoutePolicy(): RoutePolicy {
  if (!fs.existsSync(POLICY_PATH)) return {};
  try {
    const data = readJsonFile<RoutePolicy>(POLICY_PATH);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function failureType(statusCode: number): FailureType {
  if (statusCode >= 200 && statusCode < 400) return "success";
  if (FATAL_CODES.has(statusCode)) return "auth";
  if (TIMEOUT_CODES.has(statusCode)) return "timeout";
  if (statusCode === 429) return "rate_limit";
  if ([500, 502, 503, 529].includes(statusCode)) return "overload";
  return "non_retryable";
}

function routeFor(provider: string, statusCode: number, state: CircuitState, policy: RoutePolicy): Record<string, any> {
  const kind = failureType(statusCode);
  const providerPolicy = policy.providers?.[provider] ?? {};
  const fallbackOrder = (providerPolicy.fallback_order ?? DEFAULT_ORDER).filter((p) => p !== provider);
  const fallbackProvider = fallbackOrder.find((name) => {
    const p = providerState(state, name);
    return (p.circuit ?? "closed") !== "open";
  }) ?? null;

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

  const action =
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

  return {
    provider,
    status_code: statusCode,
    failure_type: kind,
    action,
    fallback_provider: action === "fallback" || action === "retry_then_fallback" ? fallbackProvider : null,
    fallback_order: fallbackOrder,
  };
}

function classify(statusCode: number): string {
  if (statusCode >= 200 && statusCode < 400) return "success";
  if (FATAL_CODES.has(statusCode)) return "fatal";
  if (RETRYABLE_CODES.has(statusCode)) return "retryable";
  if (statusCode >= 400) return "non_retryable";
  return "non_retryable";
}

function providerState(state: CircuitState, provider: string): Record<string, any> {
  if (!state.providers[provider]) {
    state.providers[provider] = {
      provider,
      tier: TIER_MAP[provider] ?? 2,
      circuit: "closed",
      opened_at: null,
      half_open_since: null,
      window: [],
      metrics: {
        total: 0,
        retryable: 0,
        non_retryable: 0,
        fatal: 0,
        success: 0,
        non_retryable_rate: 0.0,
      },
      consecutive_successes: 0,
      needs_human_page: false,
      last_error_code: null,
      updated_at: iso(),
    };
  }
  return state.providers[provider];
}

function recomputeMetrics(p: Record<string, any>): void {
  const window = (p.window ?? []).slice(-WINDOW_SIZE);
  p.window = window;
  const total = window.length;
  const retryable = window.filter((x: any) => x.kind === "retryable").length;
  const nonRetryable = window.filter((x: any) => x.kind === "non_retryable" || x.kind === "fatal").length;
  const fatal = window.filter((x: any) => x.kind === "fatal").length;
  const success = window.filter((x: any) => x.kind === "success").length;
  p.metrics = {
    total,
    retryable,
    non_retryable: nonRetryable,
    fatal,
    success,
    non_retryable_rate: total ? nonRetryable / total : 0.0,
  };
}

function maybeTransitionForTime(p: Record<string, any>, cooldownSec: number): void {
  if (p.circuit !== "open" || !p.opened_at) return;
  if (nowTs() - Number(p.opened_at) >= cooldownSec) {
    p.circuit = "half_open";
    p.half_open_since = nowTs();
    p.consecutive_successes = 0;
  }
}

function recordRequest(state: CircuitState, provider: string, statusCode: number): Record<string, any> {
  const p = providerState(state, provider);
  const cfg = state.config;
  const cooldownSec = Number(cfg.cooldown_sec ?? DEFAULT_COOLDOWN_SEC);
  const tripThreshold = Number(cfg.trip_threshold ?? TRIP_THRESHOLD);
  const successToClose = Number(cfg.success_to_close ?? SUCCESS_TO_CLOSE);

  maybeTransitionForTime(p, cooldownSec);

  const kind = classify(statusCode);
  if (kind === "fatal") {
    p.needs_human_page = true;
    p.last_error_code = statusCode;
  }

  p.window.push({ ts: nowTs(), status_code: statusCode, kind });
  recomputeMetrics(p);

  if (p.circuit === "closed") {
    if (p.metrics.non_retryable_rate >= tripThreshold && p.metrics.total >= 5) {
      p.circuit = "open";
      p.opened_at = nowTs();
      p.half_open_since = null;
      p.consecutive_successes = 0;
    }
  } else if (p.circuit === "open") {
    maybeTransitionForTime(p, cooldownSec);
  } else if (p.circuit === "half_open") {
    if (kind === "success") {
      p.consecutive_successes += 1;
      if (p.consecutive_successes >= successToClose) {
        p.circuit = "closed";
        p.opened_at = null;
        p.half_open_since = null;
        p.consecutive_successes = 0;
        p.needs_human_page = false;
      }
    } else {
      p.circuit = "open";
      p.opened_at = nowTs();
      p.half_open_since = null;
      p.consecutive_successes = 0;
    }
  }

  p.updated_at = iso();
  return p;
}

function probeAllowed(provider: string, pct: number): boolean {
  const seed = `${provider}:${Math.floor(Date.now() / 1000)}`;
  const hash = crypto.createHash("sha256").update(seed).digest("hex");
  const bucket = Number.parseInt(hash.slice(0, 8), 16) / 0xffffffff;
  return bucket < pct;
}

function recommendation(state: CircuitState): Record<string, any> {
  const cfg = state.config ?? {};
  const cooldownSec = Number(cfg.cooldown_sec ?? DEFAULT_COOLDOWN_SEC);
  const probePct = Number(cfg.recovery_probe_pct ?? RECOVERY_PROBE_PCT);

  for (const name of Object.keys(state.providers ?? {})) {
    maybeTransitionForTime(state.providers[name], cooldownSec);
  }

  const tier1 = DEFAULT_ORDER.filter((p) => (TIER_MAP[p] ?? 2) === 1);
  const candidates: Array<[string, number, Record<string, any>]> = [];
  for (const name of tier1) {
    const p = providerState(state, name);
    const circuit = p.circuit ?? "closed";
    if (circuit === "closed") {
      candidates.push([name, 0, p]);
    } else if (circuit === "half_open" && probeAllowed(name, probePct)) {
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
    const chosen = candidates[0][0];
    return {
      recommended_provider: chosen,
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

function cmdRecord(provider: string, statusCode: number, cooldownOverride: number | null): number {
  const state = loadState();
  const policy = loadRoutePolicy();
  if (cooldownOverride !== null) state.config.cooldown_sec = cooldownOverride;
  const p = recordRequest(state, provider, statusCode);
  const rec = recommendation(state);
  const route = routeFor(provider, statusCode, state, policy);
  saveState(state);

  const out = {
    provider,
    status_code: statusCode,
    classification: classify(statusCode),
    circuit: p.circuit,
    consecutive_successes: p.consecutive_successes,
    metrics: p.metrics,
    needs_human_page: p.needs_human_page,
    recommendation: rec,
    route_policy: route,
  };
  console.log(JSON.stringify(out, null, 2));

  if (FATAL_CODES.has(statusCode)) {
    console.error(`FATAL_AUTH_ERROR provider=${provider} code=${statusCode} -> page human immediately`);
  }
  return 0;
}

function cmdStatus(): number {
  const state = loadState();
  const rec = recommendation(state);
  const providers = state.providers ?? {};
  const ordered = Object.keys(providers).sort((a, b) => {
    const ta = TIER_MAP[a] ?? 99;
    const tb = TIER_MAP[b] ?? 99;
    if (ta !== tb) return ta - tb;
    return a.localeCompare(b);
  });
  const payload = {
    state_path: STATE_PATH,
    updated_at: state.updated_at,
    config: state.config ?? {},
    providers: ordered.map((n) => ({ name: n, ...providers[n] })),
    recommendation: rec,
  };
  console.log(JSON.stringify(payload, null, 2));
  return 0;
}

function cmdRecommend(): number {
  const state = loadState();
  const rec = recommendation(state);
  saveState(state);
  console.log(JSON.stringify(rec, null, 2));
  return 0;
}

function cmdRoute(provider: string, statusCode: number): number {
  const state = loadState();
  const policy = loadRoutePolicy();
  const route = routeFor(provider, statusCode, state, policy);
  console.log(JSON.stringify(route, null, 2));
  return 0;
}

function parseArgs(argv: string[]): {
  record: [string, number] | null;
  route: [string, number] | null;
  status: boolean;
  recommend: boolean;
  cooldown: number | null;
} {
  const args = {
    record: null as [string, number] | null,
    route: null as [string, number] | null,
    status: false,
    recommend: false,
    cooldown: null as number | null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--record") {
      const provider = argv[++i];
      const code = argv[++i];
      if (provider && code) args.record = [provider, Number.parseInt(code, 10)];
    } else if (a === "--route") {
      const provider = argv[++i];
      const code = argv[++i];
      if (provider && code) args.route = [provider, Number.parseInt(code, 10)];
    } else if (a === "--status") {
      args.status = true;
    } else if (a === "--recommend") {
      args.recommend = true;
    } else if (a === "--cooldown") {
      args.cooldown = Number.parseInt(argv[++i] ?? "0", 10);
    }
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.record) {
    return cmdRecord(args.record[0], args.record[1], args.cooldown);
  }
  if (args.route) {
    return cmdRoute(args.route[0], args.route[1]);
  }
  if (args.status) return cmdStatus();
  return cmdRecommend();
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
