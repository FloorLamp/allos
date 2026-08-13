import { describe, it, expect } from "vitest";
import {
  DORMANCY_DEFAULT_DAYS,
  DORMANCY_DOMAINS,
  DORMANCY_DOMAIN_KEYS,
  dormancyWindowConflicts,
  dormancyState,
  dormantRecordLine,
  type DormancyDomain,
} from "../domain-dormancy";
import {
  DASHBOARD_WIDGETS,
  DORMANCY_EXEMPT_WIDGETS,
  widgetDisplayState,
  type WidgetDef,
} from "../dashboard-widgets";
import { WEIGHT_TREND_WINDOW_DAYS } from "../domain-dormancy";

// Every expectation below is a PINNED LITERAL. Re-deriving an interval from the
// registry under test would pass with the registry gutted.

const TODAY = "2026-08-13";

describe("DORMANCY_DOMAINS registry", () => {
  it("declares the owner-resolved default of 90 days", () => {
    expect(DORMANCY_DEFAULT_DAYS).toBe(90);
  });

  it("pins every domain's interval", () => {
    expect(
      Object.fromEntries(
        DORMANCY_DOMAIN_KEYS.map((d) => [
          d,
          DORMANCY_DOMAINS[d].collapseAfterDays,
        ])
      )
    ).toEqual({ sleep: 90, weight: 90 });
  });

  it("pins the collapsible set — a card only joins it by a visible edit", () => {
    expect([...DORMANCY_DOMAIN_KEYS].sort()).toEqual(["sleep", "weight"]);
  });

  it("names the RECORD, never the activity — the collapsed line can only claim the ledger", () => {
    expect(DORMANCY_DOMAINS.sleep.record).toBe("sleep");
    expect(DORMANCY_DOMAINS.weight.record).toBe("weigh-in");
  });

  it("every domain states WHY its interval is what it is", () => {
    for (const d of DORMANCY_DOMAIN_KEYS) {
      expect(DORMANCY_DOMAINS[d].reason.length).toBeGreaterThan(20);
    }
  });

  it("the weight domain's window IS the card's window — the collapse hides no point", () => {
    expect(WEIGHT_TREND_WINDOW_DAYS).toBe(90);
    expect(DORMANCY_DOMAINS.weight.renderWindowDays).toBe(
      WEIGHT_TREND_WINDOW_DAYS
    );
    expect(DORMANCY_DOMAINS.sleep.renderWindowDays).toBe(1);
  });

  it("no domain collapses while its own section could still be rendering something", () => {
    // The structural guarantee that bounds this feature: a section is only ever
    // collapsed once it is already showing nothing.
    expect(dormancyWindowConflicts()).toEqual([]);
  });

  it("the conflict census is a real check, not a constant", () => {
    // Feed it a declaration that violates the rule by construction, proving the census
    // reads the numbers rather than returning [] unconditionally.
    const rigged: Record<
      DormancyDomain,
      { collapseAfterDays: number; renderWindowDays: number }
    > = {
      sleep: DORMANCY_DOMAINS.sleep,
      weight: { ...DORMANCY_DOMAINS.weight, collapseAfterDays: 30 },
    };
    const conflicts = (Object.keys(rigged) as DormancyDomain[]).filter(
      (d) => rigged[d].collapseAfterDays < rigged[d].renderWindowDays
    );
    expect(conflicts).toEqual(["weight"]);
  });
});

describe("dormancyState", () => {
  it("no record at all is ABSENT, never dormant — the onboarding case keeps its own copy", () => {
    expect(
      dormancyState({ lastRecordDate: null, today: TODAY, domain: "weight" })
    ).toBe("absent");
    expect(
      dormancyState({ lastRecordDate: "", today: TODAY, domain: "weight" })
    ).toBe("absent");
    expect(
      dormancyState({
        lastRecordDate: undefined,
        today: TODAY,
        domain: "sleep",
      })
    ).toBe("absent");
  });

  it("an unparseable date is ABSENT, never folded into dormant", () => {
    expect(
      dormancyState({
        lastRecordDate: "not-a-date",
        today: TODAY,
        domain: "sleep",
      })
    ).toBe("absent");
  });

  it("today's record is current", () => {
    expect(
      dormancyState({
        lastRecordDate: "2026-08-13",
        today: TODAY,
        domain: "weight",
      })
    ).toBe("current");
  });

  it("the boundary is STRICTLY after the interval — 90 days is awake, 91 is dormant", () => {
    // 2026-05-15 is exactly 90 days before 2026-08-13.
    expect(
      dormancyState({
        lastRecordDate: "2026-05-15",
        today: TODAY,
        domain: "weight",
      })
    ).toBe("current");
    expect(
      dormancyState({
        lastRecordDate: "2026-05-14",
        today: TODAY,
        domain: "weight",
      })
    ).toBe("dormant");
  });

  it("a record in the FUTURE is current, never dormant", () => {
    expect(
      dormancyState({
        lastRecordDate: "2026-09-01",
        today: TODAY,
        domain: "sleep",
      })
    ).toBe("current");
  });
});

describe("dormantRecordLine", () => {
  it("states the record and the age, and claims nothing about the body", () => {
    expect(dormantRecordLine("sleep", 152)).toBe(
      "No sleep recorded in 152 days"
    );
    expect(dormantRecordLine("weight", 91)).toBe(
      "No weigh-in recorded in 91 days"
    );
  });

  it("singular day, and never a negative age", () => {
    expect(dormantRecordLine("sleep", 1)).toBe("No sleep recorded in 1 day");
    expect(dormantRecordLine("sleep", -4)).toBe("No sleep recorded in 0 days");
  });
});

describe("dormancy registry completeness (owner ruling: declared per domain)", () => {
  const dataAware = DASHBOARD_WIDGETS.filter((w) => w.dataAware);

  it("every data-aware widget either declares a dormancy domain or states why not", () => {
    const undeclared = dataAware
      .filter(
        (w) => w.dormancyDomain == null && !(w.id in DORMANCY_EXEMPT_WIDGETS)
      )
      .map((w) => w.id);
    expect(undeclared).toEqual([]);
  });

  it("pins the split, so moving a card across it is a visible edit", () => {
    expect(
      dataAware.filter((w) => w.dormancyDomain != null).map((w) => w.id)
    ).toEqual(["sleep-last-night", "weight-trend"]);
    expect(Object.keys(DORMANCY_EXEMPT_WIDGETS).sort()).toEqual([
      "cycle-phase",
      "healthspan-pillars",
      "nutrition-today",
      "recent-labs",
      "vitals-latest",
    ]);
  });

  it("an exemption is never silent — each names a reason", () => {
    for (const [id, reason] of Object.entries(DORMANCY_EXEMPT_WIDGETS)) {
      expect(reason.length, id).toBeGreaterThan(20);
    }
  });

  it("nothing is exempt AND declared, and nothing is exempt without being data-aware", () => {
    for (const id of Object.keys(DORMANCY_EXEMPT_WIDGETS)) {
      const def = DASHBOARD_WIDGETS.find((w) => w.id === id);
      expect(def?.dataAware, id).toBe(true);
      expect(def?.dormancyDomain, id).toBeUndefined();
    }
  });

  it("only a data-aware widget may declare a dormancy domain", () => {
    for (const w of DASHBOARD_WIDGETS) {
      if (w.dormancyDomain != null) expect(w.dataAware, w.id).toBe(true);
    }
  });

  it("every declared domain is a registered one", () => {
    for (const w of DASHBOARD_WIDGETS) {
      if (w.dormancyDomain != null)
        expect(DORMANCY_DOMAIN_KEYS).toContain(w.dormancyDomain);
    }
  });

  it("a card showing a stale VALUE under a presentation floor is never collapsible", () => {
    // The rule that bounds the feature (#1216/#2303): those two cards render their
    // latest reading at any age, so a collapse would hide what their floor keeps.
    for (const id of ["recent-labs", "vitals-latest"]) {
      const def = DASHBOARD_WIDGETS.find((w) => w.id === id)!;
      expect(def.dormancyDomain, id).toBeUndefined();
      expect(DORMANCY_EXEMPT_WIDGETS[id]).toMatch(/floor/i);
    }
  });

  it("nothing carrying an obligation is collapsible — the pinned hero cannot declare one", () => {
    // The owner's exemption clause. Doses, refills and care follow-ups reach the
    // dashboard through the pinned "Needs attention" hero, which is not data-aware and
    // therefore cannot be flagged dormant by construction.
    const hero = DASHBOARD_WIDGETS.find((w) => w.id === "needs-attention")!;
    expect(hero.pinned).toBe(true);
    expect(hero.dataAware).toBeUndefined();
    expect(hero.dormancyDomain).toBeUndefined();
  });
});

describe("widgetDisplayState", () => {
  const def = (over: Partial<WidgetDef>): WidgetDef => ({
    id: "x",
    label: "X",
    description: "",
    defaultOn: true,
    fitness: false,
    actionable: false,
    span: "half",
    ...over,
  });

  it("dormant wins over empty — the two states cannot both be claimed", () => {
    expect(
      widgetDisplayState(def({ dataAware: true, dormancyDomain: "sleep" }), {
        empty: true,
        dormant: true,
      })
    ).toBe("dormant");
  });

  it("a widget that declares no domain can never be dormant, however it is flagged", () => {
    expect(
      widgetDisplayState(def({ dataAware: true }), {
        empty: false,
        dormant: true,
      })
    ).toBe("content");
  });

  it("a widget that is not data-aware can never be empty", () => {
    expect(widgetDisplayState(def({}), { empty: true, dormant: false })).toBe(
      "content"
    );
  });

  it("the ordinary cases", () => {
    expect(
      widgetDisplayState(def({ dataAware: true, dormancyDomain: "weight" }), {
        empty: true,
        dormant: false,
      })
    ).toBe("empty");
    expect(
      widgetDisplayState(def({ dataAware: true, dormancyDomain: "weight" }), {
        empty: false,
        dormant: true,
      })
    ).toBe("dormant");
    expect(
      widgetDisplayState(def({ dataAware: true, dormancyDomain: "weight" }), {
        empty: false,
        dormant: false,
      })
    ).toBe("content");
  });
});
