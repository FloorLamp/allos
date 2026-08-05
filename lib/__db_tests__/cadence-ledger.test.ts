// DB INTEGRATION TIER (issue #2034): the ONE cadence ledger over
// `frequency_targets`, exercised once per scope kind through the one reader.
//
// What the pure tier cannot see is asserted here:
//   • every FrequencyScopeKind counts through the registry's declared source and
//     grain — distinct training days, distinct mobilized days, summed servings,
//     distinct practice days, and the substance ledgers;
//   • the current-week rollup and the completed-week history are the SAME ledger
//     with the in-progress window in or out, so a suggestion can never disagree
//     with the card beside it;
//   • the substance week state and the weekly trend reproduce through the
//     `direction: "cap"` tenant, agreeing with each other on the current week;
//   • the direction selection is a DECLARATION, not a subtraction: no cap target
//     reaches a floor reader, and no floor target reaches a cap reader.
//
// Rolling week mode throughout, so a week window is exactly the trailing 7 days
// and every offset below reads as "N days ago".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setWeekMode } from "@/lib/settings";
import { CADENCE_SCOPES } from "@/lib/cadence";
import { FREQUENCY_SCOPE_KINDS } from "@/lib/goals";
import { practiceIdentity } from "@/lib/practice";
import {
  cadenceWindows,
  getCadenceLedger,
} from "@/lib/queries/cadence-ledger";
import {
  getFrequencyTargetProgress,
  getFrequencyTargetWeeklyHistory,
  getSubstanceWeekState,
  getSubstanceWeeklyTrend,
  logPracticeSession,
} from "@/lib/queries";

const NOW = new Date("2026-06-17T12:00:00Z");

function newProfile(name: string): number {
  const pid = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setWeekMode(pid, "rolling");
  return pid;
}

const dayBack = (pid: number, back: number) => shiftDateStr(today(pid), -back);

// `created_at` is set explicitly: the column defaults to SQLite's own
// `datetime('now')`, which the fake JS clock does not move, so a defaulted row
// would look younger than the window and trip the cold-start guard.
function makeTarget(
  pid: number,
  kind: string,
  value: string,
  perWeek: number,
  perWeekMax: number | null = null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO frequency_targets
           (profile_id, scope_kind, scope_value, scope_identity, per_week, per_week_max, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        pid,
        kind,
        value,
        kind === "practice" ? practiceIdentity(value) : null,
        perWeek,
        perWeekMax,
        `${dayBack(pid, 300)} 08:00:00`
      ).lastInsertRowid
  );
}

function logActivity(
  pid: number,
  date: string,
  type: string,
  components: string | null = null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, source, components)
         VALUES (?, ?, ?, 'Session', 'manual', ?)`
      )
      .run(pid, date, type, components).lastInsertRowid
  );
}

function logSet(pid: number, date: string, exercise: string): void {
  const activityId = logActivity(pid, date, "strength");
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
     VALUES (?, ?, 1, 60, 8)`
  ).run(activityId, exercise);
}

function logFood(pid: number, date: string, group: string, n: number): void {
  db.prepare(
    `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)
     ON CONFLICT (profile_id, date, group_key) DO UPDATE SET servings = servings + excluded.servings`
  ).run(pid, date, group, n);
}

describe("the cadence ledger (#2034)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- windows -------------------------------------------------------------

  it("walks the profile's OWN week windows, oldest first and contiguous", () => {
    const pid = newProfile("cl-windows");
    const history = cadenceWindows(pid, { weeks: 3, includeCurrent: false });
    expect(history).toHaveLength(3);
    // Rolling mode: the current window opens 6 days back, so the three completed
    // windows before it open 27, 20 and 13 days back.
    expect(history.map((w) => w.start)).toEqual([
      dayBack(pid, 27),
      dayBack(pid, 20),
      dayBack(pid, 13),
    ]);
    // Completed windows are full 7-day blocks; none of them contains today.
    for (const w of history) {
      expect(w.isCurrent).toBe(false);
      expect(w.elapsedDays).toBe(7);
      expect(w.end < today(pid)).toBe(true);
    }

    const withCurrent = cadenceWindows(pid, { weeks: 3, includeCurrent: true });
    expect(withCurrent[2]).toMatchObject({
      start: dayBack(pid, 6),
      end: today(pid),
      isCurrent: true,
      elapsedDays: 7, // rolling mode: the window is always fully elapsed
    });
    // The completed prefix of an includeCurrent read is the history read shifted
    // by one week — one definition of "week", not two.
    expect(withCurrent.slice(0, 2).map((w) => w.start)).toEqual([
      dayBack(pid, 20),
      dayBack(pid, 13),
    ]);
  });

  it("anchors on an arbitrary day, excluding that day's own week from a history read", () => {
    const pid = newProfile("cl-asof");
    const asOf = dayBack(pid, 30);
    const windows = cadenceWindows(pid, {
      weeks: 2,
      includeCurrent: false,
      asOf,
    });
    expect(windows[1].end).toBe(shiftDateStr(asOf, -7));
  });

  // ---- one gather per scope kind -------------------------------------------

  it("counts every scope kind through its declared source and grain", () => {
    const pid = newProfile("cl-scopes");
    // Two weeks back and one week back, so both completed windows carry events.
    const older = dayBack(pid, 10);
    const newer = dayBack(pid, 3);

    makeTarget(pid, "region", "Chest", 1);
    makeTarget(pid, "group", "Upper", 1);
    makeTarget(pid, "type", "cardio", 1);
    makeTarget(pid, "food_group", "vegetables", 5);
    makeTarget(pid, "mobility_region", "Glutes", 1);
    makeTarget(pid, "practice", "Sauna", 2);

    logSet(pid, older, "Bench Press");
    logSet(pid, newer, "Bench Press");
    logActivity(pid, newer, "cardio");
    // A multi-part activity credits its component types too.
    logActivity(
      pid,
      older,
      "sport",
      JSON.stringify([{ type: "cardio", name: "Row" }])
    );
    logFood(pid, older, "vegetables", 3);
    logFood(pid, newer, "vegetables", 2);
    logFood(pid, newer, "vegetables", 1); // same day, SUMMED not day-counted
    logActivity(
      pid,
      newer,
      "recovery",
      JSON.stringify([{ type: "recovery", name: "pigeon_pose" }])
    );
    logPracticeSession(pid, "Sauna", newer);
    logPracticeSession(pid, "Sauna", newer); // same day, DAY-distinct not summed

    const ledger = getCadenceLedger(pid, {
      weeks: 2,
      includeCurrent: true,
      direction: "floor",
    });
    const byScope = new Map(
      ledger.map((e) => [e.target.scope_kind, e.weeks.map((w) => w.count)])
    );

    // Week 0 is [13..7] days back, week 1 is the current [6..0] — `older` lands in
    // the first, `newer` in the second.
    expect(byScope.get("region")).toEqual([1, 1]);
    expect(byScope.get("group")).toEqual([1, 1]);
    expect(byScope.get("type")).toEqual([1, 1]);
    // SUM grain: three servings then three more, not "1 day then 1 day".
    expect(byScope.get("food_group")).toEqual([3, 3]);
    expect(byScope.get("mobility_region")).toEqual([0, 1]);
    // DISTINCT-DAYS grain: two sessions on one day is one day.
    expect(byScope.get("practice")).toEqual([0, 1]);
  });

  it("counts a body group's day ONCE however many of its regions it hit", () => {
    const pid = newProfile("cl-group");
    makeTarget(pid, "group", "Upper", 3);
    const day = dayBack(pid, 2);
    logSet(pid, day, "Bench Press");
    logSet(pid, day, "Barbell Row");
    const [entry] = getCadenceLedger(pid, {
      weeks: 1,
      includeCurrent: true,
      direction: "floor",
    });
    expect(entry.weeks[0].count).toBe(1);
  });

  // ---- the adapters are the same ledger ------------------------------------

  it("gives the current-week rollup and the history read the same counting rules", () => {
    const pid = newProfile("cl-adapters");
    makeTarget(pid, "practice", "Meditation", 3);
    for (const back of [17, 16, 10, 9, 8, 2, 1]) {
      logPracticeSession(pid, "Meditation", dayBack(pid, back));
    }

    const [progress] = getFrequencyTargetProgress(pid);
    expect(progress.count).toBe(2); // the two days inside the current window
    expect(progress.per_week).toBe(3);
    expect(progress.met).toBe(false);

    const [history] = getFrequencyTargetWeeklyHistory(pid, 2);
    expect(history.weeks.map((w) => w.count)).toEqual([2, 3]);
    // The in-progress week is absent from the history and present in the rollup —
    // the same ledger, one option apart.
    expect(history.weeks.some((w) => w.start === dayBack(pid, 6))).toBe(false);
    expect(history.existedWholeWindow).toBe(true);

    // The ledger read directly reproduces both.
    const withCurrent = getCadenceLedger(pid, {
      weeks: 3,
      includeCurrent: true,
      direction: "floor",
    })[0];
    expect(withCurrent.weeks[2].count).toBe(progress.count);
    expect(withCurrent.weeks[2].isCurrent).toBe(true);
  });

  it("carries the range ceiling through to the week's verdict", () => {
    const pid = newProfile("cl-range");
    makeTarget(pid, "practice", "Sauna", 2, 3);
    for (const back of [3, 2, 1]) logPracticeSession(pid, "Sauna", dayBack(pid, back));
    const [entry] = getCadenceLedger(pid, {
      weeks: 1,
      includeCurrent: true,
      direction: "floor",
    });
    expect(entry.weeks[0]).toMatchObject({ count: 3, verdict: "at-ceiling" });
    const [progress] = getFrequencyTargetProgress(pid);
    expect(progress.atCeiling).toBe(true);
    expect(progress.met).toBe(true);
  });

  // ---- the cap tenant ------------------------------------------------------

  it("reads substance caps as the cap-direction tenant of the SAME ledger", () => {
    const pid = newProfile("cl-cap");
    db.prepare(
      `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
       VALUES (?, 'substance', 'alcohol', ?)`
    ).run(pid, 4);
    logFood(pid, dayBack(pid, 10), "alcohol", 6);
    logFood(pid, dayBack(pid, 2), "alcohol", 2);
    logFood(pid, dayBack(pid, 1), "alcohol", 3);

    const [entry] = getCadenceLedger(pid, {
      weeks: 2,
      includeCurrent: true,
      direction: "cap",
    });
    expect(entry.direction).toBe("cap");
    expect(entry.weeks.map((w) => w.count)).toEqual([6, 5]);
    // Over the cap this week, over it the week before — and NEVER a floor verdict.
    expect(entry.weeks.map((w) => w.verdict)).toEqual(["over-cap", "over-cap"]);

    // The substance surfaces read the same tenant and agree on the current week.
    const state = getSubstanceWeekState(pid, "alcohol");
    expect(state.count).toBe(5);
    expect(state.weekStart).toBe(entry.weeks[1].start);
    expect(state.status).toMatchObject({ over: true, cap: 4, remaining: 0 });

    const trend = getSubstanceWeeklyTrend(pid, "alcohol", 2);
    expect(trend.map((w) => w.count)).toEqual([6, 5]);
    expect(trend[1]).toMatchObject({ isCurrent: true, count: state.count });
  });

  it("reads a counter-ledger substance from substance_log, per substance", () => {
    const pid = newProfile("cl-cap-units");
    db.prepare(
      `INSERT INTO substance_log (profile_id, date, substance, units) VALUES (?, ?, 'nicotine', 3)`
    ).run(pid, dayBack(pid, 2));
    db.prepare(
      `INSERT INTO substance_log (profile_id, date, substance, units) VALUES (?, ?, 'cannabis', 1)`
    ).run(pid, dayBack(pid, 2));
    expect(getSubstanceWeekState(pid, "nicotine").count).toBe(3);
    expect(getSubstanceWeekState(pid, "cannabis").count).toBe(1);
    // No cap set → no status, but the count is still reported.
    expect(getSubstanceWeekState(pid, "nicotine").status).toBeNull();
  });

  // ---- direction is declared, not subtracted -------------------------------

  it("selects tenants by DIRECTION, so neither reader sees the other's targets", () => {
    const pid = newProfile("cl-direction");
    makeTarget(pid, "practice", "Sauna", 2);
    db.prepare(
      `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
       VALUES (?, 'substance', 'alcohol', 4)`
    ).run(pid);

    const floors = getCadenceLedger(pid, {
      weeks: 1,
      includeCurrent: true,
      direction: "floor",
    });
    expect(floors.map((e) => e.target.scope_kind)).toEqual(["practice"]);
    const caps = getCadenceLedger(pid, {
      weeks: 1,
      includeCurrent: true,
      direction: "cap",
    });
    expect(caps.map((e) => e.target.scope_kind)).toEqual(["substance"]);

    // And the shipped floor readers inherit that selection.
    expect(
      getFrequencyTargetProgress(pid).map((p) => p.target.scope_kind)
    ).toEqual(["practice"]);
    expect(
      getFrequencyTargetWeeklyHistory(pid, 4).map((h) => h.target.scope_kind)
    ).toEqual(["practice"]);
  });

  it("registers a direction for every scope kind the CHECK enum allows", () => {
    for (const kind of FREQUENCY_SCOPE_KINDS) {
      expect(CADENCE_SCOPES[kind], kind).toBeDefined();
    }
  });

  // ---- the anchor clamp ----------------------------------------------------

  it("never lets a FUTURE-dated log fill the in-progress week", () => {
    const pid = newProfile("cl-future");
    makeTarget(pid, "practice", "Sauna", 2);
    logPracticeSession(pid, "Sauna", today(pid));
    logPracticeSession(pid, "Sauna", shiftDateStr(today(pid), 2));
    // Two rows, one countable day: a day that has not happened cannot mark a floor
    // met and silence its nudge.
    const [progress] = getFrequencyTargetProgress(pid);
    expect(progress.count).toBe(1);
    expect(progress.met).toBe(false);
  });
});
