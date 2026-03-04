import { describe, expect, it } from "vitest";
import { chunkMessage, parseGuardArgs } from "../../tools/notifications/telegram-delivery-guard.ts";

describe("telegram delivery guard", () => {
  it("parses positional args with defaults", () => {
    const parsed = parseGuardArgs(["hello"]);
    expect(parsed.message).toBe("hello");
    expect(parsed.target).toBe("8171372724");
    expect(parsed.alertType).toBe("generic_alert");
    expect(parsed.dedupeKey).toBe("");
  });

  it("chunks oversized payload by line and hard split fallback", () => {
    const longLine = "x".repeat(4200);
    const msg = `line1\n${longLine}`;
    const chunks = chunkMessage(msg, 3500);
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toBe("line1");
    expect(chunks[1].length).toBe(3500);
    expect(chunks[2].length).toBe(700);
  });
});
