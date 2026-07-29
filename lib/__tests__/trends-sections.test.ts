import { describe, expect, it } from "vitest";
import {
  RESTRICTED_TRENDS_SECTIONS,
  TRENDS_SECTIONS,
  isSectionRestricted,
  trendsSectionHref,
  trendsSectionStrip,
} from "@/lib/trends-sections";

// The section vocabulary that replaced the Trends tab strip (#1644). Successor to
// lib/__tests__/trends-tabs.test.ts: there is no `?tab=` parser to test any more
// (the param died with the strip, no shim — #1635), so what is pinned here is the
// strip's composition, its ONE age gate, and the anchor every retired `?tab=` link
// was rewritten to.

describe("trendsSectionStrip", () => {
  it("is five sections in reading order — the head, then the three censuses, then insights", () => {
    const strip = trendsSectionStrip(false);
    expect(strip).toHaveLength(5);
    expect(strip.map((s) => s.id)).toEqual([
      "starred",
      "body",
      "fitness",
      "nutrition",
      "insights",
    ]);
    // "Overview" was the TAB whose two halves are now the page head (digest +
    // starred grid); no chip carries that name any more.
    expect(strip.map((s) => s.label)).not.toContain("Overview");
  });

  it("keeps Insights for a restricted profile, dropping only Fitness", () => {
    const strip = trendsSectionStrip(true);
    expect(strip.map((s) => s.id)).toEqual([
      "starred",
      "body",
      "nutrition",
      "insights",
    ]);
    // Insights survives because compare — its age-NEUTRAL half — lives there; the
    // gated AI half is hidden inside the section, not by the strip.
    expect(strip.map((s) => s.id)).toContain("insights");
    // Body is NEVER age-gated: it carries the growth charts a minor needs.
    expect(strip.map((s) => s.id)).toContain("body");
    expect(strip.map((s) => s.id)).not.toContain("fitness");
  });

  it("labels every entry from the live section set, for both roles", () => {
    for (const restricted of [false, true]) {
      for (const entry of trendsSectionStrip(restricted)) {
        expect(TRENDS_SECTIONS).toContain(entry.id);
        expect(entry.label).toBeTruthy();
      }
    }
  });
});

describe("isSectionRestricted", () => {
  it("only restricts fitness — insights stays section-gated", () => {
    expect(isSectionRestricted("fitness", true)).toBe(true);
    expect(isSectionRestricted("insights", true)).toBe(false);
    expect(isSectionRestricted("body", true)).toBe(false);
    expect(isSectionRestricted("starred", true)).toBe(false);
    expect(isSectionRestricted("fitness", false)).toBe(false);
  });

  it("agrees with the strip for every section", () => {
    for (const restricted of [false, true]) {
      const visible = new Set(
        trendsSectionStrip(restricted).map((s) => s.id)
      );
      for (const id of TRENDS_SECTIONS) {
        expect(visible.has(id)).toBe(!isSectionRestricted(id, restricted));
      }
    }
  });

  it("declares its restricted set from the live section ids", () => {
    for (const id of RESTRICTED_TRENDS_SECTIONS) {
      expect(TRENDS_SECTIONS).toContain(id);
    }
  });
});

describe("trendsSectionHref", () => {
  it("is a pure anchor into the one hub page — no ?tab= survives (#1635)", () => {
    for (const id of TRENDS_SECTIONS) {
      const href = trendsSectionHref(id);
      expect(href).toBe(`/trends#${id}`);
      expect(href).not.toContain("tab=");
    }
  });

  it("names the anchor the page renders for each section", () => {
    expect(trendsSectionHref("body")).toBe("/trends#body");
    expect(trendsSectionHref("starred")).toBe("/trends#starred");
    expect(trendsSectionHref("insights")).toBe("/trends#insights");
  });
});
