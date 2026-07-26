import { describe, it, expect } from "vitest";
import {
  DEFAULT_TRENDS_TAB,
  TRENDS_TABS,
  isTabRestricted,
  parseTab,
  trendsTabStrip,
} from "@/lib/trends-tabs";

// #1486: the Vitals tab retires into Body (vitals section first). The vocabulary
// mapping — not a redirect — is what keeps every old `?tab=vitals` deep link alive.

describe("parseTab", () => {
  it("maps the retired ?tab=vitals onto body", () => {
    expect(parseTab("vitals")).toBe("body");
    expect(parseTab(["vitals"])).toBe("body");
    expect(parseTab(" vitals ")).toBe("body");
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
    expect(parseTab(["vitals", "nutrition"])).toBe("body");
  });
});

describe("trendsTabStrip", () => {
  it("drops to six entries with no Vitals tab", () => {
    const strip = trendsTabStrip(false);
    expect(strip).toHaveLength(6);
    expect(strip.map((t) => t.id)).toEqual([
      "overview",
      "compare",
      "body",
      "nutrition",
      "fitness",
      "insights",
    ]);
    expect(strip.map((t) => t.label)).not.toContain("Vitals");
  });

  it("omits the age-gated surfaces for a restricted profile", () => {
    const strip = trendsTabStrip(true);
    expect(strip.map((t) => t.id)).toEqual([
      "overview",
      "compare",
      "body",
      "nutrition",
    ]);
    // Body is NEVER age-gated — the merged tab has to stay reachable for a minor
    // (it carries the growth charts).
    expect(strip.map((t) => t.id)).toContain("body");
  });
});

describe("isTabRestricted", () => {
  it("only restricts fitness + insights", () => {
    expect(isTabRestricted("fitness", true)).toBe(true);
    expect(isTabRestricted("insights", true)).toBe(true);
    expect(isTabRestricted("body", true)).toBe(false);
    expect(isTabRestricted("fitness", false)).toBe(false);
  });
});
