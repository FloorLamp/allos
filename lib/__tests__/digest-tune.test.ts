// PURE TIER (#1714) — the ⚙️ Tune vocabulary: the stored form, the toggle, the
// one-message-N-readers collapse, the notable predicates demotion reuses, and the
// keyboard the message renders.
//
// The rule every case here exists to hold: demotion reduces ROUTINE contact and can
// never reach a safety floor.

import { describe, it, expect } from "vitest";
import {
  DIGEST_TUNABLE_CATEGORIES,
  collapsedTuneAction,
  expandedTuneActions,
  intersectDigestDemotions,
  isDigestCategory,
  parseDigestDemotions,
  recentChangeDemotions,
  serializeDigestDemotions,
  sleepSurvivesDemotion,
  toggleDigestDemotion,
  tunableCategoriesFor,
  tuneToggleAnswer,
  type DigestCategory,
} from "@/lib/notifications/digest-tune";
import { parseTuneCallback } from "@/lib/notifications/callback-data";
import { applyRecentChangeDemotion } from "@/lib/recent-changes";
import { SLEEP_TYPICAL_BAND_MIN } from "@/lib/sleep-summary";

describe("the tunable category set (#1714)", () => {
  it("covers the collector's categories except labs, plus sleep", () => {
    expect(DIGEST_TUNABLE_CATEGORIES).toEqual([
      "visits",
      "growth",
      "intake",
      "vitals",
      "symptoms",
      "mood",
      "data",
      "sleep",
    ]);
  });

  it("labs is NOT tunable — every line it carries is floor class", () => {
    expect(isDigestCategory("labs")).toBe(false);
  });

  it("sleep is the digest's own section, so the collector never sees it", () => {
    expect(recentChangeDemotions(["vitals", "sleep", "mood"])).toEqual([
      "vitals",
      "mood",
    ]);
  });
});

describe("the stored form", () => {
  it("round-trips in declaration order, deduped", () => {
    expect(
      parseDigestDemotions(serializeDigestDemotions(["mood", "vitals", "mood"]))
    ).toEqual(["vitals", "mood"]);
  });

  it("nothing stored means nothing demoted", () => {
    expect(parseDigestDemotions(undefined)).toEqual([]);
    expect(parseDigestDemotions("")).toEqual([]);
  });

  it("DROPS a name that is not a tunable category", () => {
    // A retired or forged name must silence nothing — keeping it would resurrect the
    // preference if the name were ever reused.
    expect(parseDigestDemotions("mood,labs,activities, vitals ")).toEqual([
      "vitals",
      "mood",
    ]);
  });
});

describe("toggleDigestDemotion — the declared write", () => {
  it("adds then removes, and stays declaration-ordered", () => {
    const on = toggleDigestDemotion(["mood"], "vitals");
    expect(on).toEqual(["vitals", "mood"]);
    expect(toggleDigestDemotion(on, "vitals")).toEqual(["mood"]);
  });

  it("does not mutate the caller's list", () => {
    const before: DigestCategory[] = ["mood"];
    toggleDigestDemotion(before, "vitals");
    expect(before).toEqual(["mood"]);
  });
});

describe("intersectDigestDemotions — one message, N readers", () => {
  it("a single reader gets exactly what it declared", () => {
    expect(intersectDigestDemotions([["mood", "sleep"]])).toEqual([
      "mood",
      "sleep",
    ]);
  });

  it("demotes only what EVERY reader declared — nobody sees less than they asked", () => {
    expect(
      intersectDigestDemotions([
        ["mood", "sleep"],
        ["sleep", "vitals"],
      ])
    ).toEqual(["sleep"]);
  });

  it("no readers means nothing demoted, never everything", () => {
    expect(intersectDigestDemotions([])).toEqual([]);
  });

  it("one reader who declared nothing keeps the whole message", () => {
    expect(intersectDigestDemotions([["mood"], []])).toEqual([]);
  });
});

describe("the preference filter composed with the safety floor", () => {
  const routineVital = {
    id: "vitals:hr",
    category: "vitals" as const,
    text: "🩺 Resting HR 58",
    date: "2020-03-04",
  };
  const outOfRange = {
    id: "vitals:bp",
    category: "vitals" as const,
    text: "🩺 Blood Pressure Systolic 165 (high)",
    date: "2020-03-04",
    flagged: true,
  };

  it("demoted vitals + an out-of-range reading → SHOWN", () => {
    const kept = applyRecentChangeDemotion(
      [routineVital, outOfRange],
      new Set(recentChangeDemotions(["vitals"]))
    );
    expect(kept.map((c) => c.id)).toEqual(["vitals:bp"]);
  });

  it("demoted vitals + only routine readings → HIDDEN", () => {
    expect(
      applyRecentChangeDemotion(
        [routineVital],
        new Set(recentChangeDemotions(["vitals"]))
      )
    ).toEqual([]);
  });

  it("demoting a DIFFERENT category leaves vitals alone", () => {
    const kept = applyRecentChangeDemotion(
      [routineVital, outOfRange],
      new Set(recentChangeDemotions(["mood"]))
    );
    expect(kept).toHaveLength(2);
  });
});

describe("sleepSurvivesDemotion — the #1712 verdict, reused not re-derived", () => {
  const BASELINE = 420;

  it("undemoted sleep always survives, typical night or not", () => {
    expect(sleepSurvivesDemotion([], BASELINE, BASELINE)).toBe(true);
  });

  it("a demoted TYPICAL night stops", () => {
    expect(
      sleepSurvivesDemotion(
        ["sleep"],
        BASELINE + SLEEP_TYPICAL_BAND_MIN - 1,
        BASELINE
      )
    ).toBe(false);
  });

  it("a demoted notably LONG night still appears", () => {
    expect(
      sleepSurvivesDemotion(
        ["sleep"],
        BASELINE + SLEEP_TYPICAL_BAND_MIN,
        BASELINE
      )
    ).toBe(true);
  });

  it("a demoted notably SHORT night still appears", () => {
    expect(
      sleepSurvivesDemotion(
        ["sleep"],
        BASELINE - SLEEP_TYPICAL_BAND_MIN,
        BASELINE
      )
    ).toBe(true);
  });

  it("no baseline means no verdict, so the line reads as routine", () => {
    expect(sleepSurvivesDemotion(["sleep"], 300, null)).toBe(false);
  });
});

describe("the keyboard", () => {
  const PROFILE = 7;
  const DATE = "2020-03-04";

  it("collapsed is one button and costs nothing until used", () => {
    const a = collapsedTuneAction(PROFILE, DATE);
    expect(a.label).toBe("⚙️ Tune");
    expect(a.data).toBe(`tune:${PROFILE}:${DATE}`);
  });

  it("expanded shows state per category and ends with Done", () => {
    const actions = expandedTuneActions(
      PROFILE,
      DATE,
      ["mood", "vitals"],
      ["mood"]
    );
    expect(actions.map((a) => a.label)).toEqual([
      "🔔 Vitals",
      "🔕 Check-in",
      "▲ Done",
    ]);
    expect(actions[1].data).toBe(`tunet:${PROFILE}:${DATE}:mood`);
    expect(actions.at(-1)?.data).toBe(`tunec:${PROFILE}:${DATE}`);
  });

  it("category buttons pair up per row; Done keeps its own", () => {
    const rows = expandedTuneActions(
      PROFILE,
      DATE,
      ["visits", "intake", "mood"],
      []
    ).map((a) => a.row);
    expect(rows).toEqual(["tune-0", "tune-0", "tune-1", "digest-tune"]);
  });

  it("offers today's categories PLUS anything already demoted, so a demotion stays reversible", () => {
    expect(tunableCategoriesFor(["mood"], ["sleep"])).toEqual([
      "mood",
      "sleep",
    ]);
  });

  it("the answer states the consequence, including what still gets through", () => {
    expect(tuneToggleAnswer("vitals", true)).toContain("out-of-range");
    expect(tuneToggleAnswer("vitals", false)).toContain("every digest");
  });
});

describe("parseTuneCallback", () => {
  it("parses the three token shapes", () => {
    expect(parseTuneCallback("tune:7:2020-03-04")).toEqual({
      profileId: 7,
      date: "2020-03-04",
      action: "expand",
      category: null,
    });
    expect(parseTuneCallback("tunec:7:2020-03-04")).toEqual({
      profileId: 7,
      date: "2020-03-04",
      action: "collapse",
      category: null,
    });
    expect(parseTuneCallback("tunet:7:2020-03-04:sleep")).toEqual({
      profileId: 7,
      date: "2020-03-04",
      action: "toggle",
      category: "sleep",
    });
  });

  it("rejects a toggle naming an untunable or unknown category", () => {
    expect(parseTuneCallback("tunet:7:2020-03-04:labs")).toBeNull();
    expect(parseTuneCallback("tunet:7:2020-03-04:nonsense")).toBeNull();
    expect(parseTuneCallback("tunet:7:2020-03-04")).toBeNull();
  });

  it("rejects malformed and foreign tokens", () => {
    expect(parseTuneCallback("tune:0:2020-03-04")).toBeNull();
    expect(parseTuneCallback("tune:7:")).toBeNull();
    expect(parseTuneCallback("offer:7:2020-03-04")).toBeNull();
    expect(parseTuneCallback(42)).toBeNull();
  });
});
