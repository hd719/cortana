#!/usr/bin/env npx tsx

import {
  classify,
  loadRoutePolicy,
  loadState,
  recommendation,
  recordRequest,
  routeFor,
  saveState,
  STATE_PATH,
} from "./provider-health.js";

function cmdRecord(provider: string, statusCode: number, cooldownOverride: number | null): number {
  const policy = loadRoutePolicy();
  const state = loadState(policy);
  if (cooldownOverride !== null) state.config.cooldown_sec = cooldownOverride;

  const providerState = recordRequest(state, provider, statusCode);
  const rec = recommendation(state);
  const route = routeFor(provider, statusCode, state, policy);
  saveState(state);

  console.log(
    JSON.stringify(
      {
        provider,
        status_code: statusCode,
        classification: classify(statusCode),
        circuit: providerState.circuit,
        consecutive_successes: providerState.consecutive_successes,
        metrics: providerState.metrics,
        needs_human_page: providerState.needs_human_page,
        last_trip_reason: providerState.last_trip_reason,
        error_burst: providerState.error_burst,
        recommendation: rec,
        route_policy: route,
      },
      null,
      2,
    ),
  );

  if (providerState.needs_human_page) {
    console.error(`FATAL_AUTH_ERROR provider=${provider} code=${statusCode} -> page human immediately`);
  }
  return 0;
}

function cmdStatus(): number {
  const state = loadState();
  const rec = recommendation(state);
  const ordered = Object.keys(state.providers ?? {}).sort((a, b) => a.localeCompare(b));
  console.log(
    JSON.stringify(
      {
        state_path: STATE_PATH,
        updated_at: state.updated_at,
        config: state.config ?? {},
        providers: ordered.map((name) => ({ name, ...state.providers[name] })),
        recommendation: rec,
      },
      null,
      2,
    ),
  );
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
  const policy = loadRoutePolicy();
  const state = loadState(policy);
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
  if (args.record) return cmdRecord(args.record[0], args.record[1], args.cooldown);
  if (args.route) return cmdRoute(args.route[0], args.route[1]);
  if (args.status) return cmdStatus();
  return cmdRecommend();
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
