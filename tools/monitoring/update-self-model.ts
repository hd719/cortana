#!/usr/bin/env npx tsx

import { spawnSync } from "child_process";
import { PSQL_BIN, POSTGRES_PATH } from "../lib/paths.js";
const DB = "cortana";
const USAGE_HANDLER = "/Users/hd/openclaw/skills/telegram-usage/handler.js";
const COOLDOWN_SEC = 15 * 60;
const HYSTERESIS_STEPS = 2;

type UsageParsed = {
  spend: number;
  burn: number;
  projected: number;
  pct: number;
  parser: string;
};

function sh(cmd: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(cmd[0], cmd.slice(1), {
    encoding: "utf8",
    env: env ?? process.env,
  });
}

function psql(sql: string, at = false): string {
  const args = [DB, "-v", "ON_ERROR_STOP=1"];
  if (at) args.push("-A", "-t", "-q", "-X");
  args.push("-c", sql);
  const env = withPostgresPath(process.env);
  const proc = spawnSync(PSQL_BIN, args, { encoding: "utf8", env });
  if (proc.status !== 0) {
    const msg = (proc.stderr || proc.stdout || "psql failed").trim();
    throw new Error(msg || "psql failed");
  }
  return (proc.stdout ?? "").trim();
}

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function parseUsage(raw: string): UsageParsed {
  let spend = 0.0;
  let burn = 0.0;
  let projected = 0.0;
  let pct = 0.0;
  let parser = "default_zero";

  const txt = (raw || "").trim();
  if (!txt) {
    return { spend, burn, projected, pct, parser };
  }

  try {
    const d = JSON.parse(txt);
    parser = "json";
    const pick = (...keys: string[]): number | null => {
      for (const k of keys) {
        if (d && typeof d === "object" && k in d && d[k] != null) {
          const v = Number(d[k]);
          if (!Number.isNaN(v)) return v;
        }
      }
      return null;
    };

    spend = pick("spend_to_date", "spend", "cost", "total_spend") ?? 0.0;
    burn = pick("burn_rate", "daily_burn", "rate") ?? 0.0;
    projected = pick("projected", "projected_monthly", "forecast") ?? 0.0;
    pct = pick("pct_used", "percent_used", "usage_pct") ?? 0.0;
    return { spend, burn, projected, pct, parser };
  } catch {
    // fallthrough
  }

  parser = "text";
  const mQuota = /quota\s*:\s*[^\d]*(\d+(?:\.\d+)?)%/i.exec(txt);
  if (mQuota) {
    const remaining = Number(mQuota[1]);
    if (!Number.isNaN(remaining)) {
      pct = Math.max(0, Math.min(100, Math.round((100 - remaining) * 100) / 100));
    }
  }

  const mSpend = /(?:spend|cost|used)\s*[:=]?\s*\$?\s*(\d+(?:\.\d+)?)/i.exec(txt);
  if (mSpend) {
    const val = Number(mSpend[1]);
    if (!Number.isNaN(val)) spend = val;
  }

  if (spend === 0 && pct > 0) {
    projected = pct;
  }

  return { spend, burn, projected, pct, parser };
}

function targetTier(pct: number): number {
  if (pct >= 90) return 3;
  if (pct >= 75) return 2;
  if (pct >= 50) return 1;
  return 0;
}

async function main(): Promise<void> {
  const usageEnv = { ...process.env, PATH: `${POSTGRES_PATH}:${process.env.PATH ?? ""}` };
  const usageProc = sh(["node", USAGE_HANDLER], usageEnv);
  const usageRaw = usageProc.stdout ?? "";
  const parsed = parseUsage(usageRaw);

  const breakdown = {
    parser: parsed.parser,
    raw: usageRaw.slice(0, 4000),
    stderr: (usageProc.stderr ?? "").slice(0, 800),
  };

  psql(
    "INSERT INTO cortana_budget_log (spend_to_date, burn_rate, projected, breakdown, pct_used) VALUES (" +
      `${parsed.spend}, ${parsed.burn}, ${parsed.projected}, '${sqlEscape(
        JSON.stringify(breakdown)
      )}'::jsonb, ${parsed.pct});`
  );

  const row = psql(
    "SELECT row_to_json(t)::text FROM (" +
      "SELECT id, health_score, status, budget_pct_used, throttle_tier, COALESCE(metadata,'{}'::jsonb) AS metadata " +
      "FROM cortana_self_model WHERE id=1) t;",
    true
  );

  const current = row ? (JSON.parse(row) as Record<string, any>) : { throttle_tier: 0, metadata: {} };
  const metadata = (current.metadata && typeof current.metadata === "object" ? current.metadata : {}) as Record<
    string,
    any
  >;
  const control =
    metadata.throttle_control && typeof metadata.throttle_control === "object" ? metadata.throttle_control : {};

  const pct = Number(parsed.pct);
  const candidate = targetTier(pct);
  const currentTier = Number(current.throttle_tier ?? 0);

  let lastChangeEpoch = Number(control.last_change_epoch ?? 0);
  if (!lastChangeEpoch) {
    const latestChange = psql(
      "SELECT EXTRACT(EPOCH FROM COALESCE(MAX(timestamp), NOW() - INTERVAL '365 days'))::bigint " +
        "FROM cortana_throttle_log;",
      true
    );
    const val = Number((latestChange || "0").trim());
    lastChangeEpoch = Number.isNaN(val) ? 0 : val;
  }

  const now = Math.floor(Date.now() / 1000);
  let pendingTier = Number(control.pending_tier ?? currentTier);
  let pendingHits = Number(control.pending_hits ?? 0);

  let tierToApply = currentTier;
  let throttleReason = "stable";

  if (candidate === currentTier) {
    pendingTier = candidate;
    pendingHits = 0;
    throttleReason = "within_current_band";
  } else if (now - lastChangeEpoch < COOLDOWN_SEC) {
    throttleReason = "cooldown_hold";
    pendingTier = candidate;
    const priorPending = Number(control.pending_tier ?? -1);
    pendingHits = pendingTier !== priorPending ? 1 : Math.max(1, pendingHits);
  } else {
    if (pendingTier === candidate) {
      pendingHits += 1;
    } else {
      pendingTier = candidate;
      pendingHits = 1;
    }
    throttleReason = "hysteresis_tracking";
    if (pendingHits >= HYSTERESIS_STEPS) {
      tierToApply = candidate;
      pendingHits = 0;
      pendingTier = candidate;
      lastChangeEpoch = now;
      throttleReason = "hysteresis_commit";
    }
  }

  const cronsTotal = Number(
    psql(
      "SELECT COUNT(*) FROM (SELECT DISTINCT ON (cron_name) cron_name FROM cortana_cron_health ORDER BY cron_name, timestamp DESC) t;",
      true
    ) || "0"
  );
  const cronsHealthy = Number(
    psql(
      "SELECT COUNT(*) FROM (SELECT DISTINCT ON (cron_name) cron_name, status FROM cortana_cron_health ORDER BY cron_name, timestamp DESC) t WHERE status='ok';",
      true
    ) || "0"
  );

  const cronsFailing =
    psql(
      "SELECT COALESCE(array_agg(cron_name), '{}') FROM (SELECT DISTINCT ON (cron_name) cron_name, status FROM cortana_cron_health ORDER BY cron_name, timestamp DESC) t WHERE status='failed';",
      true
    ) || "{}";
  const cronsMissed =
    psql(
      "SELECT COALESCE(array_agg(cron_name), '{}') FROM (SELECT DISTINCT ON (cron_name) cron_name, status FROM cortana_cron_health ORDER BY cron_name, timestamp DESC) t WHERE status='missed';",
      true
    ) || "{}";
  const toolsUp =
    psql(
      "SELECT COALESCE(array_agg(tool_name), '{}') FROM (SELECT DISTINCT ON (tool_name) tool_name, status FROM cortana_tool_health ORDER BY tool_name, timestamp DESC) t WHERE status='up';",
      true
    ) || "{}";
  const toolsDown =
    psql(
      "SELECT COALESCE(array_agg(tool_name), '{}') FROM (SELECT DISTINCT ON (tool_name) tool_name, status FROM cortana_tool_health ORDER BY tool_name, timestamp DESC) t WHERE status<>'up';",
      true
    ) || "{}";

  const toolsDownCount = Number(
    psql(
      "SELECT COUNT(*) FROM (SELECT DISTINCT ON (tool_name) tool_name, status FROM cortana_tool_health ORDER BY tool_name, timestamp DESC) t WHERE status<>'up';",
      true
    ) || "0"
  );
  const cronsFailCount = Number(
    psql(
      "SELECT COUNT(*) FROM (SELECT DISTINCT ON (cron_name) cron_name, status FROM cortana_cron_health ORDER BY cron_name, timestamp DESC) t WHERE status IN ('failed','missed');",
      true
    ) || "0"
  );

  const budgetPenalty = pct >= 90 ? 30 : pct >= 75 ? 20 : pct >= 50 ? 10 : 0;
  const health = Math.max(0, Math.trunc(100 - 10 * toolsDownCount - 5 * cronsFailCount - budgetPenalty));
  const status = health >= 80 ? "nominal" : health >= 50 ? "degraded" : "critical";

  metadata.throttle_control = {
    pending_tier: pendingTier,
    pending_hits: pendingHits,
    last_change_epoch: lastChangeEpoch,
    cooldown_sec: COOLDOWN_SEC,
    hysteresis_steps: HYSTERESIS_STEPS,
    last_reason: throttleReason,
  };
  metadata.budget_parser = {
    mode: parsed.parser,
    captured_at: Math.floor(Date.now() / 1000),
  };

  psql(
    "INSERT INTO cortana_self_model (" +
      "id, health_score, status, budget_used, budget_pct_used, budget_burn_rate, budget_projected, throttle_tier, " +
      "crons_total, crons_healthy, crons_failing, crons_missed, tools_up, tools_down, metadata, updated_at" +
      ") VALUES (" +
      `1, ${health}, '${status}', ${parsed.spend}, ${pct}, ${parsed.burn}, ${parsed.projected}, ${tierToApply}, ` +
      `${cronsTotal}, ${cronsHealthy}, '${sqlEscape(cronsFailing)}'::text[], '${sqlEscape(
        cronsMissed
      )}'::text[], ` +
      `'${sqlEscape(toolsUp)}'::text[], '${sqlEscape(toolsDown)}'::text[], '${sqlEscape(
        JSON.stringify(metadata)
      )}'::jsonb, NOW()` +
      ") ON CONFLICT (id) DO UPDATE SET " +
      "health_score=EXCLUDED.health_score, status=EXCLUDED.status, budget_used=EXCLUDED.budget_used, " +
      "budget_pct_used=EXCLUDED.budget_pct_used, budget_burn_rate=EXCLUDED.budget_burn_rate, budget_projected=EXCLUDED.budget_projected, " +
      "throttle_tier=EXCLUDED.throttle_tier, crons_total=EXCLUDED.crons_total, crons_healthy=EXCLUDED.crons_healthy, " +
      "crons_failing=EXCLUDED.crons_failing, crons_missed=EXCLUDED.crons_missed, tools_up=EXCLUDED.tools_up, tools_down=EXCLUDED.tools_down, " +
      "metadata=EXCLUDED.metadata, updated_at=NOW();"
  );

  if (tierToApply !== currentTier) {
    psql(
      "INSERT INTO cortana_throttle_log (tier_from, tier_to, reason, actions_taken) VALUES (" +
        `${currentTier}, ${tierToApply}, 'budget threshold evaluation (${throttleReason})', ARRAY['auto-check']);`
    );
  }

  console.log(
    JSON.stringify({
      ok: true,
      budget_pct_used: pct,
      throttle_before: currentTier,
      throttle_after: tierToApply,
      throttle_reason: throttleReason,
      health,
      status,
    })
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
