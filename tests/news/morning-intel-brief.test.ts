import { describe, expect, it } from "vitest";
import {
  buildMorningIntelCategorySections,
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

  it("decodes common XML entities in titles", () => {
    const items = parseFeedXml(
      `<rss><channel><item><title>Cisco&apos;s AI orders &amp; guidance</title><link>https://example.test/a</link></item></channel></rss>`,
      feed,
    );

    expect(items[0].title).toBe("Cisco's AI orders & guidance");
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

  it("renders top three items per category for night brief sections", () => {
    const items: IntelItem[] = [
      { title: "Cyber 1", link: "https://example.test/c1", source: "S", category: "cyber", score: 5 },
      { title: "Cyber 2", link: "https://example.test/c2", source: "S", category: "cyber", score: 4 },
      { title: "Cyber 3", link: "https://example.test/c3", source: "S", category: "cyber", score: 3 },
      { title: "Cyber 4", link: "https://example.test/c4", source: "S", category: "cyber", score: 2 },
      { title: "Tech 1", link: "https://example.test/t1", source: "S", category: "tech", score: 5 },
    ];

    const sections = buildMorningIntelCategorySections(
      {
        generatedAt: "2026-05-13T12:00:00.000Z",
        status: "ok",
        errors: [],
        items,
      },
      3,
    );

    expect(sections.cyber).toHaveLength(3);
    expect(sections.cyber.join("\n")).not.toContain("Cyber 4");
    expect(sections.tech[0]).toContain("Tech 1");
    expect(sections.finance[0]).toBe("Finance unavailable.");
  });

  it("can offset category sections so later briefs repeat fewer headlines", () => {
    const items: IntelItem[] = Array.from({ length: 6 }, (_, index) => ({
      title: `Cyber ${index + 1}`,
      link: `https://example.test/c${index + 1}`,
      source: "S",
      category: "cyber",
      score: 10 - index,
    }));

    const sections = buildMorningIntelCategorySections(
      {
        generatedAt: "2026-05-13T12:00:00.000Z",
        status: "ok",
        errors: [],
        items,
      },
      3,
      { offsetPerCategory: 3 },
    );

    expect(sections.cyber.join("\n")).toContain("Cyber 4");
    expect(sections.cyber.join("\n")).not.toContain("Cyber 1");
  });
});
