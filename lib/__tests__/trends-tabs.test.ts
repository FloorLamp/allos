import { describe, it, expect } from "vitest";
import {
  DEFAULT_TRENDS_TAB,
  TRENDS_TABS,
  parseTab,
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
  it("is FOUR tabs in frequency order (#1644)", () => {
    const strip = trendsTabStrip();
    expect(strip.map((t) => t.id)).toEqual([
      "overview",
      "fitness",
      "nutrition",
      "insights",
    ]);
    // No retired tab is a chip any more — Vitals (#1486) and Compare (#1489)
    // merged into others, and Body (#1644) merged into the landing surface the
    // Overview chip already selects.
    for (const gone of ["Vitals", "Compare", "Body"]) {
      expect(strip.map((t) => t.label)).not.toContain(gone);
    }
  });

  it("labels every entry from the live tab set", () => {
    for (const entry of trendsTabStrip()) {
      expect(TRENDS_TABS).toContain(entry.id);
      expect(entry.label).toBeTruthy();
    }
  });

  it("omits Fitness when the workout product is not relevant", () => {
    expect(trendsTabStrip(false).map((entry) => entry.id)).toEqual([
      "overview",
      "nutrition",
      "insights",
    ]);
  });
});

// #1492: the nested Fitness strip (`?ftab=strength|cardio|sport`) retires the same
// way its two tab-level predecessors did — a VOCABULARY MAPPING, not a redirect.
// The tab is four windowed sections now, so there is nothing left for the nested
// value to select: it names Fitness, and is then ignored.
describe("the retired nested ?ftab= (#1492)", () => {
  it("keeps a full `?tab=fitness&ftab=…` deep link on Fitness", () => {
    for (const ftab of ["strength", "cardio", "sport"]) {
      expect(parseTab("fitness", ftab)).toBe("fitness");
    }
  });

  it("names Fitness when the outer ?tab= is missing or unknown", () => {
    expect(parseTab(undefined, "cardio")).toBe("fitness");
    expect(parseTab("", "sport")).toBe("fitness");
    expect(parseTab("biomarkers", "strength")).toBe("fitness");
    // The mapping is NESTED-only: a nested value arriving as the OUTER ?tab= is
    // just an unknown tab name, not a Fitness alias.
    expect(parseTab("cardio")).toBe(DEFAULT_TRENDS_TAB);
  });

  it("never lets a nested value override a LIVE tab", () => {
    // A live `?tab=` always wins: the nested param is legacy vocabulary, so it can
    // only ever fill in for a tab that names nothing.
    expect(parseTab("nutrition", "cardio")).toBe("nutrition");
    expect(parseTab("insights", "strength")).toBe("insights");
    // …including a retired TAB alias, which resolves through its own map first.
    expect(parseTab("compare", "cardio")).toBe("insights");
    // A retired name with NO alias (#1644's body/vitals) resolves to nothing, so
    // the nested value is still consulted — the fallback order, stated.
    expect(parseTab("body", "sport")).toBe("fitness");
  });

  it("ignores an unknown nested value", () => {
    expect(parseTab(undefined, "mobility")).toBe(DEFAULT_TRENDS_TAB);
    expect(parseTab(undefined, "")).toBe(DEFAULT_TRENDS_TAB);
    expect(parseTab(undefined, undefined)).toBe(DEFAULT_TRENDS_TAB);
  });

  it("takes the FIRST value of a repeated nested param", () => {
    expect(parseTab(undefined, ["sport", "nonsense"])).toBe("fitness");
  });

  it("resolves the whole legacy URL a nudge/bookmark carries", () => {
    const sp = new URLSearchParams("tab=fitness&ftab=cardio");
    expect(
      parseTab(sp.get("tab") ?? undefined, sp.get("ftab") ?? undefined)
    ).toBe("fitness");
    // The hub never re-emits it: nothing downstream reads ftab once the tab is
    // resolved, so the param simply falls off the next link.
  });
});
