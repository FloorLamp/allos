import { describe, it, expect } from "vitest";
import {
  DEFAULT_TRENDS_TAB,
  TRENDS_TABS,
  isTabRestricted,
  parseTab,
  trendsTabStrip,
} from "@/lib/trends-tabs";
import { viewToQuery } from "@/lib/trend-views";

// #1486: the Vitals tab retires into Body (vitals section first). #1489: Compare
// retires into Insights (as a section of the hub's "derived views" tab). Both are
// vocabulary mappings — not redirects — and that is what keeps every old
// `?tab=vitals` / `?tab=compare` deep link (and every stored saved view) alive.

describe("parseTab", () => {
  it("maps the retired ?tab=vitals onto body", () => {
    expect(parseTab("vitals")).toBe("body");
    expect(parseTab(["vitals"])).toBe("body");
    expect(parseTab(" vitals ")).toBe("body");
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
    expect(parseTab(["vitals", "nutrition"])).toBe("body");
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
  it("is five tabs in frequency order (#1489)", () => {
    const strip = trendsTabStrip(false);
    expect(strip).toHaveLength(5);
    expect(strip.map((t) => t.id)).toEqual([
      "overview",
      "body",
      "fitness",
      "nutrition",
      "insights",
    ]);
    // Neither retired tab is a chip any more.
    expect(strip.map((t) => t.label)).not.toContain("Vitals");
    expect(strip.map((t) => t.label)).not.toContain("Compare");
  });

  it("keeps Insights for a restricted profile, dropping only Fitness (#1489)", () => {
    const strip = trendsTabStrip(true);
    expect(strip.map((t) => t.id)).toEqual([
      "overview",
      "body",
      "nutrition",
      "insights",
    ]);
    // Insights survives because compare — its age-NEUTRAL section — lives there
    // now; the gated AI half is hidden inside the section, not by the strip.
    expect(strip.map((t) => t.id)).toContain("insights");
    // Body is NEVER age-gated — the merged tab has to stay reachable for a minor
    // (it carries the growth charts).
    expect(strip.map((t) => t.id)).toContain("body");
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
    expect(isTabRestricted("body", true)).toBe(false);
    expect(isTabRestricted("fitness", false)).toBe(false);
  });
});
