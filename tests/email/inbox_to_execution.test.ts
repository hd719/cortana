import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushModuleSideEffects, importFresh, resetProcess } from "../test-utils";

const spawnSync = vi.hoisted(() => vi.fn(() => ({ status: 0 })));
const mkdtempSync = vi.hoisted(() => vi.fn(() => "/tmp/pywrap-test"));
const writeFileSync = vi.hoisted(() => vi.fn());
const rmSync = vi.hoisted(() => vi.fn());
const buildGogEnv = vi.hoisted(() => vi.fn((env: NodeJS.ProcessEnv) => ({ ...env, GOG_KEYRING_PASSWORD: "secret" })));
const ensureGatewayPathPrefix = vi.hoisted(() => vi.fn((value?: string) => `/Users/hd/.openclaw/bin:${value ?? ""}`));
const readMergedGatewayEnvSources = vi.hoisted(() => vi.fn(() => ({ GOG_KEYRING_PASSWORD: "secret" })));
const exitSpy = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawnSync,
}));

vi.mock("node:fs", () => ({
  mkdtempSync,
  writeFileSync,
  rmSync,
}));

vi.mock("../../tools/gog/gog-with-env.js", () => ({
  buildGogEnv,
}));

vi.mock("../../tools/openclaw/gateway-env.js", () => ({
  ensureGatewayPathPrefix,
  readMergedGatewayEnvSources,
}));

describe("inbox_to_execution wrapper", () => {
  beforeEach(() => {
    spawnSync.mockReset();
    mkdtempSync.mockReset();
    writeFileSync.mockReset();
    rmSync.mockReset();
    buildGogEnv.mockReset();
    ensureGatewayPathPrefix.mockReset();
    readMergedGatewayEnvSources.mockReset();

    spawnSync.mockReturnValue({ status: 0 });
    mkdtempSync.mockReturnValue("/tmp/pywrap-test");
    buildGogEnv.mockImplementation((env: NodeJS.ProcessEnv) => ({ ...env, GOG_KEYRING_PASSWORD: "secret" }));
    ensureGatewayPathPrefix.mockImplementation((value?: string) => `/Users/hd/.openclaw/bin:${value ?? ""}`);
    readMergedGatewayEnvSources.mockReturnValue({ GOG_KEYRING_PASSWORD: "secret" });
    vi.stubGlobal("process", { ...process, exit: exitSpy });
    exitSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetProcess();
  });

  it("launches the embedded python with recovered gog env", async () => {
    await importFresh("../../tools/email/inbox_to_execution.ts");
    await flushModuleSideEffects();

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(readMergedGatewayEnvSources).toHaveBeenCalled();
    expect(buildGogEnv).toHaveBeenCalledWith(
      expect.objectContaining({
        PATH: expect.stringContaining("/Users/hd/.openclaw/bin"),
      }),
      { GOG_KEYRING_PASSWORD: "secret" },
    );
    expect(spawnSync).toHaveBeenCalledWith(
      "python3",
      expect.arrayContaining(["/tmp/pywrap-test/script.py"]),
      expect.objectContaining({
        stdio: "inherit",
        env: expect.objectContaining({
          GOG_KEYRING_PASSWORD: "secret",
        }),
      }),
    );
  });

  it("embeds best-effort Gmail timeout handling for secondary scans", async () => {
    await importFresh("../../tools/email/inbox_to_execution.ts");
    await flushModuleSideEffects();

    const scriptSource = writeFileSync.mock.calls.find((call) => String(call[0]).endsWith("/script.py"))?.[1];
    expect(String(scriptSource)).toContain("self.warnings: list[str] = []");
    expect(String(scriptSource)).toContain("best_effort: bool = False");
    expect(String(scriptSource)).toContain("timeout_retries: int = 3");
    expect(String(scriptSource)).toContain("def _run_with_timeout_retries");
    expect(String(scriptSource)).toContain("time.sleep(min(2.0, 0.5 * (attempt + 1)))");
    expect(String(scriptSource)).toContain("timed out after retries; continuing with partial inbox triage");
    expect(String(scriptSource)).toContain("label=\"stale/orphan sent-thread lookup\"");
    expect(String(scriptSource)).toContain("\"warnings\": runner.warnings");
  });
});
