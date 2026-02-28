#!/usr/bin/env npx tsx
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { runPsql, withPostgresPath } from "../tools/lib/db.js";
import { resolveHomePath } from "../tools/lib/paths.js";

type Signal = { id: number; signal_type: string; related_rule?: string | null; weight_delta?: number | null };

const env = withPostgresPath(process.env);
const logFile = resolveHomePath("clawd", "cortical-loop", "logs", "feedback-handler.log");

function log(message: string): void {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const ts = new Date().toLocaleString("sv-SE", { timeZone: "America/New_York" }).replace("T", " ");
  fs.appendFileSync(logFile, `${ts} ${message}\n`, "utf8");
}

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

function main(): void {
  const signalsRaw = psqlText(`
  SELECT json_agg(s) FROM (
    SELECT id, signal_type, related_rule, weight_delta
    FROM cortana_feedback_signals
    WHERE processed = FALSE
    ORDER BY timestamp ASC
    LIMIT 20
  ) s;`);

  if (!signalsRaw || signalsRaw === "null") process.exit(0);

  let signals: Signal[] = [];
  try {
    signals = JSON.parse(signalsRaw) as Signal[];
  } catch {
    process.exit(0);
  }

  for (const sig of signals) {
    const sigId = sig.id;
    const sigType = sig.signal_type;
    const ruleName = (sig.related_rule ?? "").trim();
    const delta = Number(sig.weight_delta ?? 0);

    if (!ruleName) {
      psqlExec(`UPDATE cortana_feedback_signals SET processed = TRUE WHERE id = ${sigId};`);
      continue;
    }

    const currentWeightRaw = psqlText(`SELECT weight FROM cortana_wake_rules WHERE name = '${sqlEscape(ruleName)}';`);
    if (!currentWeightRaw) {
      log(`WARN: Rule '${ruleName}' not found, skipping signal ${sigId}`);
      psqlExec(`UPDATE cortana_feedback_signals SET processed = TRUE WHERE id = ${sigId};`);
      continue;
    }

    const currentWeight = Number(currentWeightRaw);
    let newWeight = currentWeight + delta;
    if (newWeight < 0.1) newWeight = 0.1;
    if (newWeight > 2.0) newWeight = 2.0;
    const newWeightStr = newWeight.toFixed(2);

    const feedbackCol =
      sigType === "positive"
        ? "positive_feedback = positive_feedback + 1"
        : sigType === "negative"
          ? "negative_feedback = negative_feedback + 1"
          : "trigger_count = trigger_count";

    psqlExec(`UPDATE cortana_wake_rules SET weight = ${newWeightStr}, ${feedbackCol} WHERE name = '${sqlEscape(ruleName)}';`);
    psqlExec(`UPDATE cortana_feedback_signals SET processed = TRUE WHERE id = ${sigId};`);
    psqlExec(`INSERT INTO cortana_events (event_type, source, severity, message, metadata)
      VALUES ('weight_change', 'feedback_handler', 'info',
      'Rule "${sqlEscape(ruleName)}" weight: ${currentWeight} → ${newWeightStr} (${sigType})',
      '{"rule": "${sqlEscape(ruleName)}", "old_weight": ${currentWeight}, "new_weight": ${newWeightStr}, "delta": ${delta}, "signal_type": "${sqlEscape(sigType)}"}');`);

    log(`Applied: ${ruleName} ${currentWeight} → ${newWeightStr} (${sigType}, delta=${delta})`);
  }

  const suppressedRaw = psqlText(`
  SELECT name FROM cortana_wake_rules
  WHERE negative_feedback >= 3
    AND negative_feedback > positive_feedback
    AND weight < 0.3
    AND enabled = TRUE;`);

  if (suppressedRaw) {
    const rules = suppressedRaw.split("\n").map((s) => s.trim()).filter(Boolean);
    for (const rule of rules) {
      psqlExec(`UPDATE cortana_wake_rules SET enabled = FALSE WHERE name = '${sqlEscape(rule)}';`);
      psqlExec(`INSERT INTO cortana_events (event_type, source, severity, message, metadata)
      VALUES ('auto_suppress', 'feedback_handler', 'warning',
        'Auto-suppressed rule "${sqlEscape(rule)}" — 3+ consecutive negatives',
        '{"rule": "${sqlEscape(rule)}"}');`);
      log(`AUTO-SUPPRESSED: ${rule} (3+ negatives, weight < 0.3)`);

      const text = `⚠️ Auto-suppressed wake rule "${rule}" — got 3+ negative reactions with weight below 0.3. Re-enable with: psql cortana -c "UPDATE cortana_wake_rules SET enabled = TRUE, weight = 1.0, negative_feedback = 0 WHERE name = '${rule}';"`;
      spawnSync("openclaw", ["cron", "wake", "--text", text, "--mode", "now"], {
        env,
        stdio: "ignore",
      });
    }
  }
}

main();
