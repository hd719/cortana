import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("heartbeat check script compatibility paths", () => {
  it("provides heartbeat validator and health-check shell entrypoints", () => {
    expect(existsSync("tools/heartbeat/validate-heartbeat-state.sh")).toBe(true);
    expect(existsSync("tools/heartbeat/check-heartbeat-health.sh")).toBe(true);
  });

  it("provides task-board hygiene entrypoint", () => {
    expect(existsSync("tools/task-board/hygiene.ts")).toBe(true);
    const src = readFileSync("tools/task-board/hygiene.ts", "utf8");
    expect(src).toContain("tools/task-board/reset-engine.ts");
  });

  it("provides task detection entrypoint", () => {
    expect(existsSync("tools/task-board/detect-from-conversation.ts")).toBe(true);
    const src = readFileSync("tools/task-board/detect-from-conversation.ts", "utf8");
    expect(src).toContain("tools/proactive/detect.ts");
  });

  it("provides rotated tech news entrypoint", () => {
    expect(existsSync("tools/news/tech-news-check.ts")).toBe(true);
  });
});
