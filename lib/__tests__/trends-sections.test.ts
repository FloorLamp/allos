import { describe, expect, it } from "vitest";
import {
  TRENDS_LANDING_SECTIONS,
  trendsSectionHref,
} from "@/lib/trends-sections";
import { TRENDS_TABS, parseTab } from "@/lib/trends-tabs";

// The Trends landing surface's anchored parts (#1644, #1632): the starred grid,
// the wellness lens, and the body census that merged onto it. Small on purpose —
// this registry answers
// "where does a deep link land", while lib/trends-tabs.ts answers "which tabs
// exist"; the tests below pin that the two vocabularies stay separate.

describe("the landing surface's parts", () => {
  it("is the grid, the wellness lens, then the census, in reading order", () => {
    // The order IS the design: what you curated, then the small conditional lens
    // (#1632), then the domain census that deliberately reads last.
    expect([...TRENDS_LANDING_SECTIONS]).toEqual([
      "starred",
      "practices",
      "body",
    ]);
  });

  it("names no tab — the strip is a different vocabulary", () => {
    for (const id of TRENDS_LANDING_SECTIONS) {
      expect(TRENDS_TABS).not.toContain(id);
    }
  });
});

describe("trendsSectionHref", () => {
  it("is a pure anchor on the default view — no ?tab= survives (#1635)", () => {
    for (const id of TRENDS_LANDING_SECTIONS) {
      const href = trendsSectionHref(id);
      expect(href).toBe(`/trends#${id}`);
      expect(href).not.toContain("tab=");
    }
  });

  it("names the anchors the landing surface renders", () => {
    expect(trendsSectionHref("body")).toBe("/trends#body");
    expect(trendsSectionHref("starred")).toBe("/trends#starred");
    expect(trendsSectionHref("practices")).toBe("/trends#practices");
  });

  // The half of the retirement a link sweep can't see: a body deep link now says
  // "the default view, at this anchor", and the retired `?tab=body` that used to
  // carry it resolves to that same default view without a shim.
  it("lands on the same view a retired ?tab=body resolves to", () => {
    expect(trendsSectionHref("body").startsWith("/trends#")).toBe(true);
    expect(parseTab("body")).toBe("overview");
    expect(parseTab("vitals")).toBe("overview");
  });
});
