import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computePreservedGatewayEnv,
  ensureGatewayPathPrefix,
  readGatewayEnvStateFile,
  readPlistEnvironmentVariables,
  reconcileGatewayPlistEnv,
  writeGatewayEnvStateFile,
} from "../../tools/openclaw/gateway-env.ts";

const tempPaths: string[] = [];

afterEach(() => {
  for (const target of tempPaths.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe("gateway env preservation", () => {
  it("prefers current shell env over existing plist values", () => {
    const env = computePreservedGatewayEnv(
      { GOG_KEYRING_PASSWORD: "from-shell" } as NodeJS.ProcessEnv,
      { GOG_KEYRING_PASSWORD: "from-plist" },
    );
    expect(env.GOG_KEYRING_PASSWORD).toBe("from-shell");
  });

  it("falls back to existing plist values when shell env is absent", () => {
    const env = computePreservedGatewayEnv(
      {} as NodeJS.ProcessEnv,
      { GOG_KEYRING_PASSWORD: "from-plist" },
    );
    expect(env.GOG_KEYRING_PASSWORD).toBe("from-plist");
  });

  it("drops empty values", () => {
    const env = computePreservedGatewayEnv(
      { GOG_KEYRING_PASSWORD: "   " } as NodeJS.ProcessEnv,
      {},
    );
    expect(env.GOG_KEYRING_PASSWORD).toBeUndefined();
  });

  it("writes and reloads the durable gateway env state file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-env-test-"));
    tempPaths.push(dir);
    const statePath = path.join(dir, "gateway-env.json");

    const written = writeGatewayEnvStateFile(
      { GOG_KEYRING_PASSWORD: "from-shell" } as NodeJS.ProcessEnv,
      {},
      statePath,
    );

    expect(written.GOG_KEYRING_PASSWORD).toBe("from-shell");
    expect(readGatewayEnvStateFile(statePath)).toEqual({ GOG_KEYRING_PASSWORD: "from-shell" });
  });

  it("uses preserved fallback values when rewriting durable gateway env state", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-env-test-"));
    tempPaths.push(dir);
    const statePath = path.join(dir, "gateway-env.json");

    writeGatewayEnvStateFile(
      {} as NodeJS.ProcessEnv,
      { GOG_KEYRING_PASSWORD: "from-preserved-source" },
      statePath,
    );

    expect(readGatewayEnvStateFile(statePath)).toEqual({ GOG_KEYRING_PASSWORD: "from-preserved-source" });
  });

  it("prepends the runtime bin dir to PATH exactly once", () => {
    expect(ensureGatewayPathPrefix("/usr/bin:/bin", "/tmp/openclaw-bin")).toBe("/tmp/openclaw-bin:/usr/bin:/bin");
    expect(ensureGatewayPathPrefix("/tmp/openclaw-bin:/usr/bin:/bin", "/tmp/openclaw-bin")).toBe("/tmp/openclaw-bin:/usr/bin:/bin");
  });

  it.skipIf(process.platform !== "darwin")("adds EnvironmentVariables when reconciling an env-wrapper plist", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-env-test-"));
    tempPaths.push(dir);
    const plistPath = path.join(dir, "ai.openclaw.gateway.plist");
    fs.writeFileSync(
      plistPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.openclaw.gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>/tmp/env-wrapper.sh</string>
  </array>
</dict>
</plist>
`,
      "utf8",
    );

    const result = reconcileGatewayPlistEnv(
      plistPath,
      { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv,
      { GOG_KEYRING_PASSWORD: "from-state" },
    );

    expect(result.updated).toBe(true);
    expect(readPlistEnvironmentVariables(plistPath)).toMatchObject({
      GOG_KEYRING_PASSWORD: "from-state",
      PATH: expect.stringContaining("/usr/bin:/bin"),
    });
  });
});
