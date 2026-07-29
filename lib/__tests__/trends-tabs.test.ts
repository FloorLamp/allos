import { describe, it, expect } from "vitest";
import {
  DEFAULT_TRENDS_TAB,
  TRENDS_TABS,
  isTabRestricted,
  parseTab,
  trendsTabStrip,
} from "@/lib/trends-tabs";
import { viewToQuery } from "@/lib/trend-views";

// #1489: Compare retires into Insights (as a section of the hub's "derived views"
// tab) — a vocabulary mapping, not a redirect, which is what keeps every old
// `?tab=compare` deep link (and every stored saved view) alive.
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

// The compare params are read off the URL independently of the tab name, so an old
// deep link's comparison survives the alias untouched — no redirect layer strips
// them, and nothing has to re-encode them. Pinned end-to-end over the URL a legacy
// link (or a stored saved view) actually carries.
describe("a retired ?tab=compare link carries its comparison (#1489)", () => {
  it("resolves to insights with cmpA/cmpB/cmpn intact", () => {
    const sp = new URLSearchParams(
      "tab=compare&cmpA=metric:weight&cmpB=metric:resting_hr&cmpn=1&from=2026-01-01&to=2026-02-01"
    );
    expect(parseTab(sp.get("tab") ?? undefined)).toBe("insights");
    expect(sp.get("cmpA")).toBe("metric:weight");
    expect(sp.get("cmpB")).toBe("metric:resting_hr");
    expect(sp.get("cmpn")).toBe("1");
  });

  it("resolves a SAVED VIEW that stored the retired tab name", () => {
    // trend_views rows serialize the hub's URL state verbatim, so a view saved on
    // the old Compare tab still says tab=compare. viewToQuery re-emits it and
    // parseTab lands it on Insights with the pair still selected.
    const qs = viewToQuery({
      tab: "compare",
      cmpA: "metric:weight",
      cmpB: "metric:volume",
      cmpn: true,
      from: "2026-01-01",
      to: "2026-02-01",
    });
    const sp = new URLSearchParams(qs);
    expect(sp.get("tab")).toBe("compare");
    expect(parseTab(sp.get("tab") ?? undefined)).toBe("insights");
    expect(sp.get("cmpA")).toBe("metric:weight");
    expect(sp.get("cmpB")).toBe("metric:volume");
    expect(sp.get("cmpn")).toBe("1");
  });
});

describe("trendsTabStrip", () => {
  it("is FOUR tabs in frequency order (#1644)", () => {
    const strip = trendsTabStrip(false);
    expect(strip).toHaveLength(4);
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
    // The four are permanent by owner ruling: a fifth chip appearing here (or a
    // section quietly absorbing one of them) is a decision, not a refactor.
    expect(TRENDS_TABS).toHaveLength(4);
  });

  it("keeps Insights for a restricted profile, dropping only Fitness (#1489)", () => {
    const strip = trendsTabStrip(true);
    expect(strip.map((t) => t.id)).toEqual(["overview", "nutrition", "insights"]);
    // Insights survives because compare — its age-NEUTRAL section — lives there
    // now; the gated AI half is hidden inside the section, not by the strip.
    expect(strip.map((t) => t.id)).toContain("insights");
    // Overview is NEVER age-gated: since #1644 it carries the body census, which a
    // minor needs (the growth charts live there).
    expect(strip.map((t) => t.id)).toContain("overview");
    expect(strip.map((t) => t.id)).not.toContain("fitness");
  });

  it("labels every entry from the live tab set, for both roles", () => {
    for (const restricted of [false, true]) {
      for (const entry of trendsTabStrip(restricted)) {
        expect(TRENDS_TABS).toContain(entry.id);
        expect(entry.label).toBeTruthy();
      }
    }
  });
});

describe("isTabRestricted", () => {
  it("only restricts fitness — insights is section-gated now (#1489)", () => {
    expect(isTabRestricted("fitness", true)).toBe(true);
    expect(isTabRestricted("insights", true)).toBe(false);
    expect(isTabRestricted("overview", true)).toBe(false);
    expect(isTabRestricted("fitness", false)).toBe(false);
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
