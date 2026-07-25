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
      // Issue #1467: vitals is a manual logger's most frequent daily write and
      // its only entry points were mid-page on a secondary surface.
      "log-vitals",
    ]);
  });

  it("drops the training-only entries for an age-restricted profile", () => {
    const ids = quickLogMenu(true).map((i) => i.id);
    expect(ids).not.toContain(LOG_ACTIVITY_ID);
    expect(ids).toEqual(["log-food", "log-dose", "log-weight", "log-vitals"]);
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

  it("opens every entry IN PLACE — navigation is not a quick-log outcome", () => {
    // The #1468 rule. The sheet used to be two-tier: activity opened its editor
    // in place while food/dose/weight were router.pushes, so a sheet promising
    // "log from anywhere" left you on the Nutrition page. Every entry now opens
    // an overlay (the activity editor keeps its own kind — it is the DOCK, a
    // session lifecycle, deliberately not a discardable sheet).
    for (const item of QUICK_LOG_ITEMS) {
      if (item.id === LOG_ACTIVITY_ID) {
        expect(item.target.kind).toBe("activity");
      } else {
        expect(item.target.kind).toBe("overlay");
      }
    }
  });

  it("ships ZERO navigate targets in the sheet, at every profile gate", () => {
    // `{kind:"navigate"}` stays in the union for the CommandPalette (the desktop
    // keyboard flow may keep navigating in v1 — a separate decision), so the
    // type alone can't hold this line. The registry has to.
    for (const restricted of [false, true]) {
      for (const item of quickLogMenu(restricted)) {
        expect(item.target.kind).not.toBe("navigate");
      }
    }
  });

  it("names an existing quick-add form for each overlay entry", () => {
    // No new write paths: each form key resolves to a component the app already
    // mounts on a page (components/QuickEntryProvider.tsx owns the map).
    const forms = QUICK_LOG_ITEMS.flatMap((i) =>
      i.target.kind === "overlay" ? [i.target.form] : []
    );
    expect(forms).toEqual(["food", "dose", "weight", "vitals"]);
  });

  it("opens the weight form as an overlay, not the old focus-param deep link", () => {
    expect(quickLogItem("log-weight").target).toEqual({
      kind: "overlay",
      form: "weight",
    });
  });

  it("falls back to Log activity for an unknown id", () => {
    expect(quickLogItem("nope").id).toBe(LOG_ACTIVITY_ID);
  });
});
