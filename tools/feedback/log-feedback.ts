#!/usr/bin/env npx tsx

import { insertFeedbackItem } from "../lib/mission-control-ledger.js";

function isUuid(value: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
}

function lessonFromDetails(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const lesson = (parsed as Record<string, unknown>).lesson;
      return lesson == null ? "" : String(lesson);
    }
  } catch {
    return "";
  }
  return "";
}

function recurrenceKey(detailsJson: string, summary: string): string {
  const lesson = lessonFromDetails(detailsJson);
  const base = lesson || summary;
  return base.toLowerCase().trim().replace(/\s+/g, " ").replace(/[^a-z0-9 ]/g, "").slice(0, 50).trim();
}

function legacyFeedbackType(category: string, severity: string): string {
  if (category === "preference") return "preference";
  if (category === "policy") return severity === "low" ? "approval" : "rejection";
  return "correction";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error(`Usage: ${process.argv[1] ?? "log-feedback.ts"} <category> <severity> <summary> [details_json] [agent_id] [task_id]`);
    process.exit(1);
  }

  const category = args[0] ?? "";
  const severity = args[1] ?? "";
  const summary = args[2] ?? "";
  const detailsJson = args[3] && args[3].length > 0 ? args[3] : "{}";
  const agentId = args[4] ?? "";
  const taskId = args[5] ?? "";
  const recurrence = recurrenceKey(detailsJson, summary);

  let parsedDetails: Record<string, unknown> = {};
  try {
    parsedDetails = JSON.parse(detailsJson) as Record<string, unknown>;
  } catch {
    parsedDetails = { raw_details: detailsJson };
  }

  const feedbackId = insertFeedbackItem({
    source: "user",
    category,
    severity,
    summary,
    details: {
      ...parsedDetails,
      lesson: lessonFromDetails(detailsJson),
      feedback_type: legacyFeedbackType(category, severity),
      applied: false,
    },
    recurrenceKey: recurrence || null,
    status: "new",
    taskId: taskId && isUuid(taskId) ? taskId : null,
    agentId: agentId || null,
  });

  console.log(feedbackId);
}

main();
