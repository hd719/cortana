import { describe, expect, it } from "vitest";

import {
  buildTonalPublicMovementCatalog,
  detectMovementLibraryPageCount,
  inferTonalPplBucket,
  parseTonalMovementLibraryPage,
} from "../../tools/fitness/tonal-public-movement-catalog.ts";

const SAMPLE_HTML = `
  <html>
    <head>
      <link rel="next" href="/blogs/movements?page=2">
      <a href="/blogs/movements?page=11">11</a>
    </head>
    <body>
      <play-tile title="Bench Press">
        <button class="w-full">
          <div aria-label="This exersice movement targets the Upper muscles"></div>
          <h3>Bench Press</h3>
        </button>
      </play-tile>
      <play-tile title="Neutral Lat Pulldown">
        <button class="w-full">
          <div aria-label="This exersice movement targets the Upper muscles"></div>
          <h3>Neutral Lat Pulldown</h3>
        </button>
      </play-tile>
      <play-tile title="Lateral Lunge">
        <button class="w-full">
          <div aria-label="This exersice movement targets the Lower muscles"></div>
          <h3>Lateral Lunge</h3>
        </button>
      </play-tile>
      <play-tile title="The Hundreds">
        <button class="w-full">
          <div aria-label="This exersice movement targets the Core muscles"></div>
          <h3>The Hundreds</h3>
        </button>
      </play-tile>
    </body>
  </html>
`;

describe("fitness tonal public movement catalog", () => {
  it("detects public pagination depth from page links", () => {
    expect(detectMovementLibraryPageCount(SAMPLE_HTML)).toBe(11);
  });

  it("parses public movement cards with title and category", () => {
    const parsed = parseTonalMovementLibraryPage(SAMPLE_HTML, 1);
    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toMatchObject({
      title: "Bench Press",
      publicCategory: "upper",
      publicPage: 1,
    });
    expect(parsed[2]).toMatchObject({
      title: "Lateral Lunge",
      publicCategory: "lower",
    });
  });

  it("infers ppl buckets from mapped muscle groups and fallback heuristics", () => {
    expect(inferTonalPplBucket({
      title: "Bench Press",
      publicCategory: "upper",
      muscleGroup: "chest",
      pattern: "press",
    })).toBe("push");
    expect(inferTonalPplBucket({
      title: "Neutral Lat Pulldown",
      publicCategory: "upper",
      muscleGroup: "lats",
      pattern: "pull_down",
    })).toBe("pull");
    expect(inferTonalPplBucket({
      title: "Lateral Lunge",
      publicCategory: "lower",
      muscleGroup: "unmapped",
      pattern: "other",
    })).toBe("legs");
  });

  it("builds a metric-ready catalog using local mappings and observed movement lookup", () => {
    const observedLookup = new Map([
      ["id:8edc0211-4594-4e5e-8e1b-b05dfc1d67c7", { movementId: "8edc0211-4594-4e5e-8e1b-b05dfc1d67c7", canonicalKey: "bench press", sampleTitle: null }],
      ["lateral lunge", { movementId: "obs-lunge", canonicalKey: "lateral lunge", sampleTitle: "Lateral Lunge" }],
    ]);
    const catalog = buildTonalPublicMovementCatalog({
      pages: [{ page: 1, html: SAMPLE_HTML }],
      observedLookup,
    });

    expect(catalog.summary.publicMovementCount).toBe(4);
    expect(catalog.summary.mappedCount).toBeGreaterThanOrEqual(2);
    expect(catalog.summary.observedCount).toBe(2);
    expect(catalog.summary.metricReadyCount).toBeGreaterThanOrEqual(3);
    expect(catalog.summary.pplCounts.push).toBeGreaterThanOrEqual(1);
    expect(catalog.summary.pplCounts.pull).toBeGreaterThanOrEqual(1);
    expect(catalog.summary.pplCounts.legs).toBeGreaterThanOrEqual(1);

    const benchPress = catalog.movements.find((movement) => movement.title === "Bench Press");
    expect(benchPress?.mapped).toBe(true);
    expect(benchPress?.metricReady).toBe(true);
    expect(benchPress?.pplBucket).toBe("push");
    expect(benchPress?.observedOnMachine).toBe(true);

    const lateralLunge = catalog.movements.find((movement) => movement.title === "Lateral Lunge");
    expect(lateralLunge?.observedOnMachine).toBe(true);
    expect(lateralLunge?.metricReady).toBe(true);
    expect(lateralLunge?.pplBucket).toBe("legs");

    const hundreds = catalog.movements.find((movement) => movement.title === "The Hundreds");
    expect(hundreds?.publicCategory).toBe("core");
    expect(hundreds?.pplBucket).toBe("core");
  });
});
