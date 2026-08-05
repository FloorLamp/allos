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

  it("promotes measurements on Trends' BODY tab only — the tab is the rule, not the route", () => {
    // #1644: the body census moved to the DEFAULT tab, so a paramless /trends now
    // carries the measurements form…
    expect(primaryQuickLog("/trends").id).toBe("log-measurements");
    expect(primaryQuickLog("/trends", "overview").id).toBe("log-measurements");
    // …and the retired names that resolve to that same default answer the same way,
    // without a shim of their own.
    expect(primaryQuickLog("/trends", "body").id).toBe("log-measurements");
    expect(primaryQuickLog("/trends", "vitals").id).toBe("log-measurements");
    // The surviving tabs are unchanged: neither is a measurements surface.
    expect(primaryQuickLog("/trends", "fitness").id).toBe(LOG_ACTIVITY_ID);
    expect(primaryQuickLog("/trends", "nutrition").id).toBe(LOG_ACTIVITY_ID);
    expect(primaryQuickLog("/trends", "insights").id).toBe(LOG_ACTIVITY_ID);
    // A metric detail page is under the hub with no tab of its own, so it resolves
    // to the default view's action.
    expect(primaryQuickLog("/trends/metric/weight").id).toBe(
      "log-measurements"
    );
    // …but a route that merely starts with the same letters is not the hub.
    expect(primaryQuickLog("/trendsetter").id).toBe(LOG_ACTIVITY_ID);
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
    expect(showsActivityShortcuts(primaryQuickLog("/trends"))).toBe(false);
  });
});

describe("quickLogMenu", () => {
  it("lists every action for a training-capable profile", () => {
    expect(quickLogMenu(false).map((i) => i.id)).toEqual([
      "log-activity",
      "log-food",
      "log-dose",
      // ONE measurements row (#1486/#1506): weight and vitals were two sheet rows
      // because they were two forms on two Trends tabs. They are one form now, so
      // a second row would just be a second door onto the same fields.
      "log-measurements",
      // #1633 — the web catching up to the Telegram bot's one-tap practice log.
      "log-practice",
      // #1892 — the missing logging path. Period day 1 is the app's most
      // time-sensitive log (both the phase derivation and the regularity data
      // depend on catching it), and the sheet had no entry for it at all.
      "log-period",
      // #1525 — the one non-log row: filing a document, the in-app twin of the
      // share target. Last, because it is the odd verb out.
      "add-document",
    ]);
  });

  it("drops the training-only entries for an age-restricted profile", () => {
    const ids = quickLogMenu(true).map((i) => i.id);
    expect(ids).not.toContain(LOG_ACTIVITY_ID);
    expect(ids).toEqual([
      "log-food",
      "log-dose",
      "log-measurements",
      "log-practice",
      "log-period",
      "add-document",
    ]);
  });

  // Issue #1892 — the cycle relevance gate, the SAME `cycle` bit as the Cycle nav
  // entry and the dashboard phase widget.
  it("drops the period row for a profile where cycle tracking is irrelevant", () => {
    const ids = quickLogMenu(false, false).map((i) => i.id);
    expect(ids).not.toContain("log-period");
    // Nothing else moves — the gate is per-entry, not a mode.
    expect(ids).toEqual([
      LOG_ACTIVITY_ID,
      "log-food",
      "log-dose",
      "log-measurements",
      "log-practice",
      "add-document",
    ]);
  });

  it("defaults to SHOWING the period row, so an unthreaded caller never over-hides", () => {
    // The DEFAULT_NAV_RELEVANCE posture: a surface that hasn't resolved the bitset
    // must not hide a row the profile is entitled to.
    expect(quickLogMenu(false).map((i) => i.id)).toContain("log-period");
  });

  it("applies BOTH gates at once", () => {
    const ids = quickLogMenu(true, false).map((i) => i.id);
    expect(ids).not.toContain(LOG_ACTIVITY_ID);
    expect(ids).not.toContain("log-period");
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
    expect(forms).toEqual([
      "food",
      "dose",
      "measurements",
      "practice",
      "cycle",
      "document",
    ]);
  });

  it("opens the measurements form as an overlay, not the old focus-param deep link", () => {
    expect(quickLogItem("log-measurements").target).toEqual({
      kind: "overlay",
      form: "measurements",
    });
  });

  it("falls back to Log activity for an unknown id", () => {
    expect(quickLogItem("nope").id).toBe(LOG_ACTIVITY_ID);
  });

  it("carries exactly ONE document row, opening the shared upload form (#1525)", () => {
    const documents = QUICK_LOG_ITEMS.filter(
      (i) => i.target.kind === "overlay" && i.target.form === "document"
    );
    expect(documents.map((i) => i.id)).toEqual(["add-document"]);
    expect(quickLogItem("add-document").target).toEqual({
      kind: "overlay",
      form: "document",
    });
    // Subject-bound media (a form-check video, a symptom photo, a lesion photo) is
    // deliberately NOT here: each needs a subject, so a global entry point would have
    // to ask "what is this of?" — worse than starting from the subject. A medical
    // document is the one whose subject the extraction figures out.
    const forms = QUICK_LOG_ITEMS.flatMap((i) =>
      i.target.kind === "overlay" ? [i.target.form] : []
    );
    expect(forms).not.toContain("photo");
    expect(forms).not.toContain("video");
  });

  it("promotes NEITHER the document nor the practice row on any route (#1525/#1633)", () => {
    // The promotion map stays deliberately short: a page whose own screen already
    // carries the form buys nothing by spending the bar's one slot on it (the same
    // reasoning that keeps Nutrition → Supplements from claiming it). Data shows the
    // upload form on arrival; Wellness shows a Log-now button per practice card.
    for (const path of [
      "/",
      "/data",
      "/wellness",
      "/timeline",
      "/nutrition",
      "/medications",
      "/trends",
      "/longevity",
      "/upcoming",
      "/settings",
    ]) {
      expect(primaryQuickLog(path).id, path).not.toBe("add-document");
      expect(primaryQuickLog(path).id, path).not.toBe("log-practice");
    }
  });
});

// ---- The time-semantic completeness guard (issue #2019 §7) ----
//
// Two features needed eating time and both routed around the food ledger, because
// nothing said what a one-tap log's TIME meant. This is the declaration that stops a new
// quick-log entry from shipping without answering — the RECONCILE_PREFIXES discipline,
// one registry over.
describe("quick-log time semantics (#2019 §7)", () => {
  it("every entry declares a semantic with a written reason", () => {
    for (const item of QUICK_LOG_ITEMS) {
      expect(["instant", "day-only"], item.id).toContain(item.time.semantic);
      // A reason, not a placeholder: the point is that "we decided against it" and
      // "nobody looked" stay distinguishable a year from now.
      expect(item.time.why.length, item.id).toBeGreaterThan(40);
    }
  });

  it("an `instant` entry names its correction unit; a `day-only` one has none", () => {
    for (const item of QUICK_LOG_ITEMS) {
      if (item.time.semantic === "instant") {
        expect(["hour", "day"], item.id).toContain(item.time.chipUnit);
      } else {
        expect(item.time.chipUnit, item.id).toBeUndefined();
      }
    }
  });

  it("food and dose are the two `instant` logs #2019/#2020 built the capture for", () => {
    const byId = new Map(QUICK_LOG_ITEMS.map((i) => [i.id, i]));
    expect(byId.get("log-food")!.time).toMatchObject({
      semantic: "instant",
      chipUnit: "hour",
    });
    expect(byId.get("log-dose")!.time).toMatchObject({
      semantic: "instant",
      chipUnit: "hour",
    });
    // Practice is the DELIBERATE non-extension: day-granular by design, and nothing
    // reads an instant, so capturing one would invite a consumer to invent a meaning.
    expect(byId.get("log-practice")!.time.semantic).toBe("day-only");
  });
});
