import { describe, expect, it } from "vitest";
import {
  FAST_STALE_HOURS,
  fastAttributedDay,
  fastControlLabel,
  fastControlState,
  fastElapsedHours,
  fastsOverlap,
  formatFastDuration,
  overlappingFasts,
  promptsEndOfFast,
  servingsDuringFast,
  servingsDuringFastNote,
  type Fast,
} from "../fasting";

// The fasting lifecycle's PURE derivations (#2756). No DB, no clock: every case here
// states the instants it judges, which is also what lets the day-boundary cases below
// be written at all — a fast spans a profile-local day by nature, so "the day it counts
// for" is the question a naive date string gets wrong.

function fast(started: string, ended: string | null = null, id = 1): Fast {
  return { id, started_at: started, ended_at: ended, note: null };
}

describe("elapsed + formatting", () => {
  it("measures an active fast to `at` and a completed one over its interval", () => {
    const active = fast("2026-08-16T20:00:00Z");
    expect(
      fastElapsedHours(active, new Date("2026-08-17T12:00:00Z"))
    ).toBeCloseTo(16);
    const done = fast("2026-08-16T20:00:00Z", "2026-08-17T12:00:00Z");
    // A completed fast ignores `at` entirely — its length is a fact, not a reading.
    expect(
      fastElapsedHours(done, new Date("2026-08-20T00:00:00Z"))
    ).toBeCloseTo(16);
  });

  it("never reports a negative elapsed", () => {
    const f = fast("2026-08-16T20:00:00Z");
    expect(fastElapsedHours(f, new Date("2026-08-16T10:00:00Z"))).toBe(0);
  });

  it("formats the durations the control's own label carries", () => {
    expect(formatFastDuration(45 * 60_000)).toBe("45 m");
    expect(formatFastDuration((14 * 60 + 20) * 60_000)).toBe("14 h 20 m");
    // Past 100 h the minutes are noise.
    expect(formatFastDuration((120 * 60 + 3) * 60_000)).toBe("120 h");
  });
});

// A fast spans a day boundary by nature, so this is the case a stored date string gets
// wrong. The attribution rule (#94): a completed fast counts for the day it ENDS.
describe("day attribution across a profile-local boundary", () => {
  it("counts a fast for the day it ENDED, in the profile's own zone", () => {
    // Started 20:00 Tuesday New York, ended 12:00 Wednesday New York.
    const f = fast("2026-08-19T00:00:00Z", "2026-08-19T16:00:00Z");
    expect(fastAttributedDay(f, "America/New_York")).toBe("2026-08-19");
    // The SAME two instants in Tokyo end on the 20th — which is exactly why the day is
    // derived at read time and never stored.
    expect(fastAttributedDay(f, "Asia/Tokyo")).toBe("2026-08-20");
  });

  it("attributes an ACTIVE fast to no day at all", () => {
    expect(fastAttributedDay(fast("2026-08-19T00:00:00Z"), "UTC")).toBeNull();
  });
});

describe("control state — what the surface renders and the core re-checks", () => {
  it("offers a start when nothing is open", () => {
    const state = fastControlState(null, new Date("2026-08-16T12:00:00Z"));
    expect(state.kind).toBe("start");
    expect(fastControlLabel(state)).toBe("Start fast");
  });

  it("names the write in the label while active", () => {
    const state = fastControlState(
      fast("2026-08-16T20:00:00Z"),
      new Date("2026-08-17T10:20:00Z")
    );
    expect(state.kind).toBe("active");
    expect(fastControlLabel(state)).toBe("End fast · 14 h 20 m");
  });

  it("escalates to STALE at the plausibility bound, never past it silently", () => {
    const start = Date.parse("2026-08-16T00:00:00Z");
    const justUnder = new Date(start + (FAST_STALE_HOURS - 0.1) * 3_600_000);
    const atBound = new Date(start + FAST_STALE_HOURS * 3_600_000);
    expect(fastControlState(fast("2026-08-16T00:00:00Z"), justUnder).kind).toBe(
      "active"
    );
    expect(fastControlState(fast("2026-08-16T00:00:00Z"), atBound).kind).toBe(
      "stale"
    );
    // Stale still ENDS — the suggest adds a resolution, it never takes one away, and
    // nothing in the model expires or auto-ends a fast.
    expect(
      fastControlLabel(fastControlState(fast("2026-08-16T00:00:00Z"), atBound))
    ).toContain("End fast");
  });
});

describe("interval coherence", () => {
  it("treats an end as EXCLUSIVE, so back-to-back fasts are legal", () => {
    const a = Date.parse("2026-08-16T00:00:00Z");
    const b = Date.parse("2026-08-16T12:00:00Z");
    const c = Date.parse("2026-08-17T00:00:00Z");
    expect(fastsOverlap(a, b, b, c)).toBe(false);
    expect(fastsOverlap(a, c, b, null)).toBe(true);
  });

  it("treats an OPEN fast as extending forever", () => {
    const existing = [fast("2026-08-16T00:00:00Z", null, 7)];
    // A backdated start before the open fast collides with it.
    const clash = overlappingFasts(
      existing,
      Date.parse("2026-08-15T00:00:00Z"),
      null
    );
    expect(clash.map((f) => f.id)).toEqual([7]);
  });

  it("ignores the row being edited, so a correction is not its own overlap", () => {
    const existing = [fast("2026-08-16T00:00:00Z", "2026-08-16T18:00:00Z", 7)];
    expect(
      overlappingFasts(
        existing,
        Date.parse("2026-08-16T01:00:00Z"),
        Date.parse("2026-08-16T17:00:00Z"),
        7
      )
    ).toEqual([]);
  });
});

describe("the food-log follow-up offer", () => {
  const active = fast("2026-08-16T20:00:00Z");

  it("prompts only for a TODAY-attributed log while a fast is active", () => {
    expect(promptsEndOfFast(active, "2026-08-17", "2026-08-17")).toBe(true);
    // Backdated to yesterday: says nothing about the fast running right now.
    expect(promptsEndOfFast(active, "2026-08-16", "2026-08-17")).toBe(false);
    expect(promptsEndOfFast(null, "2026-08-17", "2026-08-17")).toBe(false);
  });
});

describe("the honest annotation of external incoherence", () => {
  const done = fast("2026-08-16T20:00:00Z", "2026-08-17T12:00:00Z");

  it("counts only servings with a STATED eating instant inside the interval", () => {
    expect(
      servingsDuringFast(done, [
        "2026-08-16T22:00:00Z", // inside
        "2026-08-17T06:00:00Z", // inside
        "2026-08-17T13:00:00Z", // after the end
        "2026-08-16T19:00:00Z", // before the start
        null, // no stated eating time — proves nothing, so it is not counted
      ])
    ).toBe(2);
  });

  it("treats the end as exclusive on this boundary too", () => {
    expect(servingsDuringFast(done, ["2026-08-17T12:00:00Z"])).toBe(0);
    expect(servingsDuringFast(done, ["2026-08-16T20:00:00Z"])).toBe(1);
  });

  it("says nothing when there is nothing to say", () => {
    expect(servingsDuringFastNote(0)).toBeNull();
    expect(servingsDuringFastNote(1)).toBe("1 serving logged during");
    expect(servingsDuringFastNote(2)).toBe("2 servings logged during");
  });
});
