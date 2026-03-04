#!/usr/bin/env npx tsx

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Severity = "warning" | "critical";

type Violation = {
  timestamp: string;
  command: string;
  source: string;
  severity: Severity;
};

type DetectionResult = {
  violations: Violation[];
  clean: boolean;
};

const CLI_PATTERN = /(^|\s)(claude|codex)(\s|$)/i;
const SPAWN_PATTERN = /(sessions_spawn|openclaw\s+sessions?_spawn)/i;

const CLAUDE_SAFE_COMMANDS = new Set([
  "claude",
  "claude --help",
  "claude setup-token",
  "claude config show",
]);

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim().toLowerCase();
}

function isAllowedIntentionalCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  return CLAUDE_SAFE_COMMANDS.has(normalized);
}
const MAX_HISTORY_LINES = 2000;
const PSQL_BIN = "/opt/homebrew/opt/postgresql@17/bin/psql";
const PSQL_DB = "cortana";
const EXEC_LOG_CANDIDATES = [
  join(homedir(), ".openclaw", "logs", "exec.log"),
  join(homedir(), ".openclaw", "gateway", "logs", "exec.log"),
  join(process.cwd(), "logs", "exec.log"),
  join(process.cwd(), ".openclaw", "logs", "exec.log"),
];

function isoNow(): string {
  return new Date().toISOString();
}

function asViolation(source: string, command: string, timestamp?: string, severity: Severity = "warning"): Violation {
  return {
    timestamp: timestamp ?? isoNow(),
    command: command.trim(),
    source,
    severity,
  };
}

function parseZshHistory(lines: string[]): Violation[] {
  const findings: Violation[] = [];

  for (const line of lines) {
    // Typical zsh EXTENDED_HISTORY: ": 1700000000:0;command"
    const match = line.match(/^: (\d+):\d+;(.*)$/);
    const command = (match?.[2] ?? line).trim();

    if (!CLI_PATTERN.test(command)) continue;
    if (SPAWN_PATTERN.test(command)) continue;
    if (isAllowedIntentionalCommand(command)) continue;

    const ts = match?.[1] ? new Date(Number(match[1]) * 1000).toISOString() : isoNow();
    findings.push(asViolation("zsh_history", command, ts));
  }

  return findings;
}

function scanShellHistory(): Violation[] {
  const historyPath = join(homedir(), ".zsh_history");
  if (!existsSync(historyPath)) return [];

  const raw = readFileSync(historyPath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const recent = lines.slice(-MAX_HISTORY_LINES);
  return parseZshHistory(recent);
}

function scanExecLogs(): Violation[] {
  const findings: Violation[] = [];

  for (const path of EXEC_LOG_CANDIDATES) {
    if (!existsSync(path)) continue;

    const raw = readFileSync(path, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(-MAX_HISTORY_LINES);

    for (const line of lines) {
      if (!CLI_PATTERN.test(line)) continue;
      if (SPAWN_PATTERN.test(line)) continue;
      if (isAllowedIntentionalCommand(line)) continue;
      findings.push(asViolation(`exec_log:${path}`, line));
    }
  }

  return findings;
}

function scanRunningProcesses(): Violation[] {
  let out = "";
  try {
    out = execSync("ps -axo pid=,command=", { encoding: "utf8" });
  } catch {
    return [];
  }

  const findings: Violation[] = [];

  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(/^(\d+)\s+(.*)$/);
    const pid = match?.[1];
    const command = match?.[2] ?? trimmed;

    if (!CLI_PATTERN.test(command)) continue;
    if (isAllowedIntentionalCommand(command)) continue;

    // Allowlist: managed command wrappers / this detector itself.
    const managed = /openclaw|sessions_spawn|detect-cli-spawns\.ts/i.test(command);
    if (managed) continue;

    findings.push(asViolation("process_scan", `[pid ${pid}] ${command}`, isoNow(), "critical"));
  }

  return findings;
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runPsqlQuery(query: string): string {
  const command = `${PSQL_BIN} -X -t -A -F $'\\t' -v ON_ERROR_STOP=1 -d ${PSQL_DB} -c ${sqlLiteral(query)}`;
  return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function scanCortanaEvents(): Violation[] {
  const query = `
    SELECT
      to_char(COALESCE(timestamp, NOW()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts,
      regexp_replace(COALESCE(message, ''), E'[\\t\\n\\r]+', ' ', 'g') AS message,
      regexp_replace(COALESCE(source, 'cortana_events'), E'[\\t\\n\\r]+', ' ', 'g') AS source,
      CASE WHEN COALESCE(severity, 'warning') = 'critical' THEN 'critical' ELSE 'warning' END AS severity,
      regexp_replace(COALESCE(metadata::text, ''), E'[\\t\\n\\r]+', ' ', 'g') AS metadata_text
    FROM cortana_events
    WHERE COALESCE(timestamp, NOW()) >= NOW() - INTERVAL '24 hours'
      AND (
        COALESCE(message, '') ~* '(claude|codex)'
        OR COALESCE(metadata::text, '') ~* '(claude|codex)'
      )
      AND NOT (
        COALESCE(message, '') ~* 'sessions_spawn'
        OR COALESCE(metadata::text, '') ~* 'sessions_spawn'
      )
    ORDER BY COALESCE(timestamp, NOW()) DESC
    LIMIT 100
  `;

  const output = runPsqlQuery(query);
  if (!output) return [];

  const rows = output.split(/\r?\n/).filter(Boolean);
  return rows
    .map((row) => {
      const [timestamp = isoNow(), message = "", source = "cortana_events", severity = "warning", metadataText = ""] = row.split("\t");
      return asViolation(
        `cortana_events:${source}`,
        message || metadataText || "Direct CLI spawn pattern in cortana_events",
        timestamp,
        severity === "critical" ? "critical" : "warning",
      );
    })
    .filter((v) => !isAllowedIntentionalCommand(v.command));
}

function logImmuneIncident(violations: Violation[]): void {
  if (violations.length === 0) return;

  const signature = "direct-cli-agent-spawn";
  const description = `Detected ${violations.length} direct CLI agent spawn violation(s) outside sessions_spawn.`;
  const metadataJson = JSON.stringify({ violations }).replace(/'/g, "''");

  const query = `
    INSERT INTO cortana_immune_incidents
    (threat_type, source, severity, description, threat_signature, tier, status, playbook_used, resolution, auto_resolved, metadata)
    VALUES
    (
      'policy_violation',
      'detect-cli-spawns.ts',
      'warning',
      ${sqlLiteral(description)},
      ${sqlLiteral(signature)},
      1,
      'detected',
      'spawn-guardrail',
      'Pending corrective action',
      false,
      '${metadataJson}'::jsonb
    )
  `;

  runPsqlQuery(query);
}

function logCorrectiveFeedback(violations: Violation[]): void {
  if (violations.length === 0) return;

  const context = {
    detector: "tools/guardrails/detect-cli-spawns.ts",
    count: violations.length,
    sample: violations.slice(0, 10),
  };

  const contextJson = JSON.stringify(context).replace(/'/g, "''");
  const lesson = "Agent spawning must go through sessions_spawn only. Do not invoke claude/codex CLI directly.";

  const query = `
    INSERT INTO cortana_feedback
    (feedback_type, context, lesson, applied)
    VALUES
    (
      'guardrail_violation',
      '${contextJson}',
      ${sqlLiteral(lesson)},
      false
    )
  `;

  runPsqlQuery(query);
}

function dedupeViolations(violations: Violation[]): Violation[] {
  const seen = new Set<string>();
  const out: Violation[] = [];

  for (const v of violations) {
    const key = `${v.source}|${v.command}|${v.timestamp}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }

  return out;
}

async function run(): Promise<DetectionResult> {
  const localViolations = [
    ...scanShellHistory(),
    ...scanExecLogs(),
    ...scanRunningProcesses(),
  ];

  let dbViolations: Violation[] = [];

  try {
    dbViolations = scanCortanaEvents();
  } catch {
    // Keep detector resilient even when DB is unavailable.
  }

  const violations = dedupeViolations([...localViolations, ...dbViolations]);

  try {
    logImmuneIncident(violations);
    logCorrectiveFeedback(violations);
  } catch {
    // If writes fail, still emit detector output.
  }

  return {
    violations,
    clean: violations.length === 0,
  };
}

run()
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[detect-cli-spawns] ${message}\n`);
    const fallback: DetectionResult = { violations: [], clean: true };
    process.stdout.write(`${JSON.stringify(fallback, null, 2)}\n`);
    process.exit(1);
  });
