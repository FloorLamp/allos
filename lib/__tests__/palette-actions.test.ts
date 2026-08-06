import { describe, it, expect } from "vitest";
import {
  PALETTE_ACTIONS,
  matchPaletteActions,
  FOCUS_PARAM,
} from "@/lib/palette-actions";
import { quickLogItem } from "@/lib/quick-log";
import { deepLinkGroup } from "@/lib/measurements-deeplink";

describe("palette create actions", () => {
  it("returns every action for an empty query", () => {
    expect(matchPaletteActions("")).toHaveLength(PALETTE_ACTIONS.length);
    expect(matchPaletteActions("   ")).toHaveLength(PALETTE_ACTIONS.length);
  });

  it("matches on the label", () => {
    // "workout" is a substring of both "Log workout" and "Start workout" (#340).
    const ids = matchPaletteActions("workout").map((a) => a.id);
    expect(ids).toEqual(["log-workout", "start-workout"]);
    // The more specific labels disambiguate.
    expect(matchPaletteActions("log workout").map((a) => a.id)).toEqual([
      "log-workout",
    ]);
    expect(matchPaletteActions("start").map((a) => a.id)).toEqual([
      "start-workout",
    ]);
  });

  it("offers a live 'Start workout' action (#340)", () => {
    const live = PALETTE_ACTIONS.find((a) => a.id === "start-workout");
    expect(live?.target.kind).toBe("live");
    // Reachable by its in-gym keywords.
    expect(matchPaletteActions("rest timer").map((a) => a.id)).toEqual([
      "start-workout",
    ]);
  });

  it("matches on keywords, case-insensitively", () => {
    expect(matchPaletteActions("gym").map((a) => a.id)).toEqual([
      "log-workout",
    ]);
    // "lab" is genuinely two intentions — a structured biomarker record and the PDF
    // that reported it — and a SEARCH surface should offer both rather than pick for
    // the user (#1506/#1525). Registry order decides which is listed first.
    expect(matchPaletteActions("LAB").map((a) => a.id)).toEqual([
      "add-document",
      "add-biomarker",
    ]);
    expect(matchPaletteActions("doctor").map((a) => a.id)).toEqual([
      "add-appointment",
    ]);
  });

  it("returns nothing for an unrelated query", () => {
    expect(matchPaletteActions("zzzzz")).toEqual([]);
  });

  it("offers a repeat-last action that matches 'again' but not 'workout' (#337)", () => {
    expect(matchPaletteActions("again").map((a) => a.id)).toEqual([
      "repeat-last",
    ]);
    // The repeat action must not collide with the workout-label matches.
    expect(matchPaletteActions("workout").map((a) => a.id)).toEqual([
      "log-workout",
      "start-workout",
    ]);
    const repeat = PALETTE_ACTIONS.find((a) => a.id === "repeat-last");
    expect(repeat?.target.kind).toBe("repeat");
  });

  it("keeps the practice entry available before the relevance-gated nav appears (#1620)", () => {
    const wellness = PALETTE_ACTIONS.find(
      (action) => action.id === "wellness-practices"
    );
    // The label is the sheet row's label and the target is the sheet row's target
    // (#2184): one string and ONE encoding of "open the practice overlay", never a
    // palette-only journey to drift from the sheet's.
    const sheetRow = quickLogItem("log-practice");
    expect(wellness?.label).toBe(sheetRow.label);
    expect(wellness?.target).toEqual(sheetRow.target);
    // Still findable by every word the old label answered to.
    for (const query of ["wellness", "meditation", "practice", "sauna"]) {
      expect(
        matchPaletteActions(query).map((a) => a.id),
        query
      ).toContain("wellness-practices");
    }
  });

  it("opens the merged measurements form in place, grouped by the pick's intent (#2184)", () => {
    // "Log weight" and "Log vitals" predate the #1486 merge and used to
    // hard-navigate mid-Trends; both now open the SAME overlay form the sheet's
    // one "Log measurements" row opens, differing only in the group the pick
    // implies (#2014's context rule).
    const sheetTarget = quickLogItem("log-measurements").target;
    for (const [id, created] of [
      ["log-weight", "weight"],
      ["log-vitals", "vitals"],
    ] as const) {
      const action = PALETTE_ACTIONS.find((a) => a.id === id);
      expect(action?.target.kind, id).toBe("overlay");
      if (action?.target.kind !== "overlay" || sheetTarget.kind !== "overlay") {
        throw new Error("narrowed above");
      }
      expect(action.target.form, id).toBe(sheetTarget.form);
      // The group is pinned against the ONE field→group table the deep links
      // resolve through — the palette pick and the historical `?new=` link mean
      // the same field, so they must open the same group.
      expect(action.target.prefill, id).toEqual({
        measurementGroup: deepLinkGroup(null, created),
      });
    }
  });

  it("navigates ONLY where no drawer form exists (#2184)", () => {
    // The residual navigate set is a product fact, not an accident: appointment,
    // progress photo, and biomarker record have no quick-entry drawer form (a
    // biomarker quick form would be its own product decision). A new navigate
    // entry showing up here should have to argue it isn't drift.
    const navigate = PALETTE_ACTIONS.filter(
      (a) => a.target.kind === "navigate"
    );
    expect(navigate.map((a) => a.id).sort()).toEqual([
      "add-appointment",
      "add-biomarker",
      "add-progress-photo",
    ]);
  });

  it("has exactly one in-place activity action; the rest navigate with the focus param", () => {
    const activity = PALETTE_ACTIONS.filter(
      (a) => a.target.kind === "activity"
    );
    expect(activity.map((a) => a.id)).toEqual(["log-workout"]);
    for (const a of PALETTE_ACTIONS) {
      if (a.target.kind === "navigate") {
        expect(a.target.href).toContain(`${FOCUS_PARAM}=`);
      }
    }
  });

  it("reaches the ONE document overlay by every word for it (#1525)", () => {
    // The browse surface (the sheet) carries one row; the search surface carries as
    // many verbs as people actually type — all resolving to the SAME overlay form, so
    // neither surface owns a form of its own.
    for (const query of [
      "upload",
      "scan",
      "document",
      "lab report",
      "pdf",
      "photo of a result",
      "after-visit summary",
    ]) {
      expect(
        matchPaletteActions(query).map((a) => a.id),
        query
      ).toContain("add-document");
    }
    const doc = PALETTE_ACTIONS.find((a) => a.id === "add-document");
    expect(doc?.target).toEqual({ kind: "overlay", form: "document" });
    // The same target the quick-log registry's row carries — one encoding of "open
    // this form", not one per surface.
    expect(doc?.target).toEqual(quickLogItem("add-document").target);
  });
});
