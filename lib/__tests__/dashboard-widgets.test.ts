import { describe, it, expect } from "vitest";
import {
  DASHBOARD_WIDGETS,
  resolveWidgets,
  resolveWidgetList,
  type DashboardLayout,
} from "../dashboard-widgets";

const ids = (ws: { id: string }[]) => ws.map((w) => w.id);
const defaultOnIds = DASHBOARD_WIDGETS.filter((w) => w.defaultOn).map(
  (w) => w.id
);
const fitnessIds = DASHBOARD_WIDGETS.filter((w) => w.fitness).map((w) => w.id);

describe("resolveWidgets / resolveWidgetList", () => {
  it("null layout → default-on widgets in registry order", () => {
    const visible = resolveWidgets(null, false);
    expect(ids(visible)).toEqual(defaultOnIds);
  });

  it("null layout → full list (visible + hidden) is every widget in registry order", () => {
    const list = resolveWidgetList(null, false);
    expect(list.map((w) => w.def.id)).toEqual(
      DASHBOARD_WIDGETS.map((w) => w.id)
    );
    // visibility follows defaultOn for a fresh profile
    for (const item of list) {
      expect(item.visible).toBe(item.def.defaultOn);
    }
  });

  it("stored order with a removed/unknown id → that id is dropped, rest preserved", () => {
    const layout: DashboardLayout = {
      order: ["weight-trend", "does-not-exist", "quick-stats"],
      hidden: [],
    };
    const visible = resolveWidgets(layout, false);
    expect(ids(visible)).not.toContain("does-not-exist");
    // stored order honored for the ids it lists
    expect(visible[0].id).toBe("weight-trend");
    expect(visible[1].id).toBe("quick-stats");
  });

  it("registry widget missing from stored order → appended honoring defaultOn", () => {
    // A layout that only mentions one widget; everything else is "new" to it.
    const layout: DashboardLayout = { order: ["quick-stats"], hidden: [] };
    const list = resolveWidgetList(layout, false);
    // quick-stats leads, appended ids follow in registry order
    expect(list[0].def.id).toBe("quick-stats");
    const appended = list.slice(1).map((w) => w.def.id);
    const expectedAppended = DASHBOARD_WIDGETS.map((w) => w.id).filter(
      (id) => id !== "quick-stats"
    );
    expect(appended).toEqual(expectedAppended);
    // an off-by-default widget the layout has never seen stays hidden
    const lowSupply = list.find((w) => w.def.id === "low-supply")!;
    expect(lowSupply.visible).toBe(false);
    // an on-by-default widget the layout has never seen shows
    const starred = list.find((w) => w.def.id === "starred-biomarkers")!;
    expect(starred.visible).toBe(true);
  });

  it("hidden id → not visible but still present in the full list", () => {
    const layout: DashboardLayout = {
      order: DASHBOARD_WIDGETS.map((w) => w.id),
      hidden: ["quick-stats"],
    };
    const visible = resolveWidgets(layout, false);
    expect(ids(visible)).not.toContain("quick-stats");
    const list = resolveWidgetList(layout, false);
    const qs = list.find((w) => w.def.id === "quick-stats")!;
    expect(qs.visible).toBe(false);
  });

  it("explicitly enabling an off-by-default widget (in order, not hidden) makes it visible", () => {
    const layout: DashboardLayout = {
      order: ["low-supply", "quick-stats"],
      hidden: [],
    };
    const visible = resolveWidgets(layout, false);
    expect(ids(visible)).toContain("low-supply");
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
    expect(ids(visible)).toContain("quick-stats");
    expect(ids(visible)).toContain("weight-trend");
  });

  it("restricted → a stored order that references a fitness widget still drops it, keeps the rest ordered", () => {
    const layout: DashboardLayout = {
      order: ["streak", "weight-trend", "recent-activity", "quick-stats"],
      hidden: [],
    };
    const visible = resolveWidgets(layout, true);
    expect(ids(visible)).not.toContain("streak");
    expect(ids(visible)).not.toContain("recent-activity");
    // relative order of the surviving non-fitness ids preserved
    expect(ids(visible).indexOf("weight-trend")).toBeLessThan(
      ids(visible).indexOf("quick-stats")
    );
  });

  it("dedupes a stored order that repeats an id", () => {
    const layout: DashboardLayout = {
      order: ["quick-stats", "quick-stats", "weight-trend"],
      hidden: [],
    };
    const list = resolveWidgetList(layout, false);
    const occurrences = list.filter((w) => w.def.id === "quick-stats").length;
    expect(occurrences).toBe(1);
  });
});
