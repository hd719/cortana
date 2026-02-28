#!/usr/bin/env npx tsx
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { runPsql, withPostgresPath } from "../lib/db.js";

const PATH_OVERRIDE = "/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/local/bin:/usr/bin:/bin";

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

function ensureIntentId(
  intentEmitter: string,
  alertType: string,
  env: NodeJS.ProcessEnv,
  currentIntentId: string
): string {
  if (currentIntentId) return currentIntentId;
  if (!intentEmitter || !isExecutable(intentEmitter)) return currentIntentId;

  const expectedSeconds = Number(process.env.ALERT_EXPECTED_DELIVERY_SECONDS ?? "120");
  const expectedDate = new Date(Date.now() + expectedSeconds * 1000);
  const expectedTs = expectedDate.toISOString().replace(/\.\d{3}Z$/, "Z");

  const res = spawnSync(intentEmitter, [alertType, "telegram", expectedTs], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const raw = (res.stdout ?? "").toString().trim();
  if (!raw) return currentIntentId;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.intent_id === "string") {
      return parsed.intent_id;
    }
  } catch {
    return currentIntentId;
  }
  return currentIntentId;
}

function logAlertDelivery(
  dbName: string,
  env: NodeJS.ProcessEnv,
  source: string,
  status: string,
  attemptCount: number,
  chatId: string,
  parseMode: string,
  alertType: string,
  alertKey: string,
  intentId: string,
  detail: string
): void {
  const escMsg = sqlEscape(
    `Alert delivery ${status}: type=${alertType}, key=${alertKey}, intent_id=${intentId}`
  );
  const safeDetail = sqlEscape(detail);
  const metaJson = `{"chat_id":"${chatId}","parse_mode":"${parseMode}","alert_type":"${alertType}","alert_key":"${alertKey}","intent_id":"${intentId}","status":"${status}","attempts":${attemptCount},"detail":"${safeDetail}"}`;
  const escMeta = sqlEscape(metaJson);

  const sql = `INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('alert_delivery', '${source}', 'info', '${escMsg}', '${escMeta}'::jsonb);`;
  runPsql(sql, {
    db: dbName,
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function logDeliveryFailure(
  dbName: string,
  env: NodeJS.ProcessEnv,
  source: string,
  chatId: string,
  parseMode: string,
  alertType: string,
  alertKey: string,
  intentId: string,
  detail: string
): void {
  const escMsg = sqlEscape(`Telegram delivery failed after retry: ${detail}`);
  const metaJson = `{"chat_id":"${chatId}","parse_mode":"${parseMode}","alert_type":"${alertType}","alert_key":"${alertKey}","intent_id":"${intentId}"}`;
  const escMeta = sqlEscape(metaJson);
  const sql = `INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('delivery_failure', '${source}', 'warning', '${escMsg}', '${escMeta}'::jsonb);`;
  runPsql(sql, {
    db: dbName,
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function sendOnce(
  chatId: string,
  messageText: string,
  env: NodeJS.ProcessEnv
): { ok: boolean; output: string } {
  const res = spawnSync(
    "openclaw",
    [
      "message",
      "send",
      "--channel",
      "telegram",
      "--target",
      chatId,
      "--message",
      messageText,
      "--json",
    ],
    {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const stdout = (res.stdout ?? "").toString();
  const stderr = (res.stderr ?? "").toString();
  const response = stdout + stderr;

  if (
    res.status === 0 &&
    response.trim() &&
    !response.includes('"ok":false') &&
    !response.includes('"error"')
  ) {
    return { ok: true, output: response };
  }

  return { ok: false, output: response };
}

async function main(): Promise<number> {
  const env = withPostgresPath({ ...process.env, PATH: `${PATH_OVERRIDE}:${process.env.PATH ?? ""}` });
  const DEFAULT_CHAT_ID = "8171372724";
  const dbName = process.env.CORTANA_DB ?? "cortana";
  const source = "telegram-delivery-guard";
  const intentEmitter =
    process.env.ALERT_INTENT_EMITTER ?? "/Users/hd/openclaw/tools/alerting/emit-alert-intent.sh";

  const messageText = process.argv[2] ?? "";
  const chatId = process.argv[3] ?? DEFAULT_CHAT_ID;
  const parseMode = process.argv[4] ?? "";
  const alertType = process.argv[5] ?? process.env.ALERT_TYPE ?? "generic";
  const alertKey = process.argv[6] ?? process.env.ALERT_KEY ?? String(Date.now());
  let intentId = process.argv[7] ?? process.env.ALERT_INTENT_ID ?? "";

  if (!messageText) {
    process.stderr.write(
      `Usage: ${path.basename(process.argv[1] ?? "telegram-delivery-guard.ts")} "message text" [chat_id] [parse_mode] [alert_type] [alert_key] [intent_id]\n`
    );
    return 1;
  }

  intentId = ensureIntentId(intentEmitter, alertType, env, intentId);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-delivery-guard."));
  const tempFile = path.join(tempDir, "out.txt");

  try {
    const first = sendOnce(chatId, messageText, env);
    fs.writeFileSync(tempFile, first.output);
    if (first.ok) {
      logAlertDelivery(
        dbName,
        env,
        source,
        "delivered",
        1,
        chatId,
        parseMode,
        alertType,
        alertKey,
        intentId,
        "delivered on first attempt"
      );
      return 0;
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const second = sendOnce(chatId, messageText, env);
    fs.writeFileSync(tempFile, second.output);
    if (second.ok) {
      logAlertDelivery(
        dbName,
        env,
        source,
        "delivered",
        2,
        chatId,
        parseMode,
        alertType,
        alertKey,
        intentId,
        "delivered on retry"
      );
      return 0;
    }

    const failureDetail = fs.existsSync(tempFile)
      ? fs.readFileSync(tempFile, "utf8")
      : "unknown error";

    logAlertDelivery(
      dbName,
      env,
      source,
      "failed",
      2,
      chatId,
      parseMode,
      alertType,
      alertKey,
      intentId,
      failureDetail
    );
    logDeliveryFailure(
      dbName,
      env,
      source,
      chatId,
      parseMode,
      alertType,
      alertKey,
      intentId,
      failureDetail
    );
    return 1;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
