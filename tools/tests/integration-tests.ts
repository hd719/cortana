#!/usr/bin/env npx tsx
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { resolveRepoPath } from "../lib/paths.js";

const PSQL_BIN = "/opt/homebrew/opt/postgresql@17/bin/psql";
const DB_NAME = "cortana";
const ROOT_DIR = resolveRepoPath();

const STATE_ENFORCER = path.join(ROOT_DIR, "tools", "task-board", "state-enforcer.sh");
const STALE_DETECTOR = path.join(ROOT_DIR, "tools", "task-board", "stale-detector.sh");
const COST_BREAKER = path.join(ROOT_DIR, "tools", "alerting", "cost-breaker.sh");
const CRON_PREFLIGHT = path.join(ROOT_DIR, "tools", "alerting", "cron-preflight.sh");
const OAUTH_REFRESH = path.join(ROOT_DIR, "tools", "gog", "oauth-refresh.sh");
const META_MONITOR = path.join(ROOT_DIR, "tools", "meta-monitor", "meta-monitor.ts");
const SELF_DIAG = path.join(ROOT_DIR, "tools", "self-diagnostic", "self-diagnostic.sh");

const reportRows: string[] = [];
let anyFail = false;
const testTaskIds: string[] = [];

function nowMs(): number {
  return Date.now();
}

function jsonOk(payload: string): boolean {
  try {
    JSON.parse(payload);
    return true;
  } catch {
    return false;
  }
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandExists(bin: string): boolean {
  const res = spawnSync(`command -v ${bin}`, { shell: true, stdio: "ignore" });
  return res.status === 0;
}

function checkDeps(): boolean {
  let missing = false;
  for (const bin of [PSQL_BIN, "jq", "python3", "timeout"]) {
    if (!commandExists(bin) && !isExecutable(bin)) {
      process.stderr.write(`Missing dependency: ${bin}\n`);
      missing = true;
    }
  }
  return !missing;
}

function sanitizeOutput(output: string): string {
  return output.replace(/\r?\n/g, " ").slice(0, 300);
}

function runCommandCapture(cmd: string): { rc: number; output: string } {
  const res = spawnSync("bash", ["-lc", cmd], { encoding: "utf8" });
  const stdout = (res.stdout ?? "").toString();
  const stderr = (res.stderr ?? "").toString();
  return { rc: res.status ?? 1, output: stdout + stderr };
}

function recordResult(tool: string, status: "pass" | "fail", runtimeMs: number, error: string): void {
  reportRows.push(`${tool}|${status}|${runtimeMs}|${error}`);
  if (status === "fail") {
    anyFail = true;
  }
}

function createTestTask(title: string): string | null {
  const sql = `
INSERT INTO cortana_tasks (source, title, description, priority, status, auto_executable, metadata)
VALUES (
  'integration-tests',
  '${title}',
  'Temporary task created by tools/tests/integration-tests.sh',
  5,
  'ready',
  false,
  jsonb_build_object('integration_test', true, 'created_at', NOW())
)
RETURNING id;
`;

  const res = spawnSync(
    PSQL_BIN,
    [DB_NAME, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { encoding: "utf8" }
  );
  if (res.status !== 0) return null;
  const id = String(res.stdout ?? "").replace(/\s+/g, "");
  if (!id) return null;
  testTaskIds.push(id);
  return id;
}

function cleanupTestTasks(): void {
  if (testTaskIds.length === 0) return;
  const csv = testTaskIds.join(",");
  spawnSync(PSQL_BIN, [DB_NAME, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", `DELETE FROM cortana_tasks WHERE id IN (${csv});`], {
    stdio: "ignore",
  });
}

function runJsonTest(name: string, cmd: string): void {
  const start = nowMs();
  const { rc, output } = runCommandCapture(cmd);
  const runtime = nowMs() - start;

  if (rc !== 0) {
    recordResult(name, "fail", runtime, `exit_code=${rc} output=${sanitizeOutput(output)}`);
    return;
  }

  if (!jsonOk(output)) {
    recordResult(name, "fail", runtime, `invalid_json output=${sanitizeOutput(output)}`);
    return;
  }

  recordResult(name, "pass", runtime, "");
}

function runTextTest(name: string, cmd: string, expectSubstr: string): void {
  const start = nowMs();
  const { rc, output } = runCommandCapture(cmd);
  const runtime = nowMs() - start;

  if (rc !== 0) {
    recordResult(name, "fail", runtime, `exit_code=${rc} output=${sanitizeOutput(output)}`);
    return;
  }

  if (expectSubstr && !output.includes(expectSubstr)) {
    recordResult(
      name,
      "fail",
      runtime,
      `missing_expected_substring='${expectSubstr}' output=${sanitizeOutput(output)}`
    );
    return;
  }

  recordResult(name, "pass", runtime, "");
}

function testStateEnforcerTransitions(): void {
  const start = nowMs();

  const spawnTask = createTestTask(`IT spawn-start ${Math.floor(Date.now() / 1000)}`);
  if (!spawnTask) {
    const runtime = nowMs() - start;
    recordResult(
      "tools/task-board/state-enforcer.sh:spawn-start",
      "fail",
      runtime,
      "failed_to_create_test_task"
    );
    return;
  }

  const completeTask = createTestTask(`IT complete ${Math.floor(Date.now() / 1000)}`);
  if (!completeTask) {
    const runtime = nowMs() - start;
    recordResult(
      "tools/task-board/state-enforcer.sh:complete",
      "fail",
      runtime,
      "failed_to_create_test_task"
    );
    return;
  }

  const failTask = createTestTask(`IT fail ${Math.floor(Date.now() / 1000)}`);
  if (!failTask) {
    const runtime = nowMs() - start;
    recordResult(
      "tools/task-board/state-enforcer.sh:fail",
      "fail",
      runtime,
      "failed_to_create_test_task"
    );
    return;
  }

  const spawnCmd = `"${STATE_ENFORCER}" spawn-start "${spawnTask}" "integration-test-agent"`;
  const spawnStart = nowMs();
  const spawnRes = runCommandCapture(spawnCmd);
  const spawnRuntime = nowMs() - spawnStart;
  let spawnOk = false;
  if (spawnRes.rc === 0 && jsonOk(spawnRes.output)) {
    try {
      const parsed = JSON.parse(spawnRes.output);
      spawnOk = parsed?.ok === true;
    } catch {
      spawnOk = false;
    }
  }
  if (!spawnOk) {
    recordResult(
      "tools/task-board/state-enforcer.sh:spawn-start",
      "fail",
      spawnRuntime,
      `output=${sanitizeOutput(spawnRes.output)}`
    );
  } else {
    recordResult("tools/task-board/state-enforcer.sh:spawn-start", "pass", spawnRuntime, "");
  }

  runTextTest(
    "tools/task-board/state-enforcer.sh:prep-complete",
    `"${STATE_ENFORCER}" spawn-start "${completeTask}" "integration-test-agent" >/dev/null`,
    ""
  );

  const completeStart = nowMs();
  const completeRes = runCommandCapture(`"${STATE_ENFORCER}" complete "${completeTask}" "integration test complete"`);
  const completeRuntime = nowMs() - completeStart;
  let completeOk = false;
  if (completeRes.rc === 0 && jsonOk(completeRes.output)) {
    try {
      const parsed = JSON.parse(completeRes.output);
      completeOk = parsed?.ok === true;
    } catch {
      completeOk = false;
    }
  }
  if (!completeOk) {
    recordResult(
      "tools/task-board/state-enforcer.sh:complete",
      "fail",
      completeRuntime,
      `output=${sanitizeOutput(completeRes.output)}`
    );
  } else {
    recordResult("tools/task-board/state-enforcer.sh:complete", "pass", completeRuntime, "");
  }

  runTextTest(
    "tools/task-board/state-enforcer.sh:prep-fail",
    `"${STATE_ENFORCER}" spawn-start "${failTask}" "integration-test-agent" >/dev/null`,
    ""
  );

  const failStart = nowMs();
  const failRes = runCommandCapture(`"${STATE_ENFORCER}" fail "${failTask}" "integration test fail"`);
  const failRuntime = nowMs() - failStart;
  let failOk = false;
  if (failRes.rc === 0 && jsonOk(failRes.output)) {
    try {
      const parsed = JSON.parse(failRes.output);
      failOk = parsed?.ok === true;
    } catch {
      failOk = false;
    }
  }
  if (!failOk) {
    recordResult(
      "tools/task-board/state-enforcer.sh:fail",
      "fail",
      failRuntime,
      `output=${sanitizeOutput(failRes.output)}`
    );
  } else {
    recordResult("tools/task-board/state-enforcer.sh:fail", "pass", failRuntime, "");
  }
}

function printReport(): void {
  process.stdout.write("tool|status|runtime_ms|error\n");
  for (const row of reportRows) {
    process.stdout.write(`${row}\n`);
  }
}

async function main(): Promise<number> {
  if (!checkDeps()) {
    process.stderr.write("Dependency check failed\n");
    return 1;
  }

  try {
    testStateEnforcerTransitions();
    runJsonTest("tools/task-board/stale-detector.sh", `"${STALE_DETECTOR}" run`);
    runJsonTest("tools/alerting/cost-breaker.sh", `"${COST_BREAKER}"`);
    runTextTest(
      "tools/alerting/cron-preflight.sh",
      `"${CRON_PREFLIGHT}" integration-tests pg`,
      "preflight"
    );
    runTextTest("tools/gog/oauth-refresh.sh", `"${OAUTH_REFRESH}"`, "gog oauth");
    runJsonTest("tools/meta-monitor/meta-monitor.sh", `"${META_MONITOR}" --json`);
    runTextTest("tools/self-diagnostic/self-diagnostic.sh", `"${SELF_DIAG}" --brief`, "overall=");

    printReport();

    return anyFail ? 1 : 0;
  } finally {
    cleanupTestTasks();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
