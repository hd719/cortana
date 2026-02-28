#!/usr/bin/env npx tsx
import fs from "fs";
import path from "path";
import { runPsql, withPostgresPath } from "../../tools/lib/db.js";
import { resolveHomePath } from "../../tools/lib/paths.js";

const env = withPostgresPath(process.env);
const logFile = resolveHomePath("clawd", "cortical-loop", "logs", "behavioral-watcher.log");
const stateFile = resolveHomePath("clawd", "cortical-loop", "state", "behavioral-last-check.txt");

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

function nowEtLabel(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: "America/New_York", hour12: false }).replace("T", " ") + "-0500";
}

function main(): void {
  const lastCheck = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8").trim() : "1 hour ago";
  const now = nowEtLabel();

  const wakeEvents = psqlText(`
  SELECT id, timestamp, metadata->>'wake_number' as wake_num
  FROM cortana_events
  WHERE event_type = 'cortical_wake'
    AND timestamp > NOW() - INTERVAL '3 hours'
    AND id NOT IN (
      SELECT CAST(metadata->>'wake_event_id' AS INTEGER)
      FROM cortana_events
      WHERE event_type = 'behavioral_check'
        AND metadata->>'wake_event_id' IS NOT NULL
    )
  ORDER BY timestamp ASC;`);

  if (wakeEvents) {
    for (const row of wakeEvents.split("\n")) {
      if (!row.trim()) continue;
      const [evtId, evtTime, wakeNum = ""] = row.split("|");
      if (!evtId) continue;

      const wakeAgeRaw = psqlText(`SELECT EXTRACT(EPOCH FROM NOW() - '${evtTime}'::timestamptz) / 60;`);
      const wakeAgeMin = Math.floor(Number(wakeAgeRaw || "0"));
      if (wakeAgeMin < 30) continue;

      const sessionDir = resolveHomePath(".openclaw", "sessions");
      let engaged = false;
      if (fs.existsSync(sessionDir) && fs.statSync(sessionDir).isDirectory()) {
        const cutoff = Date.now() - wakeAgeMin * 60_000;
        const stack = [sessionDir];
        while (stack.length > 0 && !engaged) {
          const dir = stack.pop()!;
          let entries: fs.Dirent[] = [];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              stack.push(full);
            } else if (entry.isFile() && entry.name.endsWith(".json")) {
              try {
                const st = fs.statSync(full);
                const stateMtime = fs.existsSync(stateFile) ? fs.statSync(stateFile).mtimeMs : 0;
                if (st.mtimeMs > stateMtime && st.mtimeMs >= cutoff) {
                  engaged = true;
                  break;
                }
              } catch {
                // ignore
              }
            }
          }
        }
      }

      let signal = "neutral";
      let delta = 0;
      if (wakeAgeMin < 5 && engaged) {
        signal = "positive";
        delta = 0.05;
      } else if (wakeAgeMin < 30 && engaged) {
        signal = "neutral";
        delta = 0;
      } else if (wakeAgeMin >= 120) {
        signal = "negative";
        delta = -0.02;
      }

      if (delta !== 0) {
        const relatedRule = psqlText(`
        SELECT name FROM cortana_wake_rules
        WHERE last_triggered IS NOT NULL
          AND last_triggered BETWEEN '${evtTime}'::timestamptz - INTERVAL '5 minutes' AND '${evtTime}'::timestamptz + INTERVAL '1 minute'
        LIMIT 1;`).replace(/\s/g, "");

        psqlExec(`INSERT INTO cortana_feedback_signals (signal_type, source, related_rule, weight_delta, context)
        VALUES ('${signal}', 'behavioral', '${sqlEscape(relatedRule)}', ${delta}, 'Response latency: ${wakeAgeMin}min after wake #${sqlEscape(wakeNum)}');`);
        log(`Behavioral signal: ${signal} (latency=${wakeAgeMin}min, rule=${relatedRule}, delta=${delta})`);
      }

      psqlExec(`INSERT INTO cortana_events (event_type, source, severity, message, metadata)
      VALUES ('behavioral_check', 'behavioral_watcher', 'info', 'Checked wake event ${evtId}', '{"wake_event_id": ${Number(evtId)}}');`);
    }
  }

  const unmapped = psqlText(`
  SELECT id, feedback_type, lesson
  FROM cortana_feedback
  WHERE applied = TRUE
    AND timestamp > NOW() - INTERVAL '1 hour'
    AND feedback_type IN ('correction', 'behavior')
  LIMIT 5;`);

  if (unmapped) {
    for (const row of unmapped.split("\n")) {
      if (!row.trim()) continue;
      const [fbId, _fbType, fbLesson = ""] = row.split("|");
      if (!fbId) continue;
      const exists = Number(psqlText(`SELECT COUNT(*) FROM cortana_feedback_signals WHERE context LIKE 'correction_fb_${Number(fbId)}%';`).replace(/\s/g, "") || "0");
      if (exists > 0) continue;

      psqlExec(`INSERT INTO cortana_feedback_signals (signal_type, source, weight_delta, context)
      VALUES ('negative', 'correction', -0.15, 'correction_fb_${Number(fbId)}: ${sqlEscape(fbLesson)}');`);
      log(`Correction signal from feedback #${fbId}: ${fbLesson}`);
    }
  }

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${now}\n`, "utf8");
  log("Behavioral watcher cycle complete");

  void lastCheck;
}

main();
