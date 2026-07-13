import { describe, it, expect } from "vitest";
import {
  normalizeMapsQuery,
  googleMapsSearchUrl,
  appleMapsSearchUrl,
  geoUri,
  mapsLinks,
  primaryMapsHref,
} from "../maps-link";

describe("normalizeMapsQuery", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeMapsQuery("  120 Elm   St,  Springfield ")).toBe(
      "120 Elm St, Springfield"
    );
  });
  it("returns null for blank / missing", () => {
    expect(normalizeMapsQuery("")).toBeNull();
    expect(normalizeMapsQuery("   ")).toBeNull();
    expect(normalizeMapsQuery(null)).toBeNull();
    expect(normalizeMapsQuery(undefined)).toBeNull();
  });
});

describe("url builders encode the address", () => {
  const addr = "120 Elm St, Springfield";
  it("google uses api=1 search with an encoded query", () => {
    expect(googleMapsSearchUrl(addr)).toBe(
      "https://www.google.com/maps/search/?api=1&query=120%20Elm%20St%2C%20Springfield"
    );
  });
  it("apple uses the q param", () => {
    expect(appleMapsSearchUrl(addr)).toBe(
      "https://maps.apple.com/?q=120%20Elm%20St%2C%20Springfield"
    );
  });
  it("geo uses a 0,0 anchor with a q query", () => {
    expect(geoUri(addr)).toBe("geo:0,0?q=120%20Elm%20St%2C%20Springfield");
  });
  it("escapes ampersands and other query-breaking characters", () => {
    expect(googleMapsSearchUrl("A & B Clinic")).toBe(
      "https://www.google.com/maps/search/?api=1&query=A%20%26%20B%20Clinic"
    );
  });
});

describe("mapsLinks", () => {
  it("returns google first, then apple, then geo", () => {
    const links = mapsLinks("120 Elm St");
    expect(links.map((l) => l.provider)).toEqual(["google", "apple", "geo"]);
    expect(links[0].href).toBe(googleMapsSearchUrl("120 Elm St"));
  });
  it("returns [] for a blank address (nothing to link)", () => {
    expect(mapsLinks("")).toEqual([]);
    expect(mapsLinks(null)).toEqual([]);
  });
});

describe("primaryMapsHref", () => {
  it("is the google url for a real address", () => {
    expect(primaryMapsHref(" Northside Clinic ")).toBe(
      googleMapsSearchUrl("Northside Clinic")
    );
  });
  it("is null for a blank address", () => {
    expect(primaryMapsHref("  ")).toBeNull();
    expect(primaryMapsHref(null)).toBeNull();
  });
});
