import { describe, expect, it } from "vitest";
import { buildGogEnv, resolveRealGogBin } from "../../tools/gog/gog-with-env.ts";

describe("buildGogEnv", () => {
  it("prefers the current env password when already present", () => {
    const env = buildGogEnv(
      { GOG_KEYRING_PASSWORD: "from-shell" } as NodeJS.ProcessEnv,
      { GOG_KEYRING_PASSWORD: "from-plist" },
    );
    expect(env.GOG_KEYRING_PASSWORD).toBe("from-shell");
  });

  it("inherits the gateway plist password when current env is headless", () => {
    const env = buildGogEnv(
      {} as NodeJS.ProcessEnv,
      { GOG_KEYRING_PASSWORD: "from-plist" },
    );
    expect(env.GOG_KEYRING_PASSWORD).toBe("from-plist");
  });

  it("leaves env unchanged when no password is available anywhere", () => {
    const env = buildGogEnv({ PATH: "/usr/bin" } as NodeJS.ProcessEnv, {});
    expect(env.GOG_KEYRING_PASSWORD).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("prefers the explicit real Gog binary when provided", () => {
    expect(resolveRealGogBin({ OPENCLAW_REAL_GOG_BIN: "/custom/gog" } as NodeJS.ProcessEnv)).toBe("/custom/gog");
  });
});
