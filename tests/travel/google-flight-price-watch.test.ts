import { describe, expect, it } from "vitest";
import {
  buildNoEmailStatus,
  shouldSendNoEmailStatus,
} from "../../tools/travel/google-flight-price-watch.ts";

describe("google-flight-price-watch", () => {
  it("sends one no-email status per day", () => {
    expect(shouldSendNoEmailStatus({ version: 1, sentMessageIds: [] }, "2026-05-05")).toBe(true);
    expect(
      shouldSendNoEmailStatus(
        { version: 1, sentMessageIds: [], lastNoEmailStatusDate: "2026-05-05" },
        "2026-05-05",
      ),
    ).toBe(false);
    expect(
      shouldSendNoEmailStatus(
        { version: 1, sentMessageIds: [], lastNoEmailStatusDate: "2026-05-04" },
        "2026-05-05",
      ),
    ).toBe(true);
  });

  it("keeps the no-email status concise and actionable", () => {
    const status = buildNoEmailStatus();

    expect(status).toContain("Morocco Flights - watcher alive");
    expect(status).toContain("No matching Google Flights price-alert emails");
    expect(status).toContain("enable Google Flights price tracking");
    expect(status.split(/\s+/).length).toBeLessThanOrEqual(60);
  });
});
