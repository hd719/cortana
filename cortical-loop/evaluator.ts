#!/usr/bin/env npx tsx
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { runPsql, withPostgresPath } from "../tools/lib/db.js";
import { resolveHomePath } from "../tools/lib/paths.js";

type EventRow = { id: number; source: string; event_type: string; payload: unknown };
type RuleRow = {
  id: number;
  name: string;
  source: string;
  event_type: string;
  condition?: unknown;
  priority: number;
  weight: number;
  suppress_when?: { chief_state?: string };
};

const env = withPostgresPath(process.env);

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function psqlText(sql: string): string {
  const res = runPsql(sql, { args: ["-X", "-q", "-t", "-A"], env });
  return (res.stdout ?? "").toString().trim();
}

function psqlExec(sql: string): void {
  void runPsql(sql, { args: ["-X", "-q"], env, stdio: "ignore" });
}

function parseJson<T>(raw: string, fallback: T): T {
  if (!raw || raw === "null") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function todayEt(): string {
  const res = spawnSync("date", ["+%Y-%m-%d"], {
    env: { ...process.env, TZ: "America/New_York" },
    encoding: "utf8",
  });
  return (res.stdout ?? "").toString().trim();
}

function main() {
  const enabled = psqlText("SELECT value::text FROM cortana_chief_model WHERE key='cortical_loop_enabled';").replace(/["\s]/g, "");
  if (enabled !== "true") process.exit(0);

  const wakeRaw = psqlText("SELECT value FROM cortana_chief_model WHERE key='daily_wake_count';");
  const wakeData = parseJson<{ date?: string; count?: number; max?: number }>(wakeRaw, {});
  const today = todayEt();
  let wakeCount = Number(wakeData.count ?? 0);
  const wakeMax = Number(wakeData.max ?? 10);

  if (wakeData.date !== today) {
    wakeCount = 0;
    psqlExec(`UPDATE cortana_chief_model SET value = jsonb_build_object('count', 0, 'date', '${today}', 'max', ${wakeMax}), updated_at = NOW() WHERE key = 'daily_wake_count';`);
  }

  if (wakeCount >= wakeMax) {
    psqlExec("UPDATE cortana_chief_model SET value = '\"false\"', updated_at = NOW(), source = 'budget_guard' WHERE key = 'cortical_loop_enabled';");
    psqlExec(`INSERT INTO cortana_events (event_type, source, severity, message) VALUES ('auto_disable', 'cortical_loop', 'warning', 'Daily wake cap (${wakeMax}) reached. Loop auto-disabled.');`);
    process.exit(0);
  }

  const eventsRaw = psqlText("SELECT json_agg(e) FROM (SELECT id, source, event_type, payload FROM cortana_event_stream WHERE processed = FALSE ORDER BY timestamp ASC LIMIT 20) e;");
  if (!eventsRaw || eventsRaw === "null") process.exit(0);

  const chiefState = psqlText("SELECT value->>'status' FROM cortana_chief_model WHERE key='state';").trim();
  const rulesRaw = psqlText("SELECT json_agg(r) FROM (SELECT id, name, source, event_type, condition, priority, weight, suppress_when FROM cortana_wake_rules WHERE enabled = TRUE ORDER BY priority ASC) r;");

  const events = parseJson<EventRow[]>(eventsRaw, []);
  const rules = parseJson<RuleRow[]>(rulesRaw, []);

  const wakeEvents: string[] = [];

  for (const event of events) {
    for (const rule of rules) {
      if (event.source !== rule.source || event.event_type !== rule.event_type) continue;
      const suppress = rule.suppress_when?.chief_state;
      if (suppress && chiefState === suppress) continue;
      if (Number(rule.weight) < 0.3) continue;

      wakeEvents.push(`- [${rule.name}] (P${rule.priority}): ${JSON.stringify(event.payload)}`);
      psqlExec(`UPDATE cortana_wake_rules SET last_triggered = NOW(), trigger_count = trigger_count + 1 WHERE name = '${sqlEscape(rule.name)}';`);
    }

    psqlExec(`UPDATE cortana_event_stream SET processed = TRUE, processed_at = NOW() WHERE id = ${event.id};`);
  }

  if (wakeEvents.length > 0) {
    const chiefModel = psqlText("SELECT json_object_agg(key, value) FROM cortana_chief_model;");
    const sitrep = psqlText("SELECT json_object_agg(domain || '.' || key, value) FROM cortana_sitrep_latest;");
    const feedback = psqlText("SELECT json_agg(f) FROM (SELECT lesson FROM cortana_feedback WHERE applied = TRUE ORDER BY timestamp DESC LIMIT 5) f;");

    const wakePrompt = `CORTICAL LOOP WAKE — Event-driven alert.\n\nTRIGGERED EVENTS:\n${wakeEvents.join("\n")}\n\nCHIEF MODEL (current state):\n${chiefModel}\n\nRELEVANT SITREP:\n${sitrep}\n\nBEHAVIORAL RULES (from past feedback):\n${feedback}\n\nINSTRUCTIONS:\n1. Analyze the triggered events in context of Chief's current state\n2. Decide what action to take (message Chief, create task, update sitrep, or suppress)\n3. If messaging Chief: adapt tone to communication_preference (brief/normal/minimal)\n4. If Chief is asleep/likely_asleep: only message for priority 1-2 events\n5. After acting, suggest if any wake rules should be adjusted (thresholds too sensitive/not sensitive enough)\n\nBe concise. Act decisively. You are Cortana's nervous system responding to a real-time signal.`;

    const promptFile = resolveHomePath("clawd", "cortical-loop", "state", "current-wake-prompt.txt");
    fs.mkdirSync(path.dirname(promptFile), { recursive: true });
    fs.writeFileSync(promptFile, wakePrompt, "utf8");

    const newCount = wakeCount + 1;
    psqlExec(`UPDATE cortana_chief_model SET value = jsonb_build_object('count', ${newCount}, 'date', '${today}', 'max', ${wakeMax}), updated_at = NOW() WHERE key = 'daily_wake_count';`);
    psqlExec(`INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('cortical_wake', 'cortical_loop', 'info', 'LLM wake triggered', '{"wake_number": ${newCount}}');`);

    spawnSync("openclaw", ["cron", "wake", "--text", wakePrompt, "--mode", "now"], {
      env,
      stdio: "ignore",
    });
  }

  const feedbackHandler = resolveHomePath("clawd", "cortical-loop", "feedback-handler.ts");
  spawnSync(feedbackHandler, { env, stdio: "ignore" });
}

main();
