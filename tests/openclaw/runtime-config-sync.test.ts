import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRuntimeConfig, syncRuntimeConfig } from "../../tools/openclaw/runtime-config-sync";

describe("runtime-config-sync", () => {
  it("keeps premium agents on GPT-5.5/high and cron agents on GPT-5.4/medium", () => {
    const configPath = path.resolve(__dirname, "../../config/openclaw.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const agents = config.agents.list;
    const cronAgentIds = new Set([
      "cron-health",
      "cron-fitness",
      "cron-market",
      "cron-comms",
      "cron-maintenance",
    ]);

    expect(config.agents.defaults.thinkingDefault).toBeUndefined();
    expect(config.agents.defaults.model.primary).toBe("openai-codex/gpt-5.5");
    expect(config.agents.defaults.models["openai-codex/gpt-5.4"].params.thinking).toBe("medium");
    expect(config.agents.defaults.models["openai-codex/gpt-5.5"].params.thinking).toBe("high");
    expect(config.agents.defaults.heartbeat.model).toBe("openai-codex/gpt-5.5");
    expect(config.agents.defaults.subagents.model).toBe("openai-codex/gpt-5.5");
    expect(agents.length).toBeGreaterThan(0);

    for (const agent of agents) {
      const model = typeof agent.model === "string" ? agent.model : agent.model?.primary;
      if (cronAgentIds.has(agent.id)) {
        expect(model).toBe("openai-codex/gpt-5.4");
        expect(agent.thinkingDefault).toBe("medium");
      } else {
        expect(model).toBe("openai-codex/gpt-5.5");
        expect(agent.thinkingDefault).toBe("high");
      }
    }
  });

  it("tracks OpenClaw doctor config migrations without dropping enabled plugins", () => {
    const configPath = path.resolve(__dirname, "../../config/openclaw.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

    expect(config.plugins.bundledDiscovery).toBe("allowlist");
    expect(config.tools.web.search.provider).toBe("duckduckgo");
    expect(config.plugins.allow).not.toContain("brave");
    expect(config.plugins.allow).toContain("duckduckgo");
    expect(config.plugins.allow).toContain("browser");
    expect(config.plugins.entries.brave).toBeUndefined();
    expect(config.plugins.entries.duckduckgo.enabled).toBe(true);
    expect(config.plugins.entries.browser.enabled).toBe(true);
    expect(config.messages.groupChat.visibleReplies).toBe("message_tool");
    expect(config.session.maintenance.rotateBytes).toBeUndefined();
    expect(config.channels.telegram.streaming).toEqual({ mode: "off" });
    expect(config.channels.telegram.accounts.monitor.streaming).toEqual({ mode: "off" });
  });

  it("preserves live secrets from prior runtime sources and strips unsupported threadBindings", () => {
    const source = {
      models: { providers: { openai: { apiKey: "REDACTED_USE_LIVE_CONFIG" } } },
      channels: {
        telegram: {
          threadBindings: { enabled: true },
          accounts: {
            default: { botToken: "REDACTED_USE_LIVE_CONFIG" },
            monitor: { botToken: "REDACTED_USE_LIVE_CONFIG" },
          },
        },
      },
      gateway: { auth: { token: "REDACTED_USE_LIVE_CONFIG" } },
    };
    const runtime = {
      models: { providers: { openai: { apiKey: "live-openai-key" } } },
      channels: { telegram: { accounts: { default: { botToken: "default-live-token" }, monitor: { botToken: "monitor-live-token" } } } },
      gateway: { auth: { token: "live-gateway-token" } },
    };

    const merged = buildRuntimeConfig(source, [runtime]);
    expect(merged.models.providers.openai.apiKey).toBe("live-openai-key");
    expect(merged.channels.telegram.accounts.default.botToken).toBe("default-live-token");
    expect(merged.channels.telegram.accounts.monitor.botToken).toBe("monitor-live-token");
    expect(merged.gateway.auth.token).toBe("live-gateway-token");
    expect(merged.channels.telegram.threadBindings).toBeUndefined();
  });

  it("writes runtime config using backups when current runtime is redacted", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-config-sync-"));
    const sourcePath = path.join(tempDir, "source.json");
    const runtimePath = path.join(tempDir, "runtime.json");
    const backupPath = `${runtimePath}.bak.2`;

    fs.writeFileSync(sourcePath, JSON.stringify({
      channels: { telegram: { threadBindings: { enabled: true }, accounts: { default: { botToken: "REDACTED_USE_LIVE_CONFIG" } } } },
      gateway: { auth: { token: "REDACTED_USE_LIVE_CONFIG" } },
    }));
    fs.writeFileSync(runtimePath, JSON.stringify({
      channels: { telegram: { accounts: { default: { botToken: "REDACTED_USE_LIVE_CONFIG" } } } },
      gateway: { auth: { token: "REDACTED_USE_LIVE_CONFIG" } },
    }));
    fs.writeFileSync(backupPath, JSON.stringify({
      channels: { telegram: { accounts: { default: { botToken: "real-token" } } } },
      gateway: { auth: { token: "real-gateway" } },
    }));

    const result = syncRuntimeConfig(sourcePath, runtimePath, false);
    const written = JSON.parse(fs.readFileSync(runtimePath, "utf8"));

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(written.channels.telegram.accounts.default.botToken).toBe("real-token");
    expect(written.gateway.auth.token).toBe("real-gateway");
    expect(written.channels.telegram.threadBindings).toBeUndefined();
  });
});
