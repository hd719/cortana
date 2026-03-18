import { runPsql } from "../lib/db.js";
import type { ReadinessBand } from "./signal-utils.js";

export type HealthInsight = {
  id: number;
  title: string;
  description: string;
  actionSuggested: string | null;
  priority: number;
};

function parseJsonArray(raw: string): any[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    return [];
  }
  return [];
}

export function fetchPendingHealthInsights(limit = 6): HealthInsight[] {
  const sql = `
SELECT COALESCE(json_agg(t), '[]'::json)::text
FROM (
  SELECT id, title, description, action_suggested, COALESCE(priority, 3) AS priority
  FROM cortana_insights
  WHERE acted_on = FALSE
    AND 'health' = ANY(domains)
  ORDER BY COALESCE(priority, 3) ASC, timestamp DESC
  LIMIT ${Math.max(1, Math.min(limit, 20))}
) t;`;
  const result = runPsql(sql);
  if (result.status !== 0) return [];
  const rows = parseJsonArray(String(result.stdout ?? ""));
  return rows
    .map((row) => ({
      id: Number(row?.id),
      title: String(row?.title ?? ""),
      description: String(row?.description ?? ""),
      actionSuggested: row?.action_suggested == null ? null : String(row.action_suggested),
      priority: Number.isFinite(Number(row?.priority)) ? Number(row.priority) : 3,
    }))
    .filter((row) => Number.isFinite(row.id) && row.title.length > 0);
}

export function chooseSurfacedInsightIds(
  insights: HealthInsight[],
  readinessBand: ReadinessBand,
  maxCount = 2,
): number[] {
  if (!insights.length) return [];
  const budget = readinessBand === "red" ? Math.min(maxCount, 2) : 1;
  return insights
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .slice(0, Math.max(0, budget))
    .map((insight) => insight.id);
}

export function markInsightsSql(ids: number[]): string | null {
  const cleaned = ids.filter((id) => Number.isFinite(id)).map((id) => Math.trunc(id));
  if (!cleaned.length) return null;
  const inList = cleaned.join(", ");
  return `UPDATE cortana_insights SET acted_on = TRUE, acted_at = NOW() WHERE id IN (${inList});`;
}

