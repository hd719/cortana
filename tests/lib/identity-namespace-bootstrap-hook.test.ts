import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import identityNamespaceBootstrapHook from "../../hooks/identity-namespace-bootstrap/handler.js";

describe("identity namespace bootstrap hook", () => {
  it("replaces path-qualified bootstrap entries for namespaced identity files", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "identity-bootstrap-hook-"));

    fs.mkdirSync(path.join(workspace, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "config", "identity-namespaces.json"),
      JSON.stringify(
        {
          defaultNamespace: "main",
          namespaces: { main: "main", monitor: "monitor" },
        },
        null,
        2,
      ),
      "utf8",
    );

    const monitorDir = path.join(workspace, "identities", "monitor");
    fs.mkdirSync(monitorDir, { recursive: true });
    fs.writeFileSync(path.join(monitorDir, "SOUL.md"), "# Monitor soul\n", "utf8");
    fs.writeFileSync(path.join(monitorDir, "TOOLS.md"), "# Monitor tools\n", "utf8");

    const event = {
      event: "agent:bootstrap",
      context: {
        agentId: "monitor",
        workspaceDir: workspace,
        bootstrapFiles: [
          {
            name: "identities/main/SOUL.md",
            path: path.join(workspace, "SOUL.md"),
            content: "# Main soul\n",
            missing: false,
          },
          {
            name: "TOOLS.md",
            path: path.join(workspace, "TOOLS.md"),
            content: "# Main tools\n",
            missing: false,
          },
        ],
      },
    };

    await identityNamespaceBootstrapHook(event as any);

    const soulEntry = event.context.bootstrapFiles.find((file: any) => file.name === "SOUL.md");
    expect(soulEntry).toBeTruthy();
    expect(soulEntry.path).toBe(path.join(workspace, "identities", "monitor", "SOUL.md"));
    expect(soulEntry.content).toBe("# Monitor soul\n");
    expect(soulEntry.missing).toBe(false);

    const toolsEntry = event.context.bootstrapFiles.find((file: any) => file.name === "TOOLS.md");
    expect(toolsEntry).toBeTruthy();
    expect(toolsEntry.path).toBe(path.join(workspace, "identities", "monitor", "TOOLS.md"));
    expect(toolsEntry.content).toBe("# Monitor tools\n");
    expect(toolsEntry.missing).toBe(false);
  });
});
