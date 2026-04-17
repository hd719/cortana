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

  it("provides inbox-operational entrypoint", () => {
    expect(existsSync("tools/email/inbox_to_execution.ts")).toBe(true);
  });

  it("documents current heartbeat entrypoints instead of deprecated wrappers", () => {
    const rootHeartbeat = readFileSync("HEARTBEAT.md", "utf8");
    const readme = readFileSync("README.md", "utf8");
    const monitorHeartbeat = readFileSync("identities/monitor/HEARTBEAT.md", "utf8");
    const monitorSoul = readFileSync("identities/monitor/SOUL.md", "utf8");
    const oracleHeartbeat = readFileSync("identities/oracle/HEARTBEAT.md", "utf8");
    const oracleSoul = readFileSync("identities/oracle/SOUL.md", "utf8");
    const heartbeatDoctrine = readFileSync("docs/source/doctrine/heartbeat-ops.md", "utf8");

    expect(rootHeartbeat).toContain("tools/news/tech-news-check.ts");
    expect(rootHeartbeat).toContain("tools/email/inbox_to_execution.ts --output-json");
    expect(rootHeartbeat).toContain("Do not invent or call deprecated heartbeat wrappers");
    expect(rootHeartbeat).toContain("do not send a Telegram message");
    expect(rootHeartbeat).toContain("Reply exactly `NO_REPLY` in-session only");
    expect(rootHeartbeat).toContain("Agent-to-agent announce step.");
    expect(rootHeartbeat).toContain("ANNOUNCE_SKIP");

    expect(monitorHeartbeat).toContain("tools/news/tech-news-check.ts");
    expect(monitorHeartbeat).toContain("tools/email/inbox_to_execution.ts --output-json");
    expect(monitorHeartbeat).toContain("Do not call deprecated wrappers");
    expect(monitorHeartbeat).toContain("Healthy path means the full reply must be exactly `HEARTBEAT_OK`");
    expect(monitorHeartbeat).toContain("Do not replace `HEARTBEAT_OK` with silence or `NO_REPLY`");
    expect(monitorHeartbeat).toContain("delegated healthy tasks stay silent by returning `NO_REPLY` in-session only");
    expect(monitorHeartbeat).toContain("status-check-only request");
    expect(monitorHeartbeat).toContain("ANNOUNCE_SKIP");
    expect(monitorSoul).toContain("Do not add greetings, status summaries, emojis, or follow-up questions on the healthy path");
    expect(monitorSoul).toContain("Do not suppress `HEARTBEAT_OK` into silence or `NO_REPLY`");
    expect(monitorSoul).toContain("do not send a Telegram message; return `NO_REPLY` in-session only");
    expect(monitorSoul).toContain("do not repeat the same alert in follow-up status-check prompts");
    expect(monitorSoul).toContain("Agent-to-agent announce step.");
    expect(oracleHeartbeat).toContain("If no action is needed: HEARTBEAT_OK");
    expect(oracleHeartbeat).toContain("delegated healthy tasks stay silent by returning `NO_REPLY` in-session only");
    expect(oracleSoul).toContain("do not send a Telegram message; return `NO_REPLY` in-session only");
    expect(heartbeatDoctrine).toContain("If the active workspace `HEARTBEAT.md` defines an explicit healthy-path token");
    expect(heartbeatDoctrine).toContain("Exact-token precedence");
    expect(heartbeatDoctrine).toContain("Do not silently suppress an explicit healthy-path token");
    expect(heartbeatDoctrine).toContain("It does not mean delegated `sessions_send` heartbeat tasks should send those tokens through the `message` tool");
    expect(readme).toContain("Healthy delegated heartbeat/maintenance paths stay silent by returning `NO_REPLY` in-session only");
  });
});
