import { describe, it, expect } from "vitest";
import {
  DEFAULT_TRENDS_TAB,
  TRENDS_TABS,
  parseTab,
  retiredFitnessTabTarget,
  trendsTabStrip,
} from "@/lib/trends-tabs";

// #1489: Compare retires into Insights (as a section of the hub's "derived views"
// tab) — a vocabulary mapping, not a redirect, which is what keeps every old
// `?tab=compare` deep link alive.
//
// #1644 retires **Body** into the Overview landing surface and takes the opposite
// route on purpose: `?tab=body` and the older `?tab=vitals` get NO alias, because
// the surface they name IS the default view — the ordinary unknown-value fallback
// already lands them on the page that renders the body census. A mapping there
// would be a shim for a link that already works (#1635).

describe("parseTab", () => {
  it("lands the retired ?tab=body and ?tab=vitals on the default view (#1644)", () => {
    for (const retired of ["body", "vitals", " body ", "VITALS"]) {
      expect(parseTab(retired)).toBe(DEFAULT_TRENDS_TAB);
    }
    expect(parseTab(["body"])).toBe(DEFAULT_TRENDS_TAB);
    // …and that default is the surface those links wanted: the merged landing view.
    expect(DEFAULT_TRENDS_TAB).toBe("overview");
  });

  it("maps the retired ?tab=compare onto insights (#1489)", () => {
    expect(parseTab("compare")).toBe("insights");
    expect(parseTab(["compare"])).toBe("insights");
    expect(parseTab(" compare ")).toBe("insights");
  });

  it("resolves every live tab to itself", () => {
    for (const tab of TRENDS_TABS) expect(parseTab(tab)).toBe(tab);
  });

  it("falls back to the default for an unknown, empty, or missing value", () => {
    expect(parseTab(undefined)).toBe(DEFAULT_TRENDS_TAB);
    expect(parseTab("")).toBe(DEFAULT_TRENDS_TAB);
    expect(parseTab("   ")).toBe(DEFAULT_TRENDS_TAB);
    expect(parseTab("biomarkers")).toBe(DEFAULT_TRENDS_TAB);
  });

  it("takes the FIRST value of a repeated param", () => {
    expect(parseTab(["compare", "nutrition"])).toBe("insights");
  });
});

describe("trendsTabStrip", () => {
  it("is three tabs after Fitness retires into Training → Analyze (#3512)", () => {
    const strip = trendsTabStrip();
    expect(strip.map((t) => t.id)).toEqual([
      "overview",
      "nutrition",
      "insights",
    ]);
    // No retired tab is a chip any more — Vitals (#1486) and Compare (#1489)
    // merged into others, and Body (#1644) merged into the landing surface the
    // Overview chip already selects.
    for (const gone of ["Vitals", "Compare", "Body", "Fitness"]) {
      expect(strip.map((t) => t.label)).not.toContain(gone);
    }
  });

  it("labels every entry from the live tab set", () => {
    for (const entry of trendsTabStrip()) {
      expect(TRENDS_TABS).toContain(entry.id);
      expect(entry.label).toBeTruthy();
    }
  });
});

describe("the retired Fitness aliases (#3512)", () => {
  it("redirects the full `?tab=fitness&ftab=…` vocabulary to Analyze", () => {
    for (const ftab of ["strength", "cardio", "sport"]) {
      expect(retiredFitnessTabTarget("fitness", ftab)).toBe(
        "/training?tab=analyze"
      );
    }
  });

  it("redirects a recognized nested alias when the outer tab names nothing", () => {
    expect(retiredFitnessTabTarget(undefined, "cardio")).toBe(
      "/training?tab=analyze"
    );
    expect(retiredFitnessTabTarget("", "sport")).toBe("/training?tab=analyze");
    expect(retiredFitnessTabTarget("biomarkers", "strength")).toBe(
      "/training?tab=analyze"
    );
  });

  it("never lets a nested value override a LIVE tab", () => {
    expect(retiredFitnessTabTarget("nutrition", "cardio")).toBeNull();
    expect(retiredFitnessTabTarget("insights", "strength")).toBeNull();
    expect(retiredFitnessTabTarget("compare", "cardio")).toBeNull();
  });

  it("ignores an unknown nested value", () => {
    expect(retiredFitnessTabTarget(undefined, "mobility")).toBeNull();
    expect(retiredFitnessTabTarget(undefined, "")).toBeNull();
    expect(retiredFitnessTabTarget(undefined, undefined)).toBeNull();
  });

  it("takes the FIRST value of a repeated nested param", () => {
    expect(retiredFitnessTabTarget(undefined, ["sport", "nonsense"])).toBe(
      "/training?tab=analyze"
    );
  });
});
