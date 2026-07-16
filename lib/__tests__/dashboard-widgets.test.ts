import { describe, it, expect } from "vitest";
import {
  DASHBOARD_WIDGETS,
  customizableWidgetDefs,
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

describe("dashboardGoalsHabitsLayout", () => {
  it("splits only when both goals and habits are present", () => {
    expect(dashboardGoalsHabitsLayout(true, true)).toBe("split");
    expect(dashboardGoalsHabitsLayout(true, false)).toBe("full");
    expect(dashboardGoalsHabitsLayout(false, true)).toBe("full");
  });
});
