import { describe, it, expect } from "vitest";
import {
  ACTIVE_PROTOCOLS_CAP,
  COACHING_OBSERVATIONS_CAP,
  DASHBOARD_WIDGETS,
  DATA_QUALITY_GAPS_CAP,
  capDashboardList,
  capActionableDashboardList,
  customizableWidgetDefs,
  FINDING_DASHBOARD_HOME,
  findingDashboardHome,
  findingsForDashboardHome,
  rollupCoachingFindings,
  dashboardHabitDomain,
  dashboardGoalsHabitsLayout,
  resolveWidgets,
  resolveWidgetList,
  pinnedWidgets,
  summarizeDashboardHabits,
  type DashboardLayout,
} from "../dashboard-widgets";

const ids = (ws: { id: string }[]) => ws.map((w) => w.id);
// The customizable catalog excludes pinned widgets (the hero) — those are rendered
// directly by the page and never appear in the resolve* outputs.
const customizable = customizableWidgetDefs(false);
const defaultOnIds = customizable.filter((w) => w.defaultOn).map((w) => w.id);
const fitnessIds = customizable.filter((w) => w.fitness).map((w) => w.id);

describe("resolveWidgets / resolveWidgetList", () => {
  it("null layout → default-on widgets in registry order", () => {
    const visible = resolveWidgets(null, false);
    expect(ids(visible)).toEqual(defaultOnIds);
  });

  it("null layout → full list (visible + hidden) is every customizable widget in registry order", () => {
    const list = resolveWidgetList(null, false);
    expect(list.map((w) => w.def.id)).toEqual(customizable.map((w) => w.id));
    // visibility follows defaultOn for a fresh profile
    for (const item of list) {
      expect(item.visible).toBe(item.def.defaultOn);
    }
  });

  it("stored order with a removed/unknown id → that id is dropped, rest preserved", () => {
    const layout: DashboardLayout = {
      order: ["weight-trend", "does-not-exist", "recent-labs"],
      hidden: [],
    };
    const visible = resolveWidgets(layout, false);
    expect(ids(visible)).not.toContain("does-not-exist");
    // stored order honored for the ids it lists
    expect(visible[0].id).toBe("weight-trend");
    expect(visible[1].id).toBe("recent-labs");
  });

  it("drops every retired dashboard widget from legacy saved layouts", () => {
    const retired = [
      "quick-stats",
      "care-plan-due",
      "starred-biomarkers",
      "bio-age",
      "recent-activity",
      "immunizations",
      "todays-insight",
      "streak",
      "low-supply",
      "active-goals",
      "weekly-routine",
      // Folded into the illness hero (#858) — a stored layout naming it stays valid.
      "sick-household",
      // Folded into the "How are you today?" check-in as the "Take any meds?" branch
      // (#1221) — a stored layout naming it is dropped without a migration.
      "quick-log-prn",
    ];
    const list = resolveWidgetList(
      { order: [...retired, "weight-trend"], hidden: retired },
      false
    );
    expect(list.map((w) => w.def.id)).not.toEqual(
      expect.arrayContaining(retired)
    );
    expect(list.map((w) => w.def.id)).toContain("goals-habits");
  });

  it("the folded quick-log-prn widget is gone from the registry (#1221)", () => {
    // The PRN quick-log is now the check-in card's "Take any meds?" branch; a stored
    // layout that still lists it is dropped defensively and it must not reappear as a
    // customizable widget.
    expect(DASHBOARD_WIDGETS.map((w) => w.id)).not.toContain("quick-log-prn");
    const list = resolveWidgetList(
      { order: ["quick-log-prn", "weight-trend"], hidden: [] },
      false
    );
    expect(list.map((w) => w.def.id)).not.toContain("quick-log-prn");
    expect(list.map((w) => w.def.id)).toContain("weight-trend");
  });

  it("the folded sick-household widget is gone from the registry (#858)", () => {
    // The illness hero replaced it; a stored layout that still lists it is dropped
    // defensively (above), and it must not reappear as a customizable widget.
    expect(DASHBOARD_WIDGETS.map((w) => w.id)).not.toContain("sick-household");
    const list = resolveWidgetList(
      { order: ["sick-household", "weight-trend"], hidden: [] },
      false
    );
    expect(list.map((w) => w.def.id)).not.toContain("sick-household");
    expect(list.map((w) => w.def.id)).toContain("weight-trend");
  });

  it("registry widget missing from stored order → appended honoring defaultOn", () => {
    // A layout that only mentions one widget; everything else is "new" to it.
    const layout: DashboardLayout = { order: ["weight-trend"], hidden: [] };
    const list = resolveWidgetList(layout, false);
    expect(list[0].def.id).toBe("weight-trend");
    const appended = list.slice(1).map((w) => w.def.id);
    const expectedAppended = customizable
      .map((w) => w.id)
      .filter((id) => id !== "weight-trend");
    expect(appended).toEqual(expectedAppended);
    // an off-by-default widget the layout has never seen stays hidden
    const recap = list.find((w) => w.def.id === "weekly-recap")!;
    expect(recap.visible).toBe(false);
    // an on-by-default widget the layout has never seen shows
    const goals = list.find((w) => w.def.id === "goals-habits")!;
    expect(goals.visible).toBe(true);
  });

  it("hidden id → not visible but still present in the full list", () => {
    const layout: DashboardLayout = {
      order: customizable.map((w) => w.id),
      hidden: ["recent-labs"],
    };
    const visible = resolveWidgets(layout, false);
    expect(ids(visible)).not.toContain("recent-labs");
    const list = resolveWidgetList(layout, false);
    const labs = list.find((w) => w.def.id === "recent-labs")!;
    expect(labs.visible).toBe(false);
  });

  it("explicitly enabling an off-by-default widget (in order, not hidden) makes it visible", () => {
    const layout: DashboardLayout = {
      order: ["weekly-recap", "recent-labs"],
      hidden: [],
    };
    const visible = resolveWidgets(layout, false);
    expect(ids(visible)).toContain("weekly-recap");
  });

  it("restricted → no fitness widget appears in either output", () => {
    const list = resolveWidgetList(null, true);
    for (const id of fitnessIds) {
      expect(list.map((w) => w.def.id)).not.toContain(id);
    }
    const visible = resolveWidgets(null, true);
    for (const id of fitnessIds) {
      expect(ids(visible)).not.toContain(id);
    }
    // non-fitness default widgets survive
    expect(ids(visible)).toContain("recent-labs");
    expect(ids(visible)).toContain("weight-trend");
  });

  it("restricted → a stored order that references a fitness widget still drops it, keeps the rest ordered", () => {
    const layout: DashboardLayout = {
      order: ["goals-habits", "weight-trend", "coaching", "recent-labs"],
      hidden: [],
    };
    const visible = resolveWidgets(layout, true);
    expect(ids(visible)).not.toContain("goals-habits");
    expect(ids(visible)).not.toContain("coaching");
    // relative order of the surviving non-fitness ids preserved
    expect(ids(visible).indexOf("weight-trend")).toBeLessThan(
      ids(visible).indexOf("recent-labs")
    );
  });

  // Issue #1221 — the per-profile WidgetGate (the dashboard twin of the nav's
  // per-entry gating): requiresFoodLogging + relevanceKey === "cycle".
  it("gate foodLogging:false drops nutrition-today (the infant-profile food gate)", () => {
    const shown = resolveWidgets(null, false, undefined, {
      foodLogging: false,
    });
    expect(ids(shown)).not.toContain("nutrition-today");
    // Non-food-gated cards survive the food gate.
    expect(ids(shown)).toContain("steps-today");
    expect(ids(shown)).toContain("vitals-latest");
    // The full list (Customize) also drops it, so it never renders even in preview.
    const list = resolveWidgetList(null, false, undefined, {
      foodLogging: false,
    });
    expect(list.map((w) => w.def.id)).not.toContain("nutrition-today");
  });

  it("gate cycle:false drops cycle-phase (the cycle-relevance gate), default keeps it", () => {
    const hidden = resolveWidgets(null, false, undefined, { cycle: false });
    expect(ids(hidden)).not.toContain("cycle-phase");
    // Default gate (all-eligible) keeps both gated cards.
    const shown = resolveWidgets(null, false);
    expect(ids(shown)).toContain("cycle-phase");
    expect(ids(shown)).toContain("nutrition-today");
  });

  it("a gated widget in a stored order is still dropped when its gate bit is off", () => {
    const layout: DashboardLayout = {
      order: ["cycle-phase", "nutrition-today", "weight-trend"],
      hidden: [],
    };
    const list = resolveWidgetList(layout, false, undefined, {
      foodLogging: false,
      cycle: false,
    });
    expect(list.map((w) => w.def.id)).not.toContain("cycle-phase");
    expect(list.map((w) => w.def.id)).not.toContain("nutrition-today");
    expect(list.map((w) => w.def.id)).toContain("weight-trend");
  });

  it("dedupes a stored order that repeats an id", () => {
    const layout: DashboardLayout = {
      order: ["recent-labs", "recent-labs", "weight-trend"],
      hidden: [],
    };
    const list = resolveWidgetList(layout, false);
    const occurrences = list.filter((w) => w.def.id === "recent-labs").length;
    expect(occurrences).toBe(1);
  });
});

// ── Issue #1890 — actionable-first default order ──────────────────────────────
// Owner principle: a card you are meant to ACT on comes before a card you merely
// read. `actionable` is declared once per widget in the registry (#221 — nothing
// re-derives it), and this guard keeps the DEFAULT order honest as the catalog
// grows. The failure it exists for is widget #18 quietly landing a glance card
// above the daily check-in, the way Recent labs and Next appointment had taken the
// two prime post-hero slots while "How are you today?" sat second-to-last.
//
// A violation is allowed — but only as a NAMED entry below: widget id → the owner
// ruling that justifies it. The list is EMPTY today, and that is the point: a future
// exception is a stated decision with a name on it, not a silent reordering. Same
// shape as this repo's other registry allowlists (chart-colors-scan,
// border-alpha-language): every entry carries a justification, and a staleness test
// removes it once the widget stops violating.
//
// It has stayed empty through the one real conflict so far. #1892 gave `vitals-latest`
// and `cycle-phase` a log affordance in their POPULATED state, which collided with the
// rule #1890 had written for empty-state CTAs. The owner ruled that the definition
// governs: both cards became actionable and MOVED into the band, and the stale rule was
// rewritten at the `actionable` declaration. No exception was carved — which is the
// point, since a list that absorbs every collision stops meaning anything.
const ACTIONABLE_ORDER_EXCEPTIONS = new Map<string, string>([
  // Example of the shape an entry takes (do not uncomment — this is the ruling
  // #1890 explicitly left open):
  // ["healthspan-pillars", "owner ruling #NNNN — the differentiator headline keeps
  //   a prime slot even though it is a glance card"],
]);

// The ids that break actionable-first in `defs`: every actionable widget sitting
// after the first glance card. (The dual — a glance card ahead of an actionable one
// — is the same defect from the other side; naming the actionable stragglers points
// the failure at the card that should move UP, which is the fix that matches the
// principle.)
function actionableOrderOffenders(
  defs: readonly { id: string; actionable: boolean }[],
  exempt: ReadonlySet<string>
): string[] {
  const considered = defs.filter((w) => !exempt.has(w.id));
  const firstGlance = considered.findIndex((w) => !w.actionable);
  if (firstGlance === -1) return [];
  return considered
    .slice(firstGlance)
    .filter((w) => w.actionable)
    .map((w) => w.id);
}

describe("actionable-first default order (#1890)", () => {
  it("every widget declares `actionable` explicitly", () => {
    // TypeScript already requires the field; this pins that it stays REQUIRED and
    // boolean. Making it optional with an implicit default would let a new widget
    // omit it and land in whichever tier the default happened to pick — exactly the
    // quiet drift the ordering guard exists to prevent.
    for (const widget of DASHBOARD_WIDGETS) {
      expect(
        Object.prototype.hasOwnProperty.call(widget, "actionable"),
        `${widget.id} must declare actionable`
      ).toBe(true);
      expect(typeof widget.actionable, `${widget.id}.actionable`).toBe(
        "boolean"
      );
    }
  });

  it("in the default order, every actionable widget precedes every glance card", () => {
    const offenders = actionableOrderOffenders(
      customizable,
      new Set(ACTIONABLE_ORDER_EXCEPTIONS.keys())
    );
    expect(
      offenders,
      `these actionable widgets sit below a glance card — move them up, or add a ` +
        `named ACTIONABLE_ORDER_EXCEPTIONS entry recording the owner ruling: ${offenders.join(", ")}`
    ).toEqual([]);
  });

  it("holds for a restricted profile too (the gated views are subsequences)", () => {
    // Filtering never reorders, so an actionable-first catalog stays actionable-first
    // for a child profile or one with the food/cycle bits off. Asserted rather than
    // argued, since it is the order a real profile sees.
    const exempt = new Set(ACTIONABLE_ORDER_EXCEPTIONS.keys());
    expect(
      actionableOrderOffenders(customizableWidgetDefs(true), exempt)
    ).toEqual([]);
    expect(
      actionableOrderOffenders(
        customizableWidgetDefs(false, { foodLogging: false, cycle: false }),
        exempt
      )
    ).toEqual([]);
  });

  it("every exception is real, justified, and still needed (no stale entries)", () => {
    const catalogIds = new Set(DASHBOARD_WIDGETS.map((w) => w.id));
    for (const [id, reason] of ACTIONABLE_ORDER_EXCEPTIONS) {
      expect(catalogIds.has(id), `${id} is not a catalog widget`).toBe(true);
      expect(
        reason.trim().length,
        `${id} needs a justification`
      ).toBeGreaterThan(0);
      // Drop just this entry: the order must actually break without it. If it does
      // not, the widget has since moved into its proper tier and the exception —
      // and the ruling it records — should be deleted.
      const others = new Set(
        [...ACTIONABLE_ORDER_EXCEPTIONS.keys()].filter((k) => k !== id)
      );
      expect(
        actionableOrderOffenders(customizable, others).length,
        `${id} no longer violates actionable-first — delete its exception`
      ).toBeGreaterThan(0);
    }
  });

  it("pins the default order the owner ruled (#1890)", () => {
    // The prescription itself, in test form. Changing this list is a product
    // decision: a new widget takes the slot its `actionable` tier earns it, and the
    // guard above is what makes that placement non-negotiable.
    expect(customizable.map((w) => w.id)).toEqual([
      // Actionable — tapped today.
      "symptom-log",
      "coaching",
      "goals-habits",
      "active-protocols",
      "data-quality",
      "nutrition-today",
      "steps-today",
      // Episodic writes close the actionable band — a tap that writes, on a weekly
      // or per-cycle cadence rather than a daily one (owner ruling on #1890, after
      // #1892 put a log affordance in each card's POPULATED state).
      "vitals-latest",
      "cycle-phase",
      // Glance — read and move on.
      "next-appointment",
      "recent-labs",
      "sleep-last-night",
      "naps-today",
      "weight-trend",
      "healthspan-pillars",
      // The calm rollup closes the list (#449), and the opt-in retrospective is last.
      "coaching-observations",
      "weekly-recap",
    ]);
  });
});

// Issue #171 — the pinned "Needs attention" hero.
describe("pinned widgets (the hero)", () => {
  it("exactly one pinned widget exists: the needs-attention hero", () => {
    const pinned = pinnedWidgets();
    expect(pinned.map((w) => w.id)).toEqual(["needs-attention"]);
  });

  it("the pinned widget is never listed in the customizable resolve* outputs", () => {
    // Even a layout that explicitly names it (a tampered/legacy blob) can't pull
    // the pin into the grid — it's not eligible, so it's dropped.
    const layout: DashboardLayout = {
      order: ["needs-attention", "recent-labs"],
      hidden: [],
    };
    for (const restricted of [false, true]) {
      const list = resolveWidgetList(layout, restricted);
      expect(list.map((w) => w.def.id)).not.toContain("needs-attention");
      expect(ids(resolveWidgets(layout, restricted))).not.toContain(
        "needs-attention"
      );
    }
  });

  it("the pin can't be hidden away — hiding it in the layout is a no-op (it isn't in the grid)", () => {
    const layout: DashboardLayout = {
      order: customizable.map((w) => w.id),
      hidden: ["needs-attention"],
    };
    // The hero is unaffected by the customizable grid entirely.
    expect(pinnedWidgets().map((w) => w.id)).toContain("needs-attention");
    expect(resolveWidgetList(layout, false).map((w) => w.def.id)).not.toContain(
      "needs-attention"
    );
  });
});

// Issue #171 — data-aware visibility resolution.
describe("data-aware empty resolution", () => {
  it("a data-aware widget whose id is in emptyIds resolves empty=true (but stays visible)", () => {
    const empty = new Set(["recent-labs"]);
    const list = resolveWidgetList(null, false, empty);
    const labs = list.find((w) => w.def.id === "recent-labs")!;
    expect(labs.def.dataAware).toBe(true);
    expect(labs.empty).toBe(true);
    // Emptiness never hides the widget — the CTA must be reachable.
    expect(labs.visible).toBe(true);
  });

  it("a data-aware widget NOT in emptyIds resolves empty=false", () => {
    const list = resolveWidgetList(null, false, new Set());
    const labs = list.find((w) => w.def.id === "recent-labs")!;
    expect(labs.empty).toBe(false);
  });

  it("a non-data-aware widget is never marked empty, even if its id is in emptyIds", () => {
    const list = resolveWidgetList(null, false, new Set(["coaching"]));
    const coaching = list.find((w) => w.def.id === "coaching")!;
    expect(coaching.def.dataAware).toBeFalsy();
    expect(coaching.empty).toBe(false);
  });
});

describe("summarizeDashboardHabits", () => {
  it("routes wellness practices independently from training and food", () => {
    expect(dashboardHabitDomain("practice")).toBe("practice");
    expect(dashboardHabitDomain("food_group")).toBe("food");
    expect(dashboardHabitDomain("region")).toBe("training");
    expect(dashboardHabitDomain("type")).toBe("training");
  });

  it("ranks the full open set before applying the compact dashboard limit", () => {
    const targets = [
      { id: "almost", count: 3, per_week: 4, met: false },
      { id: "half", count: 2, per_week: 4, met: false },
      { id: "done", count: 4, per_week: 4, met: true },
      { id: "quarter", count: 1, per_week: 4, met: false },
      { id: "none-a", count: 0, per_week: 3, met: false },
      { id: "none-b", count: 0, per_week: 2, met: false },
    ];

    const summary = summarizeDashboardHabits(targets, 4);

    expect(summary.shown.map((target) => target.id)).toEqual([
      "none-a",
      "none-b",
      "quarter",
      "half",
    ]);
    expect(summary.open.map((target) => target.id)).toEqual([
      "none-a",
      "none-b",
      "quarter",
      "half",
      "almost",
    ]);
    expect(summary.hidden.map((target) => target.id)).toEqual(["almost"]);
    expect(summary.completedCount).toBe(1);
    expect(summary.hiddenOpenCount).toBe(1);
  });
});

describe("capDashboardList (#1219)", () => {
  it("splits a list into the capped slice and its overflow, order kept", () => {
    const { shown, overflow } = capDashboardList([1, 2, 3, 4, 5], 3);
    expect(shown).toEqual([1, 2, 3]);
    expect(overflow).toEqual([4, 5]);
  });

  it("returns everything shown / no overflow at or under the cap", () => {
    expect(capDashboardList([1, 2], 3)).toEqual({
      shown: [1, 2],
      overflow: [],
    });
    expect(capDashboardList([], 3)).toEqual({ shown: [], overflow: [] });
  });

  it("tolerates a degenerate cap", () => {
    expect(capDashboardList([1, 2], 0)).toEqual({
      shown: [],
      overflow: [1, 2],
    });
    expect(capDashboardList([1, 2], -1)).toEqual({
      shown: [],
      overflow: [1, 2],
    });
  });

  it("pins the widget cap policy: observations 2, data-quality 3, protocols 3", () => {
    expect(COACHING_OBSERVATIONS_CAP).toBe(2);
    expect(DATA_QUALITY_GAPS_CAP).toBe(3);
    expect(ACTIVE_PROTOCOLS_CAP).toBe(3);
  });
});

describe("capActionableDashboardList (#1584)", () => {
  it("shows every actionable row and fills only the remaining cap with info", () => {
    const items = [
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `action-${index}`,
        actionable: true,
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `info-${index}`,
        actionable: false,
      })),
    ];

    const { shown, overflow } = capActionableDashboardList(
      items,
      3,
      (item) => item.actionable
    );

    expect(shown.map((item) => item.id)).toEqual([
      "action-0",
      "action-1",
      "action-2",
      "action-3",
      "action-4",
    ]);
    expect(overflow.map((item) => item.id)).toEqual([
      "info-0",
      "info-1",
      "info-2",
    ]);
  });

  it("fills remaining slots after actionable rows", () => {
    const items = [
      { id: "action", actionable: true },
      { id: "info-1", actionable: false },
      { id: "info-2", actionable: false },
      { id: "info-3", actionable: false },
    ];
    const { shown, overflow } = capActionableDashboardList(
      items,
      3,
      (item) => item.actionable
    );
    expect(shown.map((item) => item.id)).toEqual([
      "action",
      "info-1",
      "info-2",
    ]);
    expect(overflow.map((item) => item.id)).toEqual(["info-3"]);
  });
});

describe("dashboardGoalsHabitsLayout", () => {
  it("splits only when both goals and habits are present", () => {
    expect(dashboardGoalsHabitsLayout(true, true)).toBe("split");
    expect(dashboardGoalsHabitsLayout(true, false)).toBe("full");
    expect(dashboardGoalsHabitsLayout(false, true)).toBe("full");
  });
});

// #1533 — the dashboard rendered data-quality gaps TWICE (the Coaching-observations
// rollup AND the Data quality widget) and the rollup's header count included the rows
// it was double-showing. The rollup's own #449 charter is reach for findings that
// render only on their own tabs; a family with its own dashboard widget already has
// reach, so the registry below encodes that charter as data instead of a one-off filter.
describe("finding dashboard homes (#1533)", () => {
  // A stand-in for the ONE collectCoachingFindings set: two observational patterns
  // (no dashboard home of their own) plus two structural gaps (homed to the widget).
  const activeCoaching = [
    { dedupeKey: "training-obs:plateau:bench" },
    { dedupeKey: "goal-pace:7" },
    { dedupeKey: "data-quality:birthdate" },
    { dedupeKey: "data-quality:smoking" },
  ];
  const allVisible = () => true;
  const visibleExcept = (hidden: string) => (id: string) => id !== hidden;

  it("maps a homed family to its widget and leaves the rest unhomed", () => {
    expect(findingDashboardHome("data-quality:birthdate")).toBe("data-quality");
    expect(findingDashboardHome("training-obs:plateau:bench")).toBeNull();
  });

  it("every registered home is a real catalog widget id", () => {
    const catalogIds = new Set(DASHBOARD_WIDGETS.map((w) => w.id));
    for (const widgetId of Object.values(FINDING_DASHBOARD_HOME)) {
      expect(catalogIds.has(widgetId)).toBe(true);
    }
  });

  it("with both widgets on, the two sets are DISJOINT and their union is the whole set", () => {
    const rollup = rollupCoachingFindings(activeCoaching, allVisible);
    const homed = findingsForDashboardHome(activeCoaching, "data-quality");
    const rollupKeys = rollup.map((f) => f.dedupeKey);
    const homedKeys = homed.map((f) => f.dedupeKey);
    expect(rollupKeys.some((k) => homedKeys.includes(k))).toBe(false);
    expect([...rollupKeys, ...homedKeys].sort()).toEqual(
      activeCoaching.map((f) => f.dedupeKey).sort()
    );
    // The rollup's own count is its length — "N patterns worth reviewing" can no
    // longer be inflated by rows rendered in the other card.
    expect(rollup.length).toBe(2);
  });

  it("nothing is lost when the home widget is hidden — the rollup is the catch-all", () => {
    const rollup = rollupCoachingFindings(
      activeCoaching,
      visibleExcept("data-quality")
    );
    expect(rollup.map((f) => f.dedupeKey).sort()).toEqual(
      activeCoaching.map((f) => f.dedupeKey).sort()
    );
  });

  it("an unregistered family always lands in the rollup, whatever is visible", () => {
    const findings = [{ dedupeKey: "adherence:vitamin-d" }];
    expect(rollupCoachingFindings(findings, allVisible)).toHaveLength(1);
    expect(findingsForDashboardHome(findings, "data-quality")).toHaveLength(0);
  });

  it("the capped slice and its overflow are computed over the rollup's own set", () => {
    // The #1219 disclosure must not be padded with rows already on screen: cap the
    // filtered set, never activeCoaching.
    const rollup = rollupCoachingFindings(activeCoaching, allVisible);
    const { shown, overflow } = capDashboardList(rollup, 1);
    expect(shown).toHaveLength(1);
    expect(overflow).toHaveLength(1);
    expect([...shown, ...overflow]).toHaveLength(rollup.length);
  });
});
