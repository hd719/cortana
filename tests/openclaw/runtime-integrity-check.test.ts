import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole, flushModuleSideEffects, importFresh, mockExit, resetProcess, setArgv } from "../test-utils";

const spawnSync = vi.hoisted(() => vi.fn());
const reconcileGatewayPlistEnv = vi.hoisted(() => vi.fn());
const writeGatewayEnvStateFile = vi.hoisted(() => vi.fn());
const readMergedGatewayEnvSources = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawnSync }));
vi.mock("../../tools/openclaw/gateway-env.ts", () => ({
  DEFAULT_GATEWAY_ENV_STATE_PATH: "/tmp/gateway-env.json",
  reconcileGatewayPlistEnv,
  writeGatewayEnvStateFile,
  readMergedGatewayEnvSources,
}));

describe("runtime-integrity-check", () => {
  beforeEach(() => {
    spawnSync.mockReset();
    reconcileGatewayPlistEnv.mockReset();
    writeGatewayEnvStateFile.mockReset();
    readMergedGatewayEnvSources.mockReset();
    readMergedGatewayEnvSources.mockReturnValue({ GOG_KEYRING_PASSWORD: "secret" });
    reconcileGatewayPlistEnv.mockReturnValue({ updated: true, applied: { GOG_KEYRING_PASSWORD: "secret" } });
    writeGatewayEnvStateFile.mockReturnValue({ GOG_KEYRING_PASSWORD: "secret" });
    resetProcess();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetProcess();
  });

  it("reports healthy when gateway, gog, and telegram are healthy", async () => {
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = args.join(" ");
      if (cmd === "openclaw" && joined === "gateway status --no-probe") return { status: 0, stdout: "running", stderr: "" } as any;
      if (cmd === "gog") return { status: 0, stdout: "[]", stderr: "" } as any;
      if (cmd === "openclaw" && joined === "plugins inspect telegram") return { status: 0, stdout: "Status: loaded", stderr: "" } as any;
      throw new Error(`unexpected spawn ${cmd} ${joined}`);
    });

    setArgv(["--json"]);
    const exitSpy = mockExit();
    const consoleSpy = captureConsole();
    await importFresh("../../tools/openclaw/runtime-integrity-check.ts");
    await flushModuleSideEffects();
    consoleSpy.restore();

    const parsed = JSON.parse(consoleSpy.logs.join("\n"));
    expect(parsed.overall_ok).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("repairs gog env drift when repair mode is enabled", async () => {
    let gogCalls = 0;
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      const joined = args.join(" ");
      if (cmd === "openclaw" && joined === "gateway status --no-probe") return { status: 0, stdout: "running", stderr: "" } as any;
      if (cmd === "gog") {
        gogCalls += 1;
        return gogCalls === 1
          ? { status: 1, stdout: "", stderr: "no TTY available" } as any
          : { status: 0, stdout: "[]", stderr: "" } as any;
      }
      if (cmd === "openclaw" && joined === "plugins inspect telegram") return { status: 0, stdout: "Status: loaded", stderr: "" } as any;
      throw new Error(`unexpected spawn ${cmd} ${joined}`);
    });

    setArgv(["--json", "--repair"]);
    const exitSpy = mockExit();
    const consoleSpy = captureConsole();
    await importFresh("../../tools/openclaw/runtime-integrity-check.ts");
    await flushModuleSideEffects();
    consoleSpy.restore();

    const parsed = JSON.parse(consoleSpy.logs.join("\n"));
    expect(parsed.overall_ok).toBe(true);
    expect(parsed.results.find((item: any) => item.name === "gog_headless_auth").repaired).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
