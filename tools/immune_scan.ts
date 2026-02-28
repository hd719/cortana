#!/usr/bin/env npx tsx
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { runPsql, withPostgresPath } from "./lib/db.js";

function usage(): void {
  process.stdout.write(`Usage: tools/immune_scan.sh [--help] [--dry-run]

Scans for known reliability threats and runs safe auto-heal actions:
- path drift checks + recovery
- service/health checks
- oversized session quarantine (no hard delete)
- tool flap detection from cortana_tool_health
- immune playbook seeding + success-rate tracking

Options:
  --help     Show this help message and exit
  --dry-run  Detect and report only; skip mutations and DB writes
`);
}

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readFileContains(filePath: string, needle: string): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return content.includes(needle);
  } catch {
    return false;
  }
}

function listLargeSessions(dir: string, thresholdBytes: number): string[] {
  const results: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const stat = fs.statSync(full);
          if (stat.size > thresholdBytes) {
            results.push(full);
          }
        } catch {
          // ignore
        }
      }
    }
  }
  return results;
}

async function main(): Promise<number> {
  let dryRun = false;
  const argv = process.argv.slice(2);
  while (argv.length > 0) {
    const arg = argv.shift();
    if (!arg) continue;
    if (arg === "-h" || arg === "--help") {
      usage();
      return 0;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    process.stderr.write(`Unknown option: ${arg}\n`);
    usage();
    return 2;
  }

  let issues = "";
  const PATH_OVERRIDE = "/opt/homebrew/opt/postgresql@17/bin";
  const env = withPostgresPath({ ...process.env, PATH: `${PATH_OVERRIDE}:${process.env.PATH ?? ""}` });
  const PSQL_BIN = "/opt/homebrew/opt/postgresql@17/bin/psql";
  const PG_READY_BIN = "/opt/homebrew/opt/postgresql@17/bin/pg_isready";
  const QUARANTINE_DIR = path.join(os.homedir(), ".Trash", "cortana-quarantine");

  const FLAP_FAILS = Number(process.env.IMMUNE_FLAP_FAILS ?? "4");
  const FLAP_MINUTES = Number(process.env.IMMUNE_FLAP_MINUTES ?? "15");

  fs.mkdirSync(QUARANTINE_DIR, { recursive: true });

  const dbExec = (sql: string): void => {
    if (dryRun) return;
    if (!isExecutable(PSQL_BIN)) return;
    runPsql(sql, {
      db: "cortana",
      args: ["-q", "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A"],
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });
  };

  const dbScalar = (sql: string): string => {
    if (!isExecutable(PSQL_BIN)) return "";
    const res = runPsql(sql, {
      db: "cortana",
      args: ["-q", "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A"],
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (res.status !== 0) return "";
    return (res.stdout ?? "").toString().replace(/\s+/g, "");
  };

  const logEvent = (eventType: string, severity: string, message: string, metadata = "{}"): void => {
    dbExec(
      `INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('${sqlEscape(
        eventType
      )}','immune_scan','${sqlEscape(severity)}','${sqlEscape(message)}','${sqlEscape(metadata)}'::jsonb);`
    );
  };

  const ensurePlaybookSeeded = (): void => {
    dbExec(`INSERT INTO cortana_immune_playbooks (name, threat_signature, description, actions, tier, enabled, times_used, success_rate)
           VALUES
             ('path_drift_recovery','path_drift','Recover missing expected paths and repair references',
              '["verify path exists","attempt mkdir for required directories","log incident","track outcome"]'::jsonb,
              1, TRUE, 0, 1.0),
             ('tool_flap_recovery','tool_flap','Detect repeated tool failures and escalate/stabilize',
              '["count failures in lookback window","flag incident","emit warning event","track success"]'::jsonb,
              2, TRUE, 0, 1.0)
           ON CONFLICT (name) DO UPDATE
             SET threat_signature = EXCLUDED.threat_signature,
                 description = EXCLUDED.description,
                 actions = EXCLUDED.actions,
                 enabled = TRUE,
                 updated_at = NOW();`);
  };

  const trackPlaybookResult = (name: string, success: boolean): void => {
    const prevUsedRaw = dbScalar(
      `SELECT COALESCE(times_used,0) FROM cortana_immune_playbooks WHERE name='${sqlEscape(
        name
      )}' LIMIT 1;`
    );
    const prevRateRaw = dbScalar(
      `SELECT COALESCE(success_rate,1.0) FROM cortana_immune_playbooks WHERE name='${sqlEscape(
        name
      )}' LIMIT 1;`
    );
    const prevUsed = Number(prevUsedRaw || "0") || 0;
    const prevRate = Number(prevRateRaw || "1.0") || 1.0;

    const newUsed = prevUsed + 1;
    const newRate = success
      ? ((prevRate * prevUsed + 1) / (prevUsed + 1))
      : ((prevRate * prevUsed) / (prevUsed + 1));

    const newRateText = newRate.toFixed(4);

    dbExec(`UPDATE cortana_immune_playbooks
           SET times_used=${newUsed},
               success_rate=${newRateText},
               last_used=NOW(),
               updated_at=NOW()
           WHERE name='${sqlEscape(name)}';`);
  };

  const reconcilePlaybookMetrics = (): void => {
    dbExec(`WITH stats AS (
    SELECT
      p.name,
      COUNT(i.id)::int AS total_used,
      MAX(i.detected_at) AS last_used_at,
      CASE
        WHEN COUNT(i.id) = 0 THEN 1.0
        ELSE ROUND(
          SUM(CASE WHEN i.status='resolved' OR COALESCE(i.auto_resolved,false)=TRUE THEN 1 ELSE 0 END)::numeric / COUNT(i.id)::numeric,
          4
        )
      END AS computed_success
    FROM cortana_immune_playbooks p
    LEFT JOIN cortana_immune_incidents i ON i.playbook_used = p.name
    GROUP BY p.name
  )
  UPDATE cortana_immune_playbooks p
  SET times_used = s.total_used,
      last_used = s.last_used_at,
      success_rate = s.computed_success,
      updated_at = NOW()
  FROM stats s
  WHERE p.name = s.name;`);
  };

  const ensurePathExists = (targetPath: string, createIfMissing: boolean, playbook = "path_drift_recovery"):
    boolean => {
    if (fs.existsSync(targetPath)) return true;

    if (createIfMissing) {
      if (dryRun) {
        issues += `path_drift: RECOVERED ${targetPath}\n`;
        logEvent("auto_heal", "info", `Recovered missing path: ${targetPath}`, `{"path":"${sqlEscape(
          targetPath
        )}","strategy":"mkdir"}`);
        dbExec(`INSERT INTO cortana_immune_incidents (detected_at, threat_type, source, severity, description, threat_signature, tier, status, playbook_used, resolution, auto_resolved, metadata)
               VALUES (NOW(),'path_drift','immune_scan','warning','Missing path recovered','path_drift',1,'resolved','${sqlEscape(
                 playbook
               )}','Path recreated',TRUE,'{"path":"${sqlEscape(targetPath)}"}'::jsonb);`);
        trackPlaybookResult(playbook, true);
        return true;
      }
      try {
        fs.mkdirSync(targetPath, { recursive: true });
        issues += `path_drift: RECOVERED ${targetPath}\n`;
        logEvent("auto_heal", "info", `Recovered missing path: ${targetPath}`, `{"path":"${sqlEscape(
          targetPath
        )}","strategy":"mkdir"}`);
        dbExec(`INSERT INTO cortana_immune_incidents (detected_at, threat_type, source, severity, description, threat_signature, tier, status, playbook_used, resolution, auto_resolved, metadata)
               VALUES (NOW(),'path_drift','immune_scan','warning','Missing path recovered','path_drift',1,'resolved','${sqlEscape(
                 playbook
               )}','Path recreated',TRUE,'{"path":"${sqlEscape(targetPath)}"}'::jsonb);`);
        trackPlaybookResult(playbook, true);
        return true;
      } catch {
        // fall through to missing
      }
    }

    issues += `path_drift: MISSING ${targetPath}\n`;
    logEvent("immune_alert", "warning", `Missing required path: ${targetPath}`, `{"path":"${sqlEscape(
      targetPath
    )}"}`);
    dbExec(`INSERT INTO cortana_immune_incidents (detected_at, threat_type, source, severity, description, threat_signature, tier, status, playbook_used, auto_resolved, metadata)
           VALUES (NOW(),'path_drift','immune_scan','warning','Missing required path','path_drift',1,'open','${sqlEscape(
             playbook
           )}',FALSE,'{"path":"${sqlEscape(targetPath)}"}'::jsonb);`);
    trackPlaybookResult(playbook, false);
    return false;
  };

  const quarantineFile = (src: string): boolean => {
    if (!fs.existsSync(src)) return true;
    const base = path.basename(src);
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
      now.getDate()
    ).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(
      now.getMinutes()
    ).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    const dest = path.join(QUARANTINE_DIR, `${base}.${ts}.quarantine`);

    if (dryRun) {
      issues += `sessions: WOULD_QUARANTINE ${src}\n`;
      return true;
    }

    try {
      fs.renameSync(src, dest);
      logEvent(
        "auto_heal",
        "info",
        "Quarantined file instead of delete",
        `{"from":"${sqlEscape(src)}","to":"${sqlEscape(dest)}"}`
      );
      return true;
    } catch {
      issues += `quarantine: FAILED ${src}\n`;
      logEvent("immune_alert", "warning", "Failed to quarantine file", `{"path":"${sqlEscape(src)}"}`);
      return false;
    }
  };

  const checkToolFlap = (): void => {
    if (!isExecutable(PSQL_BIN)) return;
    const row = runPsql(
      `
    SELECT tool_name || '|' || COUNT(*)::text
    FROM cortana_tool_health
    WHERE timestamp >= NOW() - INTERVAL '${FLAP_MINUTES} minutes'
      AND LOWER(COALESCE(status,'')) IN ('down','fail','failed','error')
    GROUP BY tool_name
    HAVING COUNT(*) >= ${FLAP_FAILS}
    ORDER BY COUNT(*) DESC
    LIMIT 1;
  `,
      {
        db: "cortana",
        args: ["-q", "-X", "-t", "-A"],
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    const output = (row.stdout ?? "").toString().trim();
    if (!output) return;

    const [toolName, countRaw] = output.split("|");
    const count = Number(countRaw || "0") || 0;
    issues += `tool_flap: ${toolName} ${count} fails/${FLAP_MINUTES}m\n`;

    logEvent(
      "immune_alert",
      "warning",
      `Tool flap detected: ${toolName}`,
      `{"tool":"${sqlEscape(toolName)}","failures":${count},"window_minutes":${FLAP_MINUTES}}`
    );
    dbExec(`INSERT INTO cortana_immune_incidents (detected_at, threat_type, source, severity, description, threat_signature, tier, status, playbook_used, auto_resolved, metadata)
           VALUES (NOW(),'tool_flap','immune_scan','warning','Repeated tool failures detected','tool_flap',2,'open','tool_flap_recovery',FALSE,
                   '{"tool":"${sqlEscape(toolName)}","failures":${count},"window_minutes":${FLAP_MINUTES}}'::jsonb);`);

    trackPlaybookResult("tool_flap_recovery", true);
  };

  ensurePlaybookSeeded();

  const sessionsDir = path.join(os.homedir(), ".openclaw", "agents", "main", "sessions");
  ensurePathExists(sessionsDir, true, "path_drift_recovery");
  ensurePathExists(path.join(os.homedir(), ".openclaw", "agents", "main"), true, "path_drift_recovery");
  ensurePathExists(QUARANTINE_DIR, true, "path_drift_recovery");

  const tokensFile = path.join(os.homedir(), "Developer", "cortana-external", "tonal_tokens.json");
  if (fs.existsSync(tokensFile)) {
    if (!readFileContains(tokensFile, '"access_token"')) {
      issues += "tonal: NO TOKEN\n";
    }
  } else {
    issues += "tonal: NO TOKEN\n";
  }

  if (isExecutable(PG_READY_BIN)) {
    const ready = spawnSync(PG_READY_BIN, ["-q"], { env, stdio: "ignore" });
    if (ready.status !== 0) {
      issues += "postgres: DOWN\n";
    }
  } else {
    issues += "postgres: DOWN\n";
  }

  const gateway = spawnSync("curl", ["-sf", "http://localhost:18800/json"], {
    stdio: "ignore",
  });
  if (gateway.status !== 0) {
    issues += "gateway: DOWN\n";
  }

  const dfRes = spawnSync("df", ["-h", "/"], { encoding: "utf8" });
  if (dfRes.status === 0) {
    const lines = (dfRes.stdout ?? "").toString().trim().split(/\r?\n/);
    const last = lines[lines.length - 1] ?? "";
    const parts = last.split(/\s+/);
    const usagePct = parts[4] ?? "";
    const percent = Number(usagePct.replace("%", ""));
    if (Number.isFinite(percent) && percent >= 90) {
      issues += `disk: ${usagePct}\n`;
    }
  }

  const largeSessions = listLargeSessions(sessionsDir, 400 * 1024);
  if (largeSessions.length > 0) {
    for (const filePath of largeSessions) {
      if (filePath) {
        quarantineFile(filePath);
      }
    }
    issues += "sessions: QUARANTINED\n";
  }

  checkToolFlap();
  reconcilePlaybookMetrics();

  if (issues) {
    process.stdout.write(issues);
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
