// PURE TIER — the one logging manifest (#4425).
//
// Most of this file's contract is not testable, and that is the point: completeness is
// a TYPE, so a missing domain, a missing column or an exclusion with no argument is a
// compile error rather than a red test. What is left is the part types cannot reach —
// that the bounded reaches did not MOVE, that the shared invariant means what it says,
// and that no argued reason is an empty string.

import { describe, it, expect } from "vitest";
import {
  LOG_DOMAINS,
  LOG_MANIFEST,
  TAP_REACH,
  isPastWriteAccepted,
} from "@/lib/log-manifest";
import {
  DOSE_LOG_DATE_WINDOW_DAYS,
  isDoseDateAccepted,
} from "@/lib/dose-log-window";
import { MOOD_LOG_DATE_WINDOW_DAYS, isMoodDateAccepted } from "@/lib/mood";
import { USUAL_BACKFILL_WINDOW_DAYS } from "@/lib/food-regularity";
import { ONE_TAP_AFFORDANCES } from "@/lib/one-tap";
import { shiftDateStr } from "@/lib/date";

const TODAY = "2026-08-31";

// WINDOWS BIND OFFERS, NOT DOMAINS (owner ruling 2026-08-31). The "byte-identical"
// pin therefore lives here, on the tap reaches, and not on any domain: dose ±2 is
// Telegram pointer retention, mood 2 is the day chips, practice 30 is the launcher's
// minDate, and the usual's 6 is the template offer's own evidence horizon.
describe("bounded tap reaches are byte-identical to what shipped", () => {
  it.each([
    ["dose-status", 2, 2],
    ["dose-day", 2, 2],
    ["dose-day-stack", 2, 2],
    ["mood-valence", 2, 0],
    ["practice-session", 30, 0],
    ["food-usual", USUAL_BACKFILL_WINDOW_DAYS, 0],
    ["routine-usual", USUAL_BACKFILL_WINDOW_DAYS, 0],
  ] as const)("%s reaches %s back and %s forward", (id, back, forward) => {
    expect(TAP_REACH[id]).toMatchObject({ kind: "bounded", back, forward });
  });

  it("the named constants read the declaration rather than restating it", () => {
    expect(DOSE_LOG_DATE_WINDOW_DAYS).toBe(2);
    expect(MOOD_LOG_DATE_WINDOW_DAYS).toBe(2);
    // Through the doors the tap cores actually call, at both edges.
    expect(isDoseDateAccepted(TODAY, shiftDateStr(TODAY, 2))).toBe(true);
    expect(isDoseDateAccepted(TODAY, shiftDateStr(TODAY, 3))).toBe(false);
    expect(isDoseDateAccepted(TODAY, shiftDateStr(TODAY, -2))).toBe(true);
    expect(isDoseDateAccepted(TODAY, shiftDateStr(TODAY, -3))).toBe(false);
    expect(isMoodDateAccepted(TODAY, shiftDateStr(TODAY, -2))).toBe(true);
    expect(isMoodDateAccepted(TODAY, shiftDateStr(TODAY, -3))).toBe(false);
    expect(isMoodDateAccepted(TODAY, shiftDateStr(TODAY, 1))).toBe(false);
  });

  // The reach record is keyed on the affordance registry, so a tap cannot ship
  // without an answer. The type says so; this says the two lists actually meet.
  it("every one-tap affordance declares a reach", () => {
    expect(Object.keys(TAP_REACH).sort()).toEqual(
      Object.keys(ONE_TAP_AFFORDANCES).sort()
    );
  });
});

describe("the shared core invariant: any real past day, never the future", () => {
  it.each([
    ["today", 0, true],
    ["yesterday", -1, true],
    ["a year back", -365, true],
    ["ten years back", -3650, true],
    ["tomorrow", 1, false],
  ])("%s: accepted=%s", (_label, delta, accepted) => {
    expect(isPastWriteAccepted(TODAY, shiftDateStr(TODAY, delta))).toBe(
      accepted
    );
  });

  // The hole the fold closed, kept dead by the ruling: `Date.parse` rolls 2026-02-30
  // forward to March 2 and answers a day-difference for it, so `isDoseDateAccepted`
  // and `isMoodDateAccepted` both accepted days the calendar does not have.
  it.each([["2026-02-30"], ["2026-04-31"], ["2026-13-45"], ["nope"], [""]])(
    "%s is not a day anything accepts",
    (day) => {
      expect(isPastWriteAccepted(TODAY, day)).toBe(false);
      expect(isDoseDateAccepted(TODAY, day)).toBe(false);
      expect(isMoodDateAccepted(TODAY, day)).toBe(false);
    }
  );
});

// The type requires a `reason` and a `ref`; it cannot require that the reason SAYS
// anything, which is the one gap a value check closes (`arguedExclusion` throws on
// the same input for the same reason).
describe("every argued absence argues", () => {
  it("no reason is blank and no ref is bare", () => {
    const blank: string[] = [];
    // Anything in the record MAY carry an argument; the ones that do must mean it.
    const check = (where: string, value: object): void => {
      const v = value as { reason?: string; ref?: string };
      if (v.reason === undefined) return;
      if (!v.reason.trim() || !/^#\d+$/.test(v.ref ?? "")) blank.push(where);
    };
    for (const domain of LOG_DOMAINS) {
      const entry = LOG_MANIFEST[domain];
      const arguable = [
        entry.statedTime,
        entry.offline,
        ...Object.values(entry.surfaces),
        ...Object.values(entry.pieces),
        entry.writeConventions,
      ];
      arguable.forEach((v, i) => check(`${domain}[${i}]`, v));
    }
    for (const [id, reach] of Object.entries(TAP_REACH)) check(id, reach);
    expect(blank).toEqual([]);
  });
});
