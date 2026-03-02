import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();

vi.mock("../../tools/lib/db.js", () => ({
  query,
}));

beforeEach(() => {
  query.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("decisions", () => {
  it("creation with all fields", async () => {
    query.mockReturnValue("42");
    const { logDecision } = await import("../../tools/decisions/log-decision.ts");

    const id = logDecision(
      "financial",
      "critical",
      "Ship payroll updates",
      { source: "test", amount: 500 },
      90
    );

    expect(id).toBe(42);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0]?.[0] ?? "";
    expect(sql).toContain("INSERT INTO cortana_decisions");
    expect(sql).toContain("'financial'");
    expect(sql).toContain("'critical'");
    expect(sql).toContain("expires_at");
  });

  it("resolve updates status + resolved_at", async () => {
    query.mockReturnValue("7");
    const { resolveDecision } = await import("../../tools/decisions/resolve-decision.ts");

    const id = resolveDecision(7, "executed", "Done");

    expect(id).toBe(7);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0]?.[0] ?? "";
    expect(sql).toContain("UPDATE cortana_decisions");
    expect(sql).toContain("resolved_at=NOW()");
    expect(sql).toContain("status='executed'");
  });

  it("check-pending filtering", async () => {
    const payload = [
      {
        id: 1,
        created_at: "2026-03-02T08:00:00Z",
        category: "financial",
        summary: "Review payout",
        details: null,
        status: "pending",
        priority: "high",
        expires_at: null,
      },
    ];
    query.mockReturnValue(JSON.stringify(payload));
    const { checkPendingDecisions } = await import("../../tools/decisions/check-pending.ts");

    const results = checkPendingDecisions("financial");

    expect(results).toHaveLength(1);
    expect(results[0]?.category).toBe("financial");
    const sql = query.mock.calls[0]?.[0] ?? "";
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("category = 'financial'");
  });

  it("expired detection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-02T12:00:00Z"));
    const payload = [
      {
        id: 2,
        created_at: "2026-03-02T06:00:00Z",
        category: "system",
        summary: "Rotate keys",
        details: null,
        status: "pending",
        priority: "high",
        expires_at: "2026-03-02T10:00:00Z",
      },
    ];
    query.mockReturnValue(JSON.stringify(payload));
    const { checkPendingDecisions } = await import("../../tools/decisions/check-pending.ts");

    const results = checkPendingDecisions();

    expect(results[0]?.expired).toBe(true);
    expect(results[0]?.flag).toBe("EXPIRED - NEEDS ATTENTION");
  });

  it("category validation", async () => {
    const { logDecision } = await import("../../tools/decisions/log-decision.ts");
    expect(() =>
      logDecision("invalid", "normal", "Test", { ok: true }, 30)
    ).toThrow(/Invalid category/);
  });
});
