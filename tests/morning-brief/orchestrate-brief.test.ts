import { describe, expect, it, vi } from "vitest";
import {
  buildBrief,
  fetchWeatherWithRunCommand,
  parsePeriod,
  parseCalendarEvents,
  sessionsSendWithRunCommand,
} from "../../tools/morning-brief/orchestrate-brief.ts";

describe("parseCalendarEvents", () => {
  it("sorts, deduplicates, and formats schedule lines", () => {
    const lines = parseCalendarEvents([
      {
        summary: "Design review",
        start: { dateTime: "2026-04-06T14:00:00.000Z" },
      },
      {
        summary: "Standup",
        start: { dateTime: "2026-04-06T13:00:00.000Z" },
      },
      {
        summary: "Standup",
        start: { dateTime: "2026-04-06T13:00:00.000Z" },
      },
      {
        summary: "Tax day",
        start: { date: "2026-04-06" },
      },
    ]);

    expect(lines).toEqual([
      "All day - Tax day",
      "9:00 AM - Standup",
      "10:00 AM - Design review",
    ]);
  });
});

describe("parsePeriod", () => {
  it("only accepts explicit period flags", () => {
    expect(parsePeriod([])).toBe("morning");
    expect(parsePeriod(["--dry-run"])).toBe("morning");
    expect(parsePeriod(["noon"])).toBe("morning");
    expect(parsePeriod(["--period", "noon"])).toBe("noon");
    expect(parsePeriod(["--period=night"])).toBe("night");
  });
});

describe("buildBrief", () => {
  it("builds a mobile-friendly brief around schedule and reminders without generic priorities", () => {
    const brief = buildBrief({
      weather: "Warren+NJ: 54F and Sunny",
      schedule: ["9:00 AM - Standup", "1:00 PM - EM-605"],
      reminders: ["Submit quiz", "Call pharmacy"],
      specialists: [],
    });

    expect(brief).toContain("☀️ Brief - Morning Brief");
    expect(brief).toContain("Schedule:");
    expect(brief).toContain("Apple Reminders:");
    expect(brief).toContain("Weather:");
    expect(brief).toContain("News:");
    expect(brief).toContain("Markets:");
    expect(brief).toContain("- 9:00 AM - Standup");
    expect(brief).toContain("- Submit quiz");
    expect(brief).not.toContain("Top 3 priorities");
    expect(brief).not.toContain("career-advancing task");
  });

  it("uses source-linked RSS intel when available", () => {
    const brief = buildBrief({
      weather: "Warren+NJ: 54F and Sunny",
      schedule: ["9:00 AM - Standup"],
      reminders: ["Call pharmacy"],
      specialists: [],
      intel: {
        generatedAt: "2026-05-13T12:00:00.000Z",
        status: "ok",
        errors: [],
        items: [
          {
            title: "Ransomware gang targets hospitals",
            link: "https://example.test/cyber",
            source: "BleepingComputer",
            category: "cyber",
            score: 30,
          },
          {
            title: "Mortgage rates edge lower",
            link: "https://example.test/home",
            source: "HousingWire",
            category: "housing",
            score: 25,
          },
        ],
      },
    });

    expect(brief).toContain("Cyber: Ransomware gang targets hospitals");
    expect(brief).toContain("https://example.test/cyber");
    expect(brief).toContain("Housing: Mortgage rates edge lower");
    expect(brief).not.toContain("News unavailable.");
    expect(brief).not.toContain("Market snapshot unavailable.");
  });

  it("renders a compact night brief with separate news categories", () => {
    const brief = buildBrief({
      period: "night",
      weather: "Warren+NJ: 54F and Sunny",
      schedule: ["9:00 AM - Work"],
      reminders: ["Pack gym bag"],
      specialists: [],
      intel: {
        generatedAt: "2026-05-13T12:00:00.000Z",
        status: "ok",
        errors: [],
        items: [
          { title: "Cyber 1", link: "https://example.test/c1", source: "S", category: "cyber", score: 12 },
          { title: "Cyber 2", link: "https://example.test/c2", source: "S", category: "cyber", score: 11 },
          { title: "Cyber 3", link: "https://example.test/c3", source: "S", category: "cyber", score: 10 },
          { title: "Cyber 4", link: "https://example.test/c4", source: "S", category: "cyber", score: 9 },
          { title: "Cyber 5", link: "https://example.test/c5", source: "S", category: "cyber", score: 8 },
          { title: "Cyber 6", link: "https://example.test/c6", source: "S", category: "cyber", score: 7 },
          { title: "Cyber 7", link: "https://example.test/c7", source: "S", category: "cyber", score: 6 },
          { title: "Cyber 8", link: "https://example.test/c8", source: "S", category: "cyber", score: 5 },
          { title: "Cyber 9", link: "https://example.test/c9", source: "S", category: "cyber", score: 4 },
          { title: "Cyber 10", link: "https://example.test/c10", source: "S", category: "cyber", score: 3 },
          { title: "Cyber 11", link: "https://example.test/c11", source: "S", category: "cyber", score: 2 },
          { title: "Cyber 12", link: "https://example.test/c12", source: "S", category: "cyber", score: 1 },
          { title: "Market 1", link: "https://example.test/m1", source: "S", category: "markets", score: 5 },
        ],
      },
    });

    expect(brief).toContain("🌙 Brief - Night Brief");
    expect(brief).toContain("Cyber:");
    expect(brief).toContain("- Cyber 10");
    expect(brief).not.toContain("- Cyber 1 (S)");
    expect(brief).toContain("Markets:");
    expect(brief).toContain("Market 1");
  });
});

describe("fetchWeatherWithRunCommand", () => {
  it("falls back to Open-Meteo when wttr.in times out", async () => {
    const run = vi
      .fn<(cmd: string, args: string[], timeoutMs?: number) => Promise<string>>()
      .mockRejectedValueOnce(new Error("curl -fsSL https://wttr.in/Warren+NJ?format=j1 timed out after 20000ms"))
      .mockResolvedValueOnce(
        JSON.stringify({
          current_weather: {
            temperature: 61.8,
            windspeed: 4.4,
            weathercode: 1,
          },
          daily: {
            temperature_2m_max: [72.2],
            temperature_2m_min: [55.1],
            precipitation_probability_max: [20],
          },
        }),
      );

    const weather = await fetchWeatherWithRunCommand(run);

    expect(weather).toBe("Partly cloudy, 62F (feels 62F), high 72/low 55, rain 20%, wind 4 mph");
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]).toEqual(["curl", ["-fsSL", "https://wttr.in/Warren+NJ?format=j1"], 20_000]);
    expect(run.mock.calls[1]?.[0]).toBe("curl");
    expect(run.mock.calls[1]?.[1]?.[1]).toContain("api.open-meteo.com/v1/forecast");
  });
});

describe("sessionsSendWithRunCommand", () => {
  it("retries once on the transient active-memory CLI startup race", async () => {
    const run = vi
      .fn<(cmd: string, args: string[], timeoutMs?: number) => Promise<string>>()
      .mockRejectedValueOnce(
        new Error(
          "Command failed: openclaw agent --agent monitor --message test --json --timeout 240\n[openclaw] Failed to start CLI: PluginLoadFailureError: plugin load failed: active-memory: failed to install bundled runtime deps: Error: ENOTEMPTY",
        ),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          result: {
            payloads: [{ text: "- Premarket\n- Watch energy." }],
          },
        }),
      );

    const result = await sessionsSendWithRunCommand(
      {
        sessionKey: "agent:monitor:main",
        agentId: "monitor",
        prompt: "test",
      },
      run,
    );

    expect(result.ok).toBe(true);
    expect(result.text).toBe("- Premarket\n- Watch energy.");
    expect(run).toHaveBeenCalledTimes(2);
  });
});
