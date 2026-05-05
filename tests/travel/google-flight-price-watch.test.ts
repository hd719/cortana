import { describe, expect, it } from "vitest";
import {
  extractRoute,
  isFlightAlert,
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
});
