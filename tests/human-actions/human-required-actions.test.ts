import { describe, expect, it } from "vitest";
import {
  closeHumanRequiredAction,
  decideAlert,
  digestHumanRequiredActions,
  listHumanRequiredActions,
  normalizeHumanRequiredActionInput,
  redactSecrets,
  upsertHumanRequiredAction,
  type HumanRequiredActionRow,
  type HumanRequiredActionStore,
  type NormalizedHumanRequiredAction,
} from "../../tools/human-actions/human-required-actions.ts";

class MemoryStore implements HumanRequiredActionStore {
  rows: HumanRequiredActionRow[] = [];
  ensured = false;
  nextId = 1;

  ensureSchema(): void {
    this.ensured = true;
  }

  findOpenByFingerprint(fingerprint: string): HumanRequiredActionRow | null {
    return this.rows.find((row) => row.status === "open" && row.fingerprint === fingerprint) ?? null;
  }

  create(input: NormalizedHumanRequiredAction, nowIso: string, alertCount: number): HumanRequiredActionRow {
    const row: HumanRequiredActionRow = {
      id: this.nextId++,
      fingerprint: input.fingerprint,
      system: input.system,
      category: input.category,
      owner_lane: input.ownerLane,
      severity: input.severity,
      status: "open",
      summary: input.summary,
      required_action: input.requiredAction,
      verification_key: input.verificationKey,
      verification_args: input.verificationArgs,
      evidence: input.evidence,
      metadata: input.metadata,
      material_digest: input.materialDigest,
      detection_count: 1,
      alert_count: alertCount,
      first_seen_at: nowIso,
      last_seen_at: nowIso,
      next_remind_at: input.nextRemindAt,
      due_at: input.dueAt,
      verified_at: null,
      resolved_at: null,
      resolved_by: null,
      resolution_note: null,
    };
    this.rows.push(row);
    return row;
  }

  updateOpen(existing: HumanRequiredActionRow, input: NormalizedHumanRequiredAction, nowIso: string, alertIncrement: number): HumanRequiredActionRow {
    Object.assign(existing, {
      system: input.system,
      category: input.category,
      owner_lane: input.ownerLane,
      severity: input.severity,
      summary: input.summary,
      required_action: input.requiredAction,
      verification_key: input.verificationKey,
      verification_args: input.verificationArgs,
      evidence: input.evidence,
      metadata: input.metadata,
      material_digest: input.materialDigest,
      detection_count: existing.detection_count + 1,
      alert_count: existing.alert_count + alertIncrement,
      last_seen_at: nowIso,
      next_remind_at: input.nextRemindAt ?? existing.next_remind_at,
      due_at: input.dueAt ?? existing.due_at,
    });
    return existing;
  }

  getById(id: number): HumanRequiredActionRow | null {
    return this.rows.find((row) => row.id === id) ?? null;
  }

  list(status: "open" | "verified" | "resolved" | "ignored" | "expired" | "all", limit: number): HumanRequiredActionRow[] {
    return this.rows
      .filter((row) => status === "all" || row.status === status)
      .slice(0, limit);
  }

  close(id: number, status: "verified" | "resolved" | "ignored" | "expired", resolvedBy: string, note: string | null, nowIso: string): HumanRequiredActionRow {
    const row = this.getById(id);
    if (!row) throw new Error(`missing row ${id}`);
    row.status = status;
    row.resolved_at = nowIso;
    row.resolved_by = resolvedBy;
    row.resolution_note = note;
    return row;
  }
}

function appleInput(extra: Partial<Parameters<typeof upsertHumanRequiredAction>[0]> = {}) {
  return {
    fingerprint: "apple_health:human_setup:latest_export",
    system: "apple_health",
    category: "human_setup",
    ownerLane: "monitor",
    severity: "warning",
    summary: "Apple Health export needs attention",
    requiredAction: "Refresh Apple Health export.",
    verificationKey: "apple_health_freshness",
    evidence: { path: "/tmp/latest.json", token: "secret-token", observed_at: "2026-05-05T10:00:00Z" },
    ...extra,
  };
}

describe("human-required action queue", () => {
  it("redacts secret-like fields before persistence", () => {
    expect(redactSecrets({ apiKey: "abc", nested: { refresh_token: "tok", message: "Bearer abc.def" } })).toEqual({
      apiKey: "[REDACTED]",
      nested: { refresh_token: "[REDACTED]", message: "Bearer [REDACTED]" },
    });
  });

  it("dedupes repeated detections into one open item and suppresses unchanged alerts", () => {
    const store = new MemoryStore();
    const first = upsertHumanRequiredAction(appleInput(), { store, now: new Date("2026-05-05T10:00:00Z") });
    const second = upsertHumanRequiredAction(appleInput({ evidence: { path: "/tmp/latest.json", token: "rotated-secret", observed_at: "2026-05-05T10:05:00Z" } }), {
      store,
      now: new Date("2026-05-05T10:05:00Z"),
    });

    expect(store.ensured).toBe(true);
    expect(first.created).toBe(true);
    expect(first.shouldAlert).toBe(true);
    expect(second.created).toBe(false);
    expect(second.shouldAlert).toBe(false);
    expect(second.row.detection_count).toBe(2);
    expect(second.row.alert_count).toBe(1);
    expect(store.rows).toHaveLength(1);
    expect(second.row.evidence).not.toHaveProperty("token", "secret-token");
  });

  it("allows material changes and severity increases to alert again", () => {
    const store = new MemoryStore();
    upsertHumanRequiredAction(appleInput(), { store });

    const changed = upsertHumanRequiredAction(appleInput({ requiredAction: "Install the exporter and regenerate latest.json." }), { store });
    const severe = upsertHumanRequiredAction(appleInput({ severity: "critical" }), { store });

    expect(changed.materiallyChanged).toBe(true);
    expect(changed.shouldAlert).toBe(true);
    expect(severe.severityIncreased).toBe(true);
    expect(severe.shouldAlert).toBe(true);
    expect(severe.row.alert_count).toBe(3);
  });

  it("treats due open items as alertable even when unchanged", () => {
    const existing = normalizeHumanRequiredActionInput(appleInput({ dueAt: "2026-05-05T10:00:00Z" }));
    const row = new MemoryStore().create(existing, "2026-05-05T09:00:00Z", 1);
    const decision = decideAlert(row, existing, new Date("2026-05-05T10:01:00Z"));
    expect(decision.due).toBe(true);
    expect(decision.shouldAlert).toBe(true);
  });

  it("lists, digests, and closes open items", () => {
    const store = new MemoryStore();
    const created = upsertHumanRequiredAction(appleInput(), { store });

    expect(listHumanRequiredActions({ store })).toHaveLength(1);
    expect(digestHumanRequiredActions({ store })).toContain("Human-required actions open: 1");

    const closed = closeHumanRequiredAction(created.row.id, { store, status: "resolved", resolvedBy: "monitor", note: "fixed" });
    expect(closed.status).toBe("resolved");
    expect(closed.resolution_note).toBe("fixed");
    expect(digestHumanRequiredActions({ store })).toBe("NO_REPLY");
  });
});
