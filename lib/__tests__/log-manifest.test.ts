// PURE TIER — the one logging manifest (#4425).
//
// Most of this file's contract is not testable, and that is the point: the record's
// completeness is a TYPE, so a missing domain, a missing column or an exclusion with
// no argument is a compile error rather than a red test. What is left for a test is
// the part types cannot reach — that the numbers did not MOVE (this issue relocates
// declarations and changes no window's size), that the reasons are not empty strings,
// and that the three predicates the domains used to own are now one computation.

import { describe, it, expect } from "vitest";
import {
  LOG_DOMAINS,
  LOG_MANIFEST,
  isLogDateAccepted,
  type LogDomain,
} from "@/lib/log-manifest";
import {
  DOSE_LOG_DATE_WINDOW_DAYS,
  isDoseDateAccepted,
} from "@/lib/dose-log-window";
import { MOOD_LOG_DATE_WINDOW_DAYS, isMoodDateAccepted } from "@/lib/mood";
import { shiftDateStr } from "@/lib/date";

const TODAY = "2026-08-31";

describe("window sizes are byte-identical to what shipped", () => {
  // Read off the tree before the fold: dose ±2 (lib/dose-log-window.ts), mood 2 back
  // past-only (lib/mood.ts), practice ±30 (lib/practice-log.ts), food and substance
  // not-future with an arbitrary past (#4118), body bounded only by `isRealIsoDate`,
  // stool today-only. Symptom is the one NEW bound and matches mood, which is the ruling.
  it.each([
    ["food", "unbounded", 0],
    ["dose", 2, 2],
    ["practice", 30, 30],
    ["mood", 2, 0],
    ["symptom", 2, 0],
    ["stool", 0, 0],
    ["substance", "unbounded", 0],
    ["body", "unbounded", "unbounded"],
  ] as [LogDomain, number | "unbounded", number | "unbounded"][])(
    "%s reaches %s back and %s forward",
    (domain, back, forward) => {
      expect(LOG_MANIFEST[domain].window).toMatchObject({ back, forward });
    }
  );

  it("the named predicates are the manifest's, not copies of it", () => {
    expect(DOSE_LOG_DATE_WINDOW_DAYS).toBe(2);
    expect(MOOD_LOG_DATE_WINDOW_DAYS).toBe(2);
    // `PRACTICE_LOG_DATE_WINDOW_DAYS` is not asserted here: lib/practice-log.ts opens
    // the database, and this tier is pure. Its value is a direct read of the row pinned
    // above, which typecheck holds.
    // Both directions at both edges, through the doors the cores actually call.
    expect(isDoseDateAccepted(TODAY, shiftDateStr(TODAY, 2))).toBe(true);
    expect(isDoseDateAccepted(TODAY, shiftDateStr(TODAY, 3))).toBe(false);
    expect(isDoseDateAccepted(TODAY, shiftDateStr(TODAY, -2))).toBe(true);
    expect(isDoseDateAccepted(TODAY, shiftDateStr(TODAY, -3))).toBe(false);
    expect(isMoodDateAccepted(TODAY, shiftDateStr(TODAY, -2))).toBe(true);
    expect(isMoodDateAccepted(TODAY, shiftDateStr(TODAY, -3))).toBe(false);
    expect(isMoodDateAccepted(TODAY, shiftDateStr(TODAY, 1))).toBe(false);
  });

  // The hole the fold CLOSED, stated so the tightening is not mistaken for a size
  // change: `daysBetweenDateStr` runs `Date.parse`, which rolls 2026-02-30 forward to
  // March 2 and answers a diff for it, so every predicate that folded in here except
  // the practice one accepted a day the calendar does not have.
  it.each([["2026-02-30"], ["2026-04-31"], ["2026-13-45"], ["nope"]])(
    "%s is not a day any domain accepts",
    (day) => {
      for (const domain of LOG_DOMAINS) {
        expect(isLogDateAccepted(domain, TODAY, day), domain).toBe(false);
      }
    }
  );
});

// The type requires a `reason` and a `ref`; it cannot require that the reason SAYS
// anything, which is the one gap a value check closes (the `arguedExclusion` brand
// throws on the same input for the same reason).
describe("every argued absence argues", () => {
  it("no reason is blank and no ref is bare", () => {
    const blank: string[] = [];
    for (const domain of LOG_DOMAINS) {
      const entry = LOG_MANIFEST[domain];
      const arguable: { reason?: string; ref?: string }[] = [
        entry.window,
        entry.statedTime,
        entry.offline,
        ...Object.values(entry.surfaces),
        ...Object.values(entry.pieces),
        entry.writeConventions,
      ];
      for (const [i, v] of arguable.entries()) {
        if (v.reason === undefined) continue;
        if (!v.reason.trim() || !/^#\d+$/.test(v.ref ?? "")) {
          blank.push(`${domain}[${i}]`);
        }
      }
    }
    expect(blank).toEqual([]);
  });
});
