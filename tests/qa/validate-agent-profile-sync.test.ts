import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { evaluateAgentProfileSync } from "../../tools/qa/validate-agent-profile-sync";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("validate-agent-profile-sync", () => {
  it("passes when agent profiles mirror openclaw agent list", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-profile-sync-"));
    writeJson(path.join(root, "config", "openclaw.json"), {
      agents: {
        list: [
          { id: "main", workspace: "/repo", model: { primary: "openai-codex/gpt-5.4" } },
          { id: "monitor", workspace: "/repo/identities/monitor", model: "openai-codex/gpt-5.1" },
        ],
      },
    });
    writeJson(path.join(root, "config", "agent-profiles.json"), [
      { id: "main", workspace: "/repo", model: "openai-codex/gpt-5.4", identityNamespace: "main" },
      { id: "monitor", workspace: "/repo/identities/monitor", model: "openai-codex/gpt-5.1", identityNamespace: "monitor" },
    ]);
    writeJson(path.join(root, "config", "identity-namespaces.json"), {
      defaultNamespace: "main",
      namespaces: { main: "main", monitor: "monitor" },
    });

    const report = evaluateAgentProfileSync({
      openclawPath: path.join(root, "config", "openclaw.json"),
      agentProfilesPath: path.join(root, "config", "agent-profiles.json"),
      identityNamespacesPath: path.join(root, "config", "identity-namespaces.json"),
    });

    expect(report.ok).toBe(true);
    expect(report.mismatches).toEqual([]);
  });

  it("detects model, namespace, and stale-entry drift", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-profile-sync-"));
    writeJson(path.join(root, "config", "openclaw.json"), {
      agents: {
        list: [
          { id: "main", workspace: "/repo", model: { primary: "openai-codex/gpt-5.4" } },
          { id: "spartan", workspace: "/repo/identities/spartan", model: "openai-codex/gpt-5.3-codex" },
        ],
      },
    });
    writeJson(path.join(root, "config", "agent-profiles.json"), [
      { id: "main", workspace: "/repo", model: "openai-codex/gpt-5.1", identityNamespace: "main" },
      { id: "spartan", workspace: "/repo/identities/spartan", model: "openai-codex/gpt-5.3-codex" },
      { id: "old-agent", workspace: "/repo", model: "openai-codex/gpt-5.1" },
    ]);
    writeJson(path.join(root, "config", "identity-namespaces.json"), {
      defaultNamespace: "main",
      namespaces: { main: "main", spartan: "spartan" },
    });

    const report = evaluateAgentProfileSync({
      openclawPath: path.join(root, "config", "openclaw.json"),
      agentProfilesPath: path.join(root, "config", "agent-profiles.json"),
      identityNamespacesPath: path.join(root, "config", "identity-namespaces.json"),
    });

    expect(report.ok).toBe(false);
    expect(report.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: "main", issue: "model_mismatch" }),
        expect.objectContaining({ agentId: "spartan", issue: "identity_namespace_mismatch" }),
        expect.objectContaining({ agentId: "old-agent", issue: "stale_profile_entry" }),
      ]),
    );
  });
});
