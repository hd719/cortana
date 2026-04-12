import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import {
  chunkMessage,
  parseGuardArgs,
  resolveTelegramAccountId,
  sendWithRetries,
} from "../../tools/notifications/telegram-delivery-guard.ts";

describe("telegram delivery guard", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-guard-test-"));
  const configPath = path.join(tmpRoot, "openclaw.json");

  beforeEach(() => {
    vi.clearAllMocks();
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        channels: {
          telegram: {
            accounts: {
              default: { botToken: "default-token" },
              monitor: { botToken: "monitor-token" },
            },
          },
        },
      }),
    );
  });

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

  it("retries transient failures and succeeds", () => {
    const mocked = vi.mocked(spawnSync);
    mocked
      .mockReturnValueOnce({ status: 1, stderr: "temporary send failure", stdout: "" } as any)
      .mockReturnValueOnce({ status: 0, stderr: "", stdout: "ok" } as any);

    expect(() => sendWithRetries("8171372724", ["hello"], "monitor", 2)).not.toThrow();
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(mocked).toHaveBeenLastCalledWith(
      "openclaw",
      expect.arrayContaining(["--account", "monitor"]),
      expect.any(Object),
    );
  });

  it("throws after max retries", () => {
    const mocked = vi.mocked(spawnSync);
    mocked.mockReturnValue({ status: 1, stderr: "permanent failure", stdout: "" } as any);

    expect(() => sendWithRetries("8171372724", ["hello"], "default", 2)).toThrow(/failed sending chunk/);
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("routes monitor-owned alerts through the monitor account when configured", () => {
    expect(resolveTelegramAccountId("monitor", configPath)).toBe("monitor");
  });

  it("falls back to default when the owner account is not configured", () => {
    expect(resolveTelegramAccountId("cortana", configPath)).toBe("default");
  });
});
