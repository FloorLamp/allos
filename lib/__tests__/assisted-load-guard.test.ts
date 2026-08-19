// THE INVERTED-LOAD CLASS GUARD (#1922) — the #1893 pattern applied to load
// semantics.
//
// An `assisted` movement's logged weight is a COUNTERWEIGHT: more of it means an
// easier set. Every consumer we have reads load as ASCENDING, so an assistance
// weight that reaches one un-flipped is wrong in the dangerous direction — a
// lifter who needed MORE help would be shown a personal record, a rising trend,
// and a better strength standing, all while getting weaker.
//
// This file is the enforcement layer, and it is deliberately a CLASS guard rather
// than a fixture: it enumerates the whole catalog and asserts the class-wide
// property of EVERY assisted lift in it. The next assisted movement someone adds
// is covered the moment it lands, which is the point — the failure mode being
// prevented is not "we got Assisted Pull Up wrong", it is "the ninth entry
// reintroduced the inversion and nobody noticed".
//
// Two independent halves are pinned:
//
//   1. THE SIGN. Every load fold routes through `effectiveLoadKg`, which subtracts
//      for `assisted`. So load, e1RM, volume and standings all FALL as assistance
//      rises. Pinned as a monotonicity property, over the catalog.
//   2. THE EXCLUSION. Assisted lifts mint no PR, no per-session record, no plateau
//      finding and no next-set target. That is the safe floor: even if a future
//      builder folded a raw load by hand, the claims that would announce it as
//      progress are closed.
//
// Every "excluded" assertion is paired with a CONTROL on the same shaped history
// for an `added` lift, so an empty result can never pass by being empty for the
// wrong reason.

import { describe, it, expect } from "vitest";
import {
  ALL_LIFT_NAMES,
  assistedBaseLift,
  effectiveLoadKg,
  isAssisted,
  isBodyweight,
  liftInfo,
  loadKindOf,
} from "@/lib/lifts";
import {
  lastSessionPR,
  recentPRs,
  strengthSessionRecords,
  suggestNextSet,
  type ExerciseSummary,
} from "@/lib/coaching";
import { detectPlateaus, type E1rmSeries } from "@/lib/training-observations";
import { estimate1RM } from "@/lib/strength";
import {
  strengthStanding,
  strengthStandingPercent,
} from "@/lib/strength-standards";

// Every assisted lift in the catalog. The guard's subject — computed, never listed,
// so it grows with the catalog.
const ASSISTED_LIFTS = ALL_LIFT_NAMES.filter(isAssisted);
// A representative `added` control for the paired assertions: a bodyweight lift, so
// the ONLY difference from an assisted subject is the load kind.
const ADDED_CONTROL = "Pull Up";

const BODYWEIGHT_KG = 80;
const TODAY = "2026-03-30";

// Four sessions of a lifter needing steadily MORE assistance — i.e. getting
// weaker. This is the history that used to read as a PR streak. Sized and dated to
// clear detectPlateaus' own admission bar (PLATEAU_MIN_POINTS points spanning at
// least PLATEAU_MIN_SPAN_DAYS, all inside the trailing window), so the exclusion
// below is the reason nothing fires rather than an under-populated series.
const RISING_ASSISTANCE = [
  { date: "2026-02-20", weightKg: 10 },
  { date: "2026-03-02", weightKg: 20 },
  { date: "2026-03-14", weightKg: 30 },
  { date: "2026-03-28", weightKg: 40 },
];

// The e1RM series a builder produces for `exercise` over those sessions, folded the
// one legal way (`effectiveLoadKg`). Same shape `getExerciseE1rmSeries` emits.
function seriesFor(exercise: string): E1rmSeries {
  return {
    exercise,
    points: RISING_ASSISTANCE.map((s) => ({
      date: s.date,
      value: estimate1RM(
        effectiveLoadKg(loadKindOf(exercise), BODYWEIGHT_KG, s.weightKg),
        5
      ),
      reps: 5,
    })),
  };
}

// An ExerciseSummary whose newest session is its all-time best — the exact shape
// that mints both a 1RM and a top-weight PR for an `added` lift.
function summaryFor(exercise: string): ExerciseSummary {
  const load = effectiveLoadKg(loadKindOf(exercise), BODYWEIGHT_KG, 20);
  return {
    exercise,
    sessions: 3,
    bodyweight: isBodyweight(exercise),
    e1rmKg: estimate1RM(load, 5),
    bestWeightKg: load,
    bestReps: 5,
    bestDate: TODAY,
    topWeightKg: load,
    topWeightDate: TODAY,
    lastDate: TODAY,
    lastSessionBest: { weightKg: load, reps: 5, targetReps: null },
  };
}

describe("assisted load — the catalog subject is non-empty and self-describing", () => {
  it("names at least one assisted movement (the guard has something to guard)", () => {
    expect(ASSISTED_LIFTS.length).toBeGreaterThan(0);
  });

  it("gives every assisted lift a base movement and bodyweight loading", () => {
    for (const name of ASSISTED_LIFTS) {
      // The load subtracts FROM something; without a bodyweight base there is
      // nothing to subtract from and the effective load collapses to zero.
      expect(isBodyweight(name), `${name} must be bodyweight-loaded`).toBe(true);
      // And it must say which movement it is a lighter execution of, or it can
      // never place on a standard.
      expect(assistedBaseLift(name), `${name} needs an assistedBase`).toBeTruthy();
    }
  });

  it("binds the NAME to the semantics: an 'Assisted …' entry declares loadKind", () => {
    // The naming-discipline half of the guard. A future "Assisted Chin Up" added
    // with the muscle map copied from Chin Up but no `loadKind` fails here, before
    // any of its loads reach a consumer.
    for (const name of ALL_LIFT_NAMES) {
      if (!/(?:^|\s)assisted(?:\s|$)/i.test(name)) continue;
      expect(loadKindOf(name), `${name} must declare loadKind "assisted"`).toBe(
        "assisted"
      );
      expect(liftInfo(name)?.loadKind).toBe("assisted");
    }
  });
});

describe("assisted load — the SIGN: load falls as assistance rises", () => {
  it("subtracts the logged weight for every assisted lift, and adds it otherwise", () => {
    for (const name of ASSISTED_LIFTS) {
      const kind = loadKindOf(name);
      expect(effectiveLoadKg(kind, 80, 0)).toBe(80);
      expect(effectiveLoadKg(kind, 80, 20)).toBe(60);
      expect(effectiveLoadKg(kind, 80, 40)).toBe(40);
      // Strictly decreasing across the whole logged range, not merely different.
      let prev = Infinity;
      for (let w = 0; w <= 80; w += 5) {
        const load = effectiveLoadKg(kind, 80, w);
        expect(load, `${name} at ${w} kg assistance`).toBeLessThan(prev);
        prev = load;
      }
      // Assistance past bodyweight is no load, never a negative one.
      expect(effectiveLoadKg(kind, 80, 120)).toBe(0);
    }
    // Control: the added kind runs the other way, so the property above is a
    // statement about assisted lifts and not about `effectiveLoadKg` in general.
    expect(effectiveLoadKg("added", 80, 20)).toBe(100);
  });

  it("never lets a standing IMPROVE as the lifter takes more assistance", () => {
    for (const name of ASSISTED_LIFTS) {
      if (!strengthStanding(name, 1, "male", BODYWEIGHT_KG)) continue; // no table
      const percents = [10, 20, 30, 40].map((assist) =>
        strengthStandingPercent(
          strengthStanding(
            name,
            estimate1RM(
              effectiveLoadKg(loadKindOf(name), BODYWEIGHT_KG, assist),
              5
            ),
            "male",
            BODYWEIGHT_KG
          )
        )
      );
      for (let i = 1; i < percents.length; i++) {
        expect(
          percents[i],
          `${name}: standing must not rise with assistance`
        ).toBeLessThan(percents[i - 1]!);
      }
    }
  });

  it("scores the assisted lift BELOW the same lifter's unassisted rep", () => {
    for (const name of ASSISTED_LIFTS) {
      const base = assistedBaseLift(name)!;
      const unassisted = strengthStanding(
        base,
        estimate1RM(BODYWEIGHT_KG, 5),
        "male",
        BODYWEIGHT_KG
      );
      if (!unassisted) continue; // base carries no table (Assisted Dip → Dip)
      const assisted = strengthStanding(
        name,
        estimate1RM(effectiveLoadKg("assisted", BODYWEIGHT_KG, 25), 5),
        "male",
        BODYWEIGHT_KG
      )!;
      // Placed against the SAME table as the movement it substitutes for…
      expect(assisted.lift).toBe(unassisted.lift);
      // …but identified by the exercise actually logged, so the evidence link
      // (#1921) still points at a row in this lifter's own history.
      expect(assisted.exercise).toBe(name);
      // …and lower on it, because 55 kg of system load is less than 80 kg.
      expect(assisted.e1rmKg).toBeLessThan(unassisted.e1rmKg);
      expect(strengthStandingPercent(assisted)!).toBeLessThan(
        strengthStandingPercent(unassisted)!
      );
    }
  });
});

describe("assisted load — the EXCLUSION: no ascending-load claim is made", () => {
  it("mints no personal record", () => {
    for (const name of ASSISTED_LIFTS) {
      expect(recentPRs([summaryFor(name)], TODAY), name).toEqual([]);
      expect(lastSessionPR(summaryFor(name)), name).toEqual({
        e1rm: false,
        weight: false,
      });
    }
    // Control: the identically shaped history DOES mint a record for an added
    // lift, so the empty lists above are the exclusion and not an inert fixture.
    expect(recentPRs([summaryFor(ADDED_CONTROL)], TODAY).length).toBeGreaterThan(
      0
    );
    expect(lastSessionPR(summaryFor(ADDED_CONTROL)).e1rm).toBe(true);
  });

  it("mints no per-session record standing", () => {
    const history = RISING_ASSISTANCE.map((s) => ({
      date: s.date,
      e1rmKg: estimate1RM(effectiveLoadKg("assisted", BODYWEIGHT_KG, s.weightKg), 5),
      e1rmReps: 5,
      topWeightKg: effectiveLoadKg("assisted", BODYWEIGHT_KG, s.weightKg),
    }));
    // A history whose LAST session is its best — the shape that classifies as an
    // all-time record. Under `added` semantics it does exactly that; naming the
    // same history assisted classifies nothing.
    const bestLast = [...history]
      .reverse()
      .map((h, i) => ({ ...h, date: RISING_ASSISTANCE[i].date }));
    const last = bestLast.length - 1;
    expect(strengthSessionRecords(bestLast, last, true, "added").e1rm).toBe(
      "all-time"
    );
    expect(
      strengthSessionRecords(bestLast, last, true, "assisted")
    ).toEqual({ e1rm: null, weight: null });
    // …and the real, rising-assistance history classifies nothing either way that
    // matters: its newest session is its WORST, so nothing to record.
    expect(strengthSessionRecords(history, last, true, "assisted")).toEqual({
      e1rm: null,
      weight: null,
    });
  });

  it("raises no plateau finding", () => {
    for (const name of ASSISTED_LIFTS) {
      expect(detectPlateaus([seriesFor(name)], TODAY), name).toEqual([]);
    }
    // Control: a FLAT series on an added lift is a plateau, so detectPlateaus is
    // demonstrably capable of firing on this shape.
    const flat: E1rmSeries = {
      exercise: ADDED_CONTROL,
      points: RISING_ASSISTANCE.map((s) => ({
        date: s.date,
        value: 100,
        reps: 5,
      })),
    };
    expect(detectPlateaus([flat], TODAY).length).toBeGreaterThan(0);
    // …and the same flat series under an assisted NAME raises nothing.
    for (const name of ASSISTED_LIFTS) {
      expect(detectPlateaus([{ ...flat, exercise: name }], TODAY), name).toEqual(
        []
      );
    }
  });

  it("suggests no next set", () => {
    for (const name of ASSISTED_LIFTS) {
      const s = summaryFor(name);
      expect(
        suggestNextSet({
          exercise: name,
          bodyweight: s.bodyweight,
          lastSessionBest: s.lastSessionBest,
        }),
        name
      ).toBeNull();
    }
    // Control: the same seed on an added bodyweight lift does suggest one.
    const control = summaryFor(ADDED_CONTROL);
    expect(
      suggestNextSet({
        exercise: ADDED_CONTROL,
        bodyweight: control.bodyweight,
        lastSessionBest: control.lastSessionBest,
      })
    ).not.toBeNull();
  });
});
