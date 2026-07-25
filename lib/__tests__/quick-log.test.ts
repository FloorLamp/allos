import { describe, expect, it } from "vitest";
import {
  LOG_ACTIVITY_ID,
  QUICK_LOG_ITEMS,
  primaryQuickLog,
  quickLogItem,
  quickLogMenu,
  showsActivityShortcuts,
} from "@/lib/quick-log";

// The mobile bar's contextual primary action + the quick-log sheet's menu
// (issue #1416, sections B and E).

describe("primaryQuickLog", () => {
  it("falls back to Log activity — the bar's historical behavior — everywhere", () => {
    for (const path of ["/", "/timeline", "/training", "/settings", "/data"]) {
      expect(primaryQuickLog(path).id).toBe(LOG_ACTIVITY_ID);
    }
  });

  it("promotes food on Nutrition, on both tabs", () => {
    expect(primaryQuickLog("/nutrition").id).toBe("log-food");
    expect(primaryQuickLog("/nutrition", "food").id).toBe("log-food");
    expect(primaryQuickLog("/nutrition", "supplements").id).toBe("log-food");
  });

  it("promotes dose on Medications, including its child routes", () => {
    expect(primaryQuickLog("/medications").id).toBe("log-dose");
    expect(primaryQuickLog("/medications/print").id).toBe("log-dose");
  });

  it("promotes weight on Trends' BODY tab only — the tab is the rule, not the route", () => {
    expect(primaryQuickLog("/trends", "body").id).toBe("log-weight");
    expect(primaryQuickLog("/trends", "fitness").id).toBe(LOG_ACTIVITY_ID);
    expect(primaryQuickLog("/trends").id).toBe(LOG_ACTIVITY_ID);
  });

  it("never claims a route by bare string prefix", () => {
    // A future /medications-archive must not inherit the medication primary.
    expect(primaryQuickLog("/medications-archive").id).toBe(LOG_ACTIVITY_ID);
    expect(primaryQuickLog("/nutritionix").id).toBe(LOG_ACTIVITY_ID);
  });
});

describe("showsActivityShortcuts", () => {
  it("shows the live-workout/repeat pair only where the primary IS the editor", () => {
    expect(showsActivityShortcuts(primaryQuickLog("/"))).toBe(true);
    expect(showsActivityShortcuts(primaryQuickLog("/nutrition"))).toBe(false);
    expect(showsActivityShortcuts(primaryQuickLog("/medications"))).toBe(false);
    expect(showsActivityShortcuts(primaryQuickLog("/trends", "body"))).toBe(
      false
    );
  });
});

describe("quickLogMenu", () => {
  it("lists every action for a training-capable profile", () => {
    expect(quickLogMenu(false).map((i) => i.id)).toEqual([
      "log-activity",
      "log-food",
      "log-dose",
      "log-weight",
    ]);
  });

  it("drops the training-only entries for an age-restricted profile", () => {
    const ids = quickLogMenu(true).map((i) => i.id);
    expect(ids).not.toContain(LOG_ACTIVITY_ID);
    expect(ids).toEqual(["log-food", "log-dose", "log-weight"]);
  });
});

describe("the registry itself", () => {
  it("has unique ids and a label + hint on every entry", () => {
    const ids = QUICK_LOG_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of QUICK_LOG_ITEMS) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.hint.length).toBeGreaterThan(0);
    }
  });

  it("opens the activity editor in place and navigates for everything else", () => {
    // The whole point of section E: no new write paths. Every non-activity entry
    // is a link to a form that already exists.
    for (const item of QUICK_LOG_ITEMS) {
      if (item.id === LOG_ACTIVITY_ID) {
        expect(item.target.kind).toBe("activity");
      } else {
        expect(item.target.kind).toBe("navigate");
      }
    }
  });

  it("reuses the palette's focus-param convention for the weight form", () => {
    const weight = quickLogItem("log-weight");
    expect(weight.target).toEqual({
      kind: "navigate",
      href: "/trends?tab=body&new=weight",
    });
  });

  it("falls back to Log activity for an unknown id", () => {
    expect(quickLogItem("nope").id).toBe(LOG_ACTIVITY_ID);
  });
});
