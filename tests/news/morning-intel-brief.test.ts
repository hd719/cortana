import { describe, expect, it } from "vitest";
import {
  buildMorningIntelSections,
  dedupeAndRank,
  parseFeedXml,
  renderMorningIntelBrief,
  type FeedConfig,
  type IntelBrief,
  type IntelItem,
} from "../../tools/news/morning-intel-brief.ts";

const feed: FeedConfig = {
  name: "Test Feed",
  category: "cyber",
  url: "https://example.test/rss",
};

describe("morning intel RSS parser", () => {
  it("parses RSS items with title, link, and pubDate", () => {
    const items = parseFeedXml(
      `<?xml version="1.0"?>
      <rss><channel>
        <item>
          <title><![CDATA[Zero-day exploit hits routers]]></title>
          <link>https://example.test/a</link>
          <pubDate>Wed, 13 May 2026 10:00:00 GMT</pubDate>
        </item>
      </channel></rss>`,
      feed,
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "Zero-day exploit hits routers",
      link: "https://example.test/a",
      source: "Test Feed",
      category: "cyber",
      publishedAt: "2026-05-13T10:00:00.000Z",
    });
    expect(items[0].score).toBeGreaterThan(10);
  });

  it("parses Atom entries with link href", () => {
    const items = parseFeedXml(
      `<feed>
        <entry>
          <title>Mortgage rates move after Fed comments</title>
          <link href="https://example.test/housing" />
          <updated>2026-05-13T12:00:00Z</updated>
        </entry>
      </feed>`,
      { ...feed, category: "housing" },
    );

    expect(items[0]).toMatchObject({
      title: "Mortgage rates move after Fed comments",
      link: "https://example.test/housing",
      category: "housing",
    });
  });
});

describe("morning intel ranking", () => {
  it("dedupes repeated headlines and caps each category", () => {
    const base = {
      link: "https://example.test",
      source: "Source",
      publishedAt: "2026-05-13T10:00:00.000Z",
    };
    const items: IntelItem[] = [
      { ...base, title: "AI chip earnings surge", category: "tech", score: 30 },
      { ...base, title: "AI chip earnings surge", category: "tech", score: 29 },
      { ...base, title: "Fed rate decision moves markets", category: "markets", score: 40 },
      { ...base, title: "Treasury yields rise", category: "markets", score: 35 },
      { ...base, title: "Oil falls", category: "markets", score: 20 },
    ];

    const ranked = dedupeAndRank(items, 2);

    expect(ranked.map((item) => item.title)).toEqual([
      "Fed rate decision moves markets",
      "Treasury yields rise",
      "AI chip earnings surge",
    ]);
  });
});

describe("morning intel rendering", () => {
  it("splits source-linked items into news and market sections", () => {
    const brief: IntelBrief = {
      generatedAt: "2026-05-13T12:00:00.000Z",
      status: "ok",
      errors: [],
      items: [
        { title: "Ransomware gang targets hospitals", link: "https://example.test/cyber", source: "BleepingComputer", category: "cyber", score: 30 },
        { title: "Mortgage rates edge lower", link: "https://example.test/home", source: "HousingWire", category: "housing", score: 25 },
      ],
    };

    const sections = buildMorningIntelSections(brief);
    expect(sections.news[0]).toContain("Cyber: Ransomware gang targets hospitals");
    expect(sections.news[0]).toContain("https://example.test/cyber");
    expect(sections.markets[0]).toContain("Housing: Mortgage rates edge lower");

    const rendered = renderMorningIntelBrief(brief);
    expect(rendered).toContain("🗞️ Intel - RSS Brief");
    expect(rendered).toContain("Markets / Housing:");
  });
});
