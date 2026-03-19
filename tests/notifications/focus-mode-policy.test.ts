import { describe, expect, it } from "vitest";
import { formatUserMessage, type NotificationEnvelope } from "../../tools/notifications/focus-mode-policy";

describe("focus-mode policy formatting", () => {
  it("does not append a duplicate related-detections suffix when the message already contains one", () => {
    const envelope: NotificationEnvelope = {
      message: "📈 Trading Advisor — Market Snapshot\n🔎 Related detections: 118",
      target: "8171372724",
      alertType: "generic_alert",
      dedupeKey: "test",
      severity: "P1",
      owner: "monitor",
      system: "Trading Advisor",
      actionNeeded: "now",
    };

    const rendered = formatUserMessage(envelope, { hits: 3, combined: true });

    expect(rendered.match(/Related detections:/g)?.length ?? 0).toBe(1);
    expect(rendered).toContain("🔎 Related detections: 118");
    expect(rendered).not.toContain("Related detections: 3");
  });
});
