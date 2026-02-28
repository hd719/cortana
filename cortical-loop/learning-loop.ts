#!/usr/bin/env npx tsx
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { runPsql, withPostgresPath } from "../tools/lib/db.js";
import { resolveHomePath } from "../tools/lib/paths.js";

const env = withPostgresPath(process.env);
const logFile = resolveHomePath("clawd", "cortical-loop", "logs", "learning-loop.log");

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
  log("=== Learning Loop starting ===");

  const unapplied = psqlText(`
  SELECT id, feedback_type, context, lesson
  FROM cortana_feedback
  WHERE applied = FALSE
  ORDER BY timestamp ASC;`);

  if (unapplied) {
    for (const line of unapplied.split("\n")) {
      if (!line.trim()) continue;
      const [fbId, fbType, fbCtx = "", fbLesson = ""] = line.split("|");
      if (!fbId) continue;

      log(`Processing feedback #${fbId}: type=${fbType} lesson=${fbLesson}`);

      const combined = sqlEscape(`${fbCtx} ${fbLesson}`);
      const matchingRule = psqlText(`
      SELECT name FROM cortana_wake_rules
      WHERE '${combined}' ILIKE '%' || name || '%'
      LIMIT 1;`).trim();

      if (matchingRule) {
        psqlExec(`INSERT INTO cortana_feedback_signals
        (signal_type, source, related_rule, weight_delta, context)
        VALUES ('negative', 'learning_loop', '${sqlEscape(matchingRule)}', -0.15, 'From feedback #${fbId}: ${sqlEscape(fbLesson)}');`);
        log(`  → Mapped to wake rule: ${matchingRule} (delta=-0.15)`);
      }

      psqlExec(`UPDATE cortana_feedback SET applied = TRUE WHERE id = ${fbId};`);
    }
  }

  const repeats = psqlText(`
  SELECT feedback_type, lesson, COUNT(*) as cnt
  FROM cortana_feedback
  WHERE timestamp > NOW() - INTERVAL '30 days'
  GROUP BY feedback_type, lesson
  HAVING COUNT(*) >= 3
  ORDER BY cnt DESC;`);

  if (repeats) {
    log("REPEATED PATTERNS DETECTED:");
    const lines: string[] = [];

    for (const row of repeats.split("\n")) {
      if (!row.trim()) continue;
      const [rType, rLesson = "", rCount = "0"] = row.split("|");
      if (!rType) continue;
      log(`  ⚠️  [${rType}] x${rCount}: ${rLesson}`);

      psqlExec(`INSERT INTO cortana_events (event_type, source, severity, message, metadata)
      VALUES ('learning_escalation', 'learning_loop', 'warning',
        'Lesson repeated ${rCount}x in 30 days — not sticking: ${sqlEscape(rLesson)}',
        '{"feedback_type": "${sqlEscape(rType)}", "count": ${Number(rCount)}}');`);

      lines.push(`• [${rType}] x${rCount}: ${rLesson}`);
    }

    if (lines.length > 0) {
      const text = `🔄 Learning Loop — lessons that aren't sticking (3+ repeats in 30 days):\n${lines.join("\n")}\n\nThese need stronger reinforcement. Should I add them to SOUL.md or strengthen the rules?`;
      spawnSync("openclaw", ["cron", "wake", "--text", text, "--mode", "now"], {
        env,
        stdio: "ignore",
      });
    }
  }

  const decayable = psqlText(`
  SELECT wr.name, wr.weight
  FROM cortana_wake_rules wr
  WHERE wr.last_triggered > NOW() - INTERVAL '24 hours'
    AND wr.enabled = TRUE
    AND wr.weight > 0.1
    AND NOT EXISTS (
      SELECT 1 FROM cortana_feedback_signals fs
      WHERE fs.related_rule = wr.name
        AND fs.timestamp > wr.last_triggered
    );`);

  if (decayable) {
    for (const row of decayable.split("\n")) {
      if (!row.trim()) continue;
      const [dName, dWeightRaw = "0"] = row.split("|");
      if (!dName) continue;
      const dWeight = Number(dWeightRaw);
      const newW = Math.max(0.1, dWeight - 0.02);
      const newWStr = newW.toFixed(2);
      if (newWStr !== dWeight.toFixed(2)) {
        psqlExec(`UPDATE cortana_wake_rules SET weight = ${newWStr} WHERE name = '${sqlEscape(dName)}';`);
        log(`  Decay: ${dName} ${dWeight.toFixed(2)} → ${newWStr} (no engagement)`);
      }
    }
  }

  const reflectPath = resolveHomePath("clawd", "tools", "reflection", "reflect.py");
  if (fs.existsSync(reflectPath)) {
    const out = spawnSync("python3", [reflectPath, "--mode", "sweep", "--trigger-source", "cron", "--window-days", "30"], {
      env,
      encoding: "utf8",
    });
    const result = `${out.stdout ?? ""}${out.stderr ?? ""}`.trim();
    if ((out.status ?? 1) === 0) {
      log(`Reflection sweep completed: ${result}`);
    } else {
      log(`Reflection sweep failed: ${result}`);
    }
  } else {
    log("Reflection sweep skipped: tools/reflection/reflect.py not executable");
  }

  log("=== Learning Loop complete ===");
}

main();
