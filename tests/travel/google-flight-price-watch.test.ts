import { describe, expect, it } from "vitest";
import {
  buildSnapshotMessage,
  buildCdpNewTabUrl,
  createRunDeadline,
  extractBestFlightDetails,
  extractFlightNumbersFromGoogleFlightUrl,
  extractRoute,
  extractRoundTripPrices,
  missingGoogleFlightSearches,
  isFlightAlert,
  parseSavedTrackerSnapshots,
  selectGoogleFlightSearchPages,
  shouldSendSnapshot,
} from "../../tools/travel/google-flight-price-watch.ts";

describe("google-flight-price-watch", () => {
  it("matches Rabat/RBA Google Flights alerts", () => {
    expect(
      isFlightAlert(
        "Track prices from Newark to Rabat departing 2026-08-12",
        "Google Flights <googletravel-noreply@google.com>",
        "Flight price alert",
      ),
    ).toBe(true);
  });

  it("does not match Casablanca/CMN alerts after CMN tracking is removed", () => {
    expect(
      isFlightAlert(
        "Track prices from Newark to Casablanca CMN departing 2026-08-12",
        "Google Flights <googletravel-noreply@google.com>",
        "Flight price alert",
      ),
    ).toBe(false);
  });

  it("does not match prior Marrakesh/RAK alerts after switching to Rabat", () => {
    expect(
      isFlightAlert(
        "Track prices from Newark to Marrakesh RAK departing 2026-08-12",
        "Google Flights <googletravel-noreply@google.com>",
        "Flight price alert",
      ),
    ).toBe(false);
  });

  it("summarizes missing destinations as Rabat rather than broad Morocco", () => {
    expect(extractRoute("Google Flights price alert from EWR to RBA")).toBe("EWR -> RBA");
    expect(extractRoute("Google Flights price alert from New York")).toBe("New York -> Rabat");
  });

  it("sends one browser price snapshot per day when Gmail has no alerts", () => {
    const snapshots = [
      {
        route: "New York -> Rabat",
        account: "Google Account: Hamel D (hameldesai3@gmail.com)",
        trackLabel: "Track prices from New York to Rabat departing 2026-08-12 and returning 2026-08-20",
        trackingEnabled: true,
        priceInsight: "Prices are currently high",
        lowestPrice: 7377,
        prices: [7377, 8099],
        bestFlight: "5:00 PM-10:45 AM+1, Air France, Delta, KLM, EWR-RBA, 12 hr 45 min, 1 stop, via 2 hr 30 min CDG, flight # not shown",
        url: "https://www.google.com/travel/flights",
      },
    ];

    expect(shouldSendSnapshot({ version: 1, sentMessageIds: [] }, "2026-05-07", snapshots)).toBe(true);
    expect(
      shouldSendSnapshot(
        { version: 1, sentMessageIds: [], lastSnapshotDate: "2026-05-07", lastSnapshotPrices: { "New York -> Rabat": 7377 } },
        "2026-05-07",
        snapshots,
      ),
    ).toBe(false);
  });

  it("can send every browser snapshot when continuous monitoring is enabled", () => {
    const snapshots = [
      {
        route: "New York -> Rabat",
        account: "Google Account: Hamel D (hameldesai3@gmail.com)",
        trackLabel: "Track prices from New York to Rabat departing 2026-08-12 and returning 2026-08-20",
        trackingEnabled: true,
        priceInsight: "Prices are currently typical",
        lowestPrice: 7377,
        prices: [7377],
        bestFlight: "5:00 PM-10:45 AM+1, Air France, Delta, KLM, JFK-RBA, 12 hr 45 min, 1 stop, via 2 hr 30 min CDG, flight # not shown",
        url: "https://www.google.com/travel/flights",
      },
    ];

    expect(
      shouldSendSnapshot(
        { version: 1, sentMessageIds: [], lastSnapshotDate: "2026-05-07", lastSnapshotPrices: { "New York -> Rabat": 7377 } },
        "2026-05-07",
        snapshots,
        { alwaysSend: true },
      ),
    ).toBe(true);
  });

  it("sends another same-day snapshot on a material price drop", () => {
    const snapshots = [
      {
        route: "Newark -> Rabat",
        account: "Google Account: Hamel D (hameldesai3@gmail.com)",
        trackLabel: "Track prices from Newark to Rabat departing 2026-08-12 and returning 2026-08-20",
        trackingEnabled: true,
        priceInsight: "Prices are currently typical",
        lowestPrice: 6200,
        prices: [6200],
        bestFlight: "5:00 PM-10:45 AM+1, Air France, Delta, KLM, EWR-RBA, 12 hr 45 min, 1 stop, via 2 hr 30 min CDG, flight # not shown",
        url: "https://www.google.com/travel/flights",
      },
    ];

    expect(
      shouldSendSnapshot(
        { version: 1, sentMessageIds: [], lastSnapshotDate: "2026-05-07", lastSnapshotPrices: { "Newark -> Rabat": 6700 } },
        "2026-05-07",
        snapshots,
      ),
    ).toBe(true);
  });

  it("sends a same-day snapshot when a route is newly tracked", () => {
    const snapshots = [
      {
        route: "Newark -> Rabat",
        account: "Google Account: Hamel D (hameldesai3@gmail.com)",
        trackLabel: "Track prices from Newark to Rabat departing 2026-08-12 and returning 2026-08-20",
        trackingEnabled: true,
        priceInsight: "Prices are currently high",
        lowestPrice: 8666,
        prices: [8666],
        bestFlight: "5:00 PM-10:45 AM+1, Air France, Delta, KLM, EWR-RBA, 12 hr 45 min, 1 stop, via 2 hr 30 min CDG, flight # not shown",
        url: "https://www.google.com/travel/flights",
      },
    ];

    expect(
      shouldSendSnapshot(
        { version: 1, sentMessageIds: [], lastSnapshotDate: "2026-05-08", lastSnapshotPrices: { "Newark -> Marrakesh": 8666 } },
        "2026-05-08",
        snapshots,
      ),
    ).toBe(true);
  });

  it("builds a non-actionable live browser snapshot message", () => {
    const message = buildSnapshotMessage([
      {
        route: "New York -> Rabat | Aug 5-17",
        account: "Google Account: Hamel D (hameldesai3@gmail.com)",
        trackLabel: "Track prices from New York to Rabat departing 2026-08-12 and returning 2026-08-20",
        trackingEnabled: true,
        priceInsight: "Prices are currently high",
        lowestPrice: 7377,
        bestPrice: 8099,
        prices: [7377],
        bestFlight: "5:00 PM-10:45 AM+1, Air France, Delta, KLM, JFK-RBA, 12 hr 45 min, 1 stop, via 2 hr 30 min CDG, flight AF11/AF1458",
        url: "https://www.google.com/travel/flights",
      },
    ]);

    expect(message).toContain("saved tracker snapshot");
    expect(message).toContain("Cheapest comes from saved tracker; best/flight comes from search tabs.");
    expect(message).toContain("Aug 5 (Wed) - Aug 17 (Mon) - 2 Biz Seats\nJFK");
    expect(message).toContain("Cheapest: $7,377");
    expect(message).toContain("Best: $8,099");
    expect(message).toContain("Flight: Air France/Delta/KLM (5:00 PM -> 10:45 AM+1), 1 stop via CDG");
    expect(message).toContain("AF11/AF1458");
    expect(message).not.toContain("enable Google Flights");
  });

  it("keeps all configured date-window route lines in the compact snapshot", () => {
    const snapshots = [
      ["New York -> Rabat | Aug 5-17", 10844, "JFK-RBA"],
      ["Newark -> Rabat | Aug 5-17", 10870, "EWR-RBA"],
      ["New York -> Rabat | Aug 6-17", 11343, "JFK-RBA"],
      ["Newark -> Rabat | Aug 6-17", 11372, "EWR-RBA"],
      ["New York -> Rabat | Aug 7-17", 11104, "JFK-RBA"],
      ["Newark -> Rabat | Aug 7-17", 11130, "EWR-RBA"],
    ].map(([route, lowestPrice, airportPair]) => ({
      route: String(route),
      account: "Google Account: Hamel D (hameldesai3@gmail.com)",
      trackLabel: "Track prices",
      trackingEnabled: true,
      priceInsight: "Prices are currently typical",
      lowestPrice: Number(lowestPrice),
      bestPrice: Number(lowestPrice) + 800,
      prices: [Number(lowestPrice)],
      bestFlight: `5:00 PM-10:45 AM+1, Air France, Delta, KLM, ${airportPair}, 12 hr 45 min, 1 stop, via 2 hr 30 min CDG, flight # not shown`,
      url: "https://www.google.com/travel/flights",
    }));

    const message = buildSnapshotMessage(snapshots);

    expect(message).toContain("Aug 5 (Wed) - Aug 17 (Mon) - 2 Biz Seats\nEWR");
    expect(message).toContain("Aug 6 (Thu) - Aug 17 (Mon) - 2 Biz Seats\nEWR");
    expect(message).toContain("Aug 7 (Fri) - Aug 17 (Mon) - 2 Biz Seats\nEWR");
    expect(message).toContain("Cheapest: $10,844");
    expect(message).toContain("Best: $11,644");
    expect(message).toContain("\n\nAug 6 (Thu) - Aug 17 (Mon) - 2 Biz Seats\nEWR\nCheapest: $11,372\nBest: $12,172");
    expect(message.indexOf("EWR\nCheapest: $10,870")).toBeLessThan(message.indexOf("JFK\nCheapest: $10,844"));
    expect(message).toContain("\n\nVerdict: Watch only; still expensive.");
    expect(message).toContain("Air France/Delta/KLM");
  });

  it("parses saved tracker prices as the snapshot source of truth", () => {
    const snapshots = parseSavedTrackerSnapshots([
      "Tracked prices",
      "From Newark",
      "Rabat",
      "Wed, Aug 5 – Mon, Aug 17",
      "Cheapest flight",
      "$10,872",
      "Round trip",
      "Business Class",
      "2",
      "$10,870",
      "Thu, Aug 6 – Mon, Aug 17",
      "Cheapest flight",
      "$11,372",
      "Round trip",
      "Business Class",
      "2",
      "$12,172",
      "Fri, Aug 7 – Mon, Aug 17",
      "Cheapest flight",
      "$11,372",
      "Round trip",
      "Business Class",
      "2",
      "$11,130",
      "From New York",
      "Rabat",
      "Wed, Aug 5 – Mon, Aug 17",
      "Cheapest flight",
      "$10,843",
      "Round trip",
      "Business Class",
      "2",
      "$10,844",
      "Thu, Aug 6 – Mon, Aug 17",
      "Cheapest flight",
      "$11,343",
      "Round trip",
      "Business Class",
      "2",
      "$12,145",
      "Fri, Aug 7 – Mon, Aug 17",
      "Cheapest flight",
      "$11,343",
      "Round trip",
      "Business Class",
      "2",
      "$11,104",
    ].join("\n"));

    expect(snapshots.map((snapshot) => [snapshot.route, snapshot.lowestPrice])).toEqual([
      ["New York -> Rabat | Aug 5-17", 10843],
      ["Newark -> Rabat | Aug 5-17", 10872],
      ["New York -> Rabat | Aug 6-17", 11343],
      ["Newark -> Rabat | Aug 6-17", 11372],
      ["New York -> Rabat | Aug 7-17", 11343],
      ["Newark -> Rabat | Aug 7-17", 11372],
    ]);
  });

  it("extracts top flight airline and connection details from Google Flights text", () => {
    expect(
      extractBestFlightDetails(
        [
          "Departing flights",
          "Sorted by top flights",
          "5:00 PM",
          " – ",
          "10:45 AM+1",
          "Air FranceDelta, KLM",
          "12 hr 45 min",
          "EWR–RBA",
          "1 stop",
          "2 hr 30 min CDG",
          "3,234 kg CO2e",
          "+6% emissions",
          "$10,604",
          "round trip",
        ].join("\n"),
      ),
    ).toBe("5:00 PM-10:45 AM+1, Air France, Delta, KLM, EWR–RBA, 12 hr 45 min, 1 stop, via 2 hr 30 min CDG, flight # not shown");
  });

  it("extracts selected-flight numbers from Google Flights tfs URLs", () => {
    const url =
      "https://www.google.com/travel/flights/search?tfs=CBwQAhpgEgoyMDI2LTA4LTA1Ih4KA0pGSxIKMjAyNi0wOC0wNRoDQ0RHKgJBRjICMTEiIAoDQ0RHEgoyMDI2LTA4LTA1GgNSQkEqAkFGMgQxNDU4agcIARIDSkZLcgcIARIDUkJBGh4SCjIwMjYtMDgtMTdqBwgBEgNSQkFyBwgBEgNKRktAAUABSANwAYIBCwj___________8BmAEB";

    expect(extractFlightNumbersFromGoogleFlightUrl(url)).toEqual(["AF11", "AF1458"]);
  });

  it("ignores adjacent-date suggestion prices in browser snapshots", () => {
    const text =
      "Travel Aug 9 - 19 for $6,422 Change dates Top departing flights " +
      "12:50 PM Turkish Airlines $7,377 round trip Other departing flights $8,099 round trip";

    expect(extractRoundTripPrices(text)).toEqual([7377, 8099]);
  });

  it("identifies missing canonical Google Flights search tabs", () => {
    const missing = missingGoogleFlightSearches([
      {
        type: "page",
        title: "New York to Rabat | Google Flights",
        url: "https://www.google.com/travel/flights?q=Flights%20from%20JFK%20to%20RBA%20August%205%202026%20to%20August%2017%202026%20business%20class%202%20adults",
      },
    ]);

    expect(missing.map((search) => search.route)).toEqual([
      "Newark -> Rabat | Aug 5-17",
      "New York -> Rabat | Aug 6-17",
      "Newark -> Rabat | Aug 6-17",
      "New York -> Rabat | Aug 7-17",
      "Newark -> Rabat | Aug 7-17",
    ]);
  });

  it("does not reopen tabs when both canonical searches are already present", () => {
    const missing = missingGoogleFlightSearches([
      {
        type: "page",
        title: "New York to Rabat | Google Flights",
        url: "https://www.google.com/travel/flights?q=Flights%20from%20JFK%20to%20RBA%20August%205%202026%20to%20August%2017%202026%20business%20class%202%20adults",
      },
      {
        type: "page",
        title: "Newark to Rabat | Google Flights",
        url: "https://www.google.com/travel/flights?q=Flights%20from%20EWR%20to%20RBA%20August%205%202026%20to%20August%2017%202026%20business%20class%202%20adults",
      },
      {
        type: "page",
        title: "New York to Rabat | Google Flights",
        url: "https://www.google.com/travel/flights?q=Flights%20from%20JFK%20to%20RBA%20August%206%202026%20to%20August%2017%202026%20business%20class%202%20adults",
      },
      {
        type: "page",
        title: "Newark to Rabat | Google Flights",
        url: "https://www.google.com/travel/flights?q=Flights%20from%20EWR%20to%20RBA%20August%206%202026%20to%20August%2017%202026%20business%20class%202%20adults",
      },
      {
        type: "page",
        title: "New York to Rabat | Google Flights",
        url: "https://www.google.com/travel/flights?q=Flights%20from%20JFK%20to%20RBA%20August%207%202026%20to%20August%2017%202026%20business%20class%202%20adults",
      },
      {
        type: "page",
        title: "Newark to Rabat | Google Flights",
        url: "https://www.google.com/travel/flights?q=Flights%20from%20EWR%20to%20RBA%20August%207%202026%20to%20August%2017%202026%20business%20class%202%20adults",
      },
    ]);

    expect(missing).toEqual([]);
  });

  it("supports alternate search configs without changing matching logic", () => {
    const missing = missingGoogleFlightSearches(
      [
        {
          type: "page",
          title: "Boston to Rabat | Google Flights",
          url: "https://www.google.com/travel/flights?q=Flights%20from%20BOS%20to%20RBA%20August%2012%202026",
        },
      ],
      [
        {
          route: "Boston -> Rabat",
          url: "https://www.google.com/travel/flights?q=Flights%20from%20BOS%20to%20RBA%20August%2012%202026",
          urlNeedle: "Flights%20from%20BOS%20to%20RBA%20August%2012%202026",
        },
        {
          route: "Philadelphia -> Rabat",
          url: "https://www.google.com/travel/flights?q=Flights%20from%20PHL%20to%20RBA%20August%2012%202026",
          urlNeedle: "Flights%20from%20PHL%20to%20RBA%20August%2012%202026",
        },
      ],
    );

    expect(missing.map((search) => search.route)).toEqual(["Philadelphia -> Rabat"]);
  });

  it("builds the Chrome DevTools new-tab URL for a missing search", () => {
    expect(
      buildCdpNewTabUrl(
        "http://127.0.0.1:18792/json",
        "https://www.google.com/travel/flights?q=Flights from JFK to RBA",
      ),
    ).toBe(
      "http://127.0.0.1:18792/json/new?https%3A%2F%2Fwww.google.com%2Ftravel%2Fflights%3Fq%3DFlights%20from%20JFK%20to%20RBA",
    );
  });

  it("prefers loaded Google Flights tabs over generic duplicate tabs", () => {
    const search = {
      route: "New York -> Rabat | Aug 5-17",
      url: "https://www.google.com/travel/flights?q=Flights%20from%20JFK%20to%20RBA%20August%205%202026%20to%20August%2017%202026%20business%20class%202%20adults",
      urlNeedle: "Flights%20from%20JFK%20to%20RBA%20August%205%202026%20to%20August%2017%202026%20business%20class%202%20adults",
    };

    const pages = selectGoogleFlightSearchPages(
      [
        {
          id: "generic",
          type: "page",
          title: "Find Cheap Flights Worldwide & Book Your Ticket - Google Flights",
          url: search.url,
          webSocketDebuggerUrl: "ws://generic",
        },
        {
          id: "loaded",
          type: "page",
          title: "New York to Rabat | Google Flights",
          url: search.url,
          webSocketDebuggerUrl: "ws://loaded",
        },
      ],
      search,
    );

    expect(pages.map((page) => page.id)).toEqual(["loaded", "generic"]);
  });

  it("shares one browser deadline across optional work", () => {
    let now = 1_000;
    const deadline = createRunDeadline(30_000, () => now);

    now = 10_000;
    expect(deadline.remainingMs()).toBe(21_000);
    expect(deadline.budgetMs(10_000, 1_000)).toBe(10_000);

    now = 30_000;
    expect(deadline.budgetMs(10_000, 1_000)).toBe(1_000);

    now = 31_001;
    expect(deadline.expired()).toBe(true);
    expect(deadline.budgetMs(10_000, 1_000)).toBe(0);
  });
});
