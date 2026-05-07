import { describe, expect, it } from "vitest";
import {
  buildSnapshotMessage,
  buildCdpNewTabUrl,
  extractRoute,
  extractRoundTripPrices,
  missingGoogleFlightSearches,
  isFlightAlert,
  shouldSendSnapshot,
} from "../../tools/travel/google-flight-price-watch.ts";

describe("google-flight-price-watch", () => {
  it("matches Marrakesh/RAK Google Flights alerts", () => {
    expect(
      isFlightAlert(
        "Track prices from Newark to Marrakesh departing 2026-08-12",
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

  it("summarizes unknown destinations as Marrakesh rather than broad Morocco", () => {
    expect(extractRoute("Google Flights price alert from EWR to RAK")).toBe("EWR -> RAK");
    expect(extractRoute("Google Flights price alert from New York")).toBe("New York -> Marrakesh");
  });

  it("sends one browser price snapshot per day when Gmail has no alerts", () => {
    const snapshots = [
      {
        route: "New York -> Marrakesh",
        account: "Google Account: Hamel D (hameldesai3@gmail.com)",
        trackLabel: "Track prices from New York to Marrakesh departing 2026-08-12 and returning 2026-08-20",
        trackingEnabled: true,
        priceInsight: "Prices are currently high",
        lowestPrice: 7377,
        prices: [7377, 8099],
        url: "https://www.google.com/travel/flights",
      },
    ];

    expect(shouldSendSnapshot({ version: 1, sentMessageIds: [] }, "2026-05-07", snapshots)).toBe(true);
    expect(
      shouldSendSnapshot(
        { version: 1, sentMessageIds: [], lastSnapshotDate: "2026-05-07", lastSnapshotPrices: { "New York -> Marrakesh": 7377 } },
        "2026-05-07",
        snapshots,
      ),
    ).toBe(false);
  });

  it("sends another same-day snapshot on a material price drop", () => {
    const snapshots = [
      {
        route: "Newark -> Marrakesh",
        account: "Google Account: Hamel D (hameldesai3@gmail.com)",
        trackLabel: "Track prices from Newark to Marrakesh departing 2026-08-12 and returning 2026-08-20",
        trackingEnabled: true,
        priceInsight: "Prices are currently typical",
        lowestPrice: 6200,
        prices: [6200],
        url: "https://www.google.com/travel/flights",
      },
    ];

    expect(
      shouldSendSnapshot(
        { version: 1, sentMessageIds: [], lastSnapshotDate: "2026-05-07", lastSnapshotPrices: { "Newark -> Marrakesh": 6700 } },
        "2026-05-07",
        snapshots,
      ),
    ).toBe(true);
  });

  it("builds a non-actionable live browser snapshot message", () => {
    const message = buildSnapshotMessage([
      {
        route: "New York -> Marrakesh",
        account: "Google Account: Hamel D (hameldesai3@gmail.com)",
        trackLabel: "Track prices from New York to Marrakesh departing 2026-08-12 and returning 2026-08-20",
        trackingEnabled: true,
        priceInsight: "Prices are currently high",
        lowestPrice: 7377,
        prices: [7377],
        url: "https://www.google.com/travel/flights",
      },
    ]);

    expect(message).toContain("price snapshot");
    expect(message).toContain("Google has not emailed yet; live browser check is working.");
    expect(message).toContain("New York -> Marrakesh: $7,377");
    expect(message).not.toContain("enable Google Flights");
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
        title: "New York to Marrakesh | Google Flights",
        url: "https://www.google.com/travel/flights?q=Flights%20from%20JFK%20to%20RAK%20August%2012%202026%20to%20August%2020%202026%20business%20class%202%20adults",
      },
    ]);

    expect(missing.map((search) => search.route)).toEqual(["Newark -> Marrakesh"]);
  });

  it("does not reopen tabs when both canonical searches are already present", () => {
    const missing = missingGoogleFlightSearches([
      {
        type: "page",
        title: "New York to Marrakesh | Google Flights",
        url: "https://www.google.com/travel/flights?q=Flights%20from%20JFK%20to%20RAK%20August%2012%202026%20to%20August%2020%202026%20business%20class%202%20adults",
      },
      {
        type: "page",
        title: "Newark to Marrakesh | Google Flights",
        url: "https://www.google.com/travel/flights?q=Flights%20from%20EWR%20to%20RAK%20August%2012%202026%20to%20August%2020%202026%20business%20class%202%20adults",
      },
    ]);

    expect(missing).toEqual([]);
  });

  it("builds the Chrome DevTools new-tab URL for a missing search", () => {
    expect(
      buildCdpNewTabUrl(
        "http://127.0.0.1:18792/json",
        "https://www.google.com/travel/flights?q=Flights from JFK to RAK",
      ),
    ).toBe(
      "http://127.0.0.1:18792/json/new?https%3A%2F%2Fwww.google.com%2Ftravel%2Fflights%3Fq%3DFlights%20from%20JFK%20to%20RAK",
    );
  });
});
