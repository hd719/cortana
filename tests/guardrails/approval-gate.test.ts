import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, importFresh, resetProcess, setArgv } from "../test-utils";

const readJsonFile = vi.hoisted(() => vi.fn());
const randomUUID = vi.hoisted(() => vi.fn(() => "11111111-1111-1111-1111-111111111111"));

vi.mock("../../tools/lib/json-file.js", () => ({
  readJsonFile,
}));
vi.mock("node:crypto", () => ({
  default: {
    randomUUID,
  },
}));

beforeEach(() => {
  readJsonFile.mockReset();
  randomUUID.mockReset();
  randomUUID.mockReturnValue("11111111-1111-1111-1111-111111111111");
  readJsonFile.mockImplementation((filePath?: string) => {
    if (String(filePath).endsWith("/state/system-routing.json")) return null;
    return { channels: { telegram: {} } };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProcess();
});

describe("approval-gate", () => {
  it("requires action and risk", async () => {
    const consoleCapture = captureConsole();
    setArgv(["--action", "do-stuff"]);

    const module = await importFresh("../../tools/guardrails/approval-gate.ts");
    const code = await module.main();
    expect(consoleCapture.errors.join(" ")).toContain("--action and --risk are required");
    expect(code).toBe(2);
  });

  it("auto-approves low risk without fetch or approval request ids", async () => {
    const consoleCapture = captureConsole();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy as any);
    setArgv(["--action", "local build", "--risk", "low"]);

    const module = await importFresh("../../tools/guardrails/approval-gate.ts");
    const code = await module.main();
    expect(consoleCapture.logs.join(" ")).toContain("APPROVED");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(randomUUID).not.toHaveBeenCalled();
    expect(code).toBe(0);
  });


  it("rejects cleanly when chat lookup throws", async () => {
    const consoleCapture = captureConsole();
    process.env.TELEGRAM_BOT_TOKEN = "token";
    readJsonFile.mockImplementation((filePath?: string) => {
      if (String(filePath).endsWith("/state/system-routing.json")) return null;
      return { channels: { telegram: { allowFrom: [] } } };
    });
    const fetchSpy = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    vi.stubGlobal("fetch", fetchSpy as any);

    setArgv(["--action", "send email", "--risk", "high"]);

    const module = await importFresh("../../tools/guardrails/approval-gate.ts");
    const code = await module.main();
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(consoleCapture.logs.join(" ")).toContain("DENIED (chat_lookup_failed)");
    expect(code).toBe(1);
  });
  it("rejects an approval when no chat id is available", async () => {
    const consoleCapture = captureConsole();
    process.env.TELEGRAM_BOT_TOKEN = "token";
    readJsonFile.mockImplementation((filePath?: string) => {
      if (String(filePath).endsWith("/state/system-routing.json")) return null;
      return { channels: { telegram: {} } };
    });
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: [] }),
    }));
    vi.stubGlobal("fetch", fetchSpy as any);

    setArgv(["--action", "send email", "--risk", "high"]);

    const module = await importFresh("../../tools/guardrails/approval-gate.ts");
    const code = await module.main();
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(consoleCapture.logs.join(" ")).toContain("DENIED (no_chat_id)");
    expect(code).toBe(1);
  });

  it("uses configured approval routing from openclaw config", async () => {
    const consoleCapture = captureConsole();
    process.env.TELEGRAM_BOT_TOKEN = "";
    delete process.env.TELEGRAM_CHAT_ID;
    readJsonFile.mockImplementation((filePath?: string) => {
      if (String(filePath).endsWith("/state/system-routing.json")) {
        return {
          telegram: {
            approvals: {
              accountId: "default",
              chatId: "8171372724",
            },
          },
        };
      }
      return {
        channels: {
          telegram: {
            accounts: {
              default: {
                botToken: "config-token",
              },
            },
          },
        },
      };
    });

    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/sendMessage")) {
        return {
          ok: true,
          json: async () => ({ ok: true, result: { message_id: 123 } }),
        };
      }
      if (url.includes("/getUpdates")) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            result: [
              {
                update_id: 42,
                callback_query: {
                  id: "cb-1",
                  data: "approve:11111111-1111-1111-1111-111111111111",
                },
              },
            ],
          }),
        };
      }
      if (url.includes("/answerCallbackQuery")) {
        return {
          ok: true,
          json: async () => ({ ok: true }),
        };
      }
      if (url.includes("/editMessageReplyMarkup")) {
        return {
          ok: true,
          json: async () => ({ ok: true }),
        };
      }
      throw new Error(`Unhandled fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy as any);
    setArgv(["--action", "send email", "--risk", "high", "--timeout", "1"]);

    const module = await importFresh("../../tools/guardrails/approval-gate.ts");
    const code = await module.main();

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("https://api.telegram.org/botconfig-token/sendMessage"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("\"chat_id\":\"8171372724\""),
      }),
    );
    expect(consoleCapture.logs.join(" ")).toContain("APPROVED");
    expect(code).toBe(0);
  });
});
