import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_HOME = process.env.HOME;

function writeLargeFile(filePath: string, sizeBytes: number) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "x".repeat(sizeBytes), "utf8");
}

describe("session-hygiene", () => {
  afterEach(() => {
    if (ORIGINAL_HOME == null) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
    vi.resetModules();
  });

  it("prints NO_REPLY when nothing breaches policy", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "session-hygiene-"));
    process.env.HOME = home;

    const mainDir = path.join(home, ".openclaw", "agents", "main", "sessions");
    fs.mkdirSync(mainDir, { recursive: true });
    fs.writeFileSync(path.join(mainDir, "sessions.json"), "{}\n", "utf8");

    const mod = await import("../../tools/session/session-hygiene");
    const output: string[] = [];
    const log = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      output.push(String(chunk));
      return true;
    });

    expect(mod.run([])).toBe(0);
    expect(output.join("")).toContain("NO_REPLY");
    log.mockRestore();
  });

  it("archives oversized main and direct-monitor sessions and removes tracked entries", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "session-hygiene-"));
    process.env.HOME = home;

    const mainDir = path.join(home, ".openclaw", "agents", "main", "sessions");
    const monitorDir = path.join(home, ".openclaw", "agents", "monitor", "sessions");
    fs.mkdirSync(mainDir, { recursive: true });
    fs.mkdirSync(monitorDir, { recursive: true });

    const mainFile = path.join(mainDir, "main.jsonl");
    const monitorFile = path.join(monitorDir, "monitor.jsonl");
    const monitorGroupFile = path.join(monitorDir, "group.jsonl");
    const orphanFile = path.join(mainDir, "orphan.jsonl");

    writeLargeFile(mainFile, 600 * 1024);
    writeLargeFile(monitorFile, 700 * 1024);
    writeLargeFile(monitorGroupFile, 700 * 1024);
    writeLargeFile(orphanFile, 500 * 1024);

    fs.writeFileSync(
      path.join(mainDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:main:telegram:direct:8171372724": { sessionFile: mainFile },
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(
      path.join(monitorDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:monitor:main": { sessionFile: monitorFile },
          "agent:monitor:telegram:group:-5006548746": { sessionFile: monitorGroupFile },
        },
        null,
        2,
      ),
      "utf8",
    );

    const mod = await import("../../tools/session/session-hygiene");
    const report = mod.applyCleanup(mod.findCandidates(new Date("2026-04-04T12:00:00.000Z")), false);

    expect(report.cleanedCount).toBe(3);
    expect(report.candidates.map((c: any) => c.key)).toEqual(
      expect.arrayContaining(["agent:main:telegram:direct:8171372724", "agent:monitor:main", null]),
    );

    expect(fs.existsSync(mainFile)).toBe(false);
    expect(fs.existsSync(monitorFile)).toBe(false);
    expect(fs.existsSync(orphanFile)).toBe(false);

    const mainStore = JSON.parse(fs.readFileSync(path.join(mainDir, "sessions.json"), "utf8"));
    const monitorStore = JSON.parse(fs.readFileSync(path.join(monitorDir, "sessions.json"), "utf8"));

    expect(mainStore["agent:main:telegram:direct:8171372724"]).toBeUndefined();
    expect(monitorStore["agent:monitor:main"]).toBeUndefined();
    expect(monitorStore["agent:monitor:telegram:group:-5006548746"]).toBeTruthy();
    expect(fs.existsSync(monitorGroupFile)).toBe(true);

    const archived = report.candidates.map((c: any) => c.archivedFile);
    for (const file of archived) expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(mainDir, "sessions.json.bak"))).toBe(true);
    expect(fs.existsSync(path.join(monitorDir, "sessions.json.bak"))).toBe(true);
  });
});
