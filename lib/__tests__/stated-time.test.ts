// PURE TIER — the shared "when did this happen?" model (#2236): the day-hours
// offer, the pair-preserving re-anchor, and the ONE acceptance gate every stated
// event time goes through (formerly food-only as acceptEatenAt, #2053).
//
// The properties worth pinning are the ones that keep a row from contradicting
// itself: an offered hour always lands on the day it names (DST days included),
// the offer never contains an option the gate would refuse, a future or wrong-day
// instant costs the statement, and NOTHING in the model can turn an absent
// statement into a defaulted now.
//
// Since #2296 one more, and it is the one the owner ruled on: UNSTATED and REFUSED
// are different answers. The gate used to answer `Date | null` and a fast device
// clock could therefore throw a stated eating time away with nothing on screen. The
// tolerance stays five minutes; what changed is that the refusal is now sayable.

import { describe, it, expect } from "vitest";
import {
  STATED_FUTURE_SKEW_MS,
  STATED_TIME_REFUSAL_NOTE,
  judgeStatedAt,
  reanchorStatedAt,
  statedHhmm,
  statedHoursOnDate,
  statedInstantOnDate,
  type JudgedStatement,
  type StatedTimeRefusal,
} from "@/lib/stated-time";
import { judgeEatenAt, EATEN_AT_FUTURE_SKEW_MS } from "@/lib/food-eating-time";
import { dateStrInTz, zonedDateParts } from "@/lib/date";

const UTC = "UTC";
const NY = "America/New_York";

describe("statedHoursOnDate (#2236 / #2227's day-hours offer)", () => {
  it("offers the full 24 hours of a past day, in order", () => {
    const now = new Date("2026-08-07T13:45:00Z");
    const options = statedHoursOnDate("2026-08-05", UTC, now);
    expect(options).toHaveLength(24);
    expect(options[0].hhmm).toBe("00:00");
    expect(options[23].hhmm).toBe("23:00");
  });

  it("truncates at the current local hour when the day is today", () => {
    const now = new Date("2026-08-07T13:45:00Z");
    const options = statedHoursOnDate("2026-08-07", UTC, now);
    expect(options.map((o) => o.hhmm)).toEqual(
      Array.from({ length: 14 }, (_, h) => `${String(h).padStart(2, "0")}:00`)
    );
  });

  it("\"today\" is the profile's local day, not the runner's", () => {
    // 01:30Z on Aug 8 is 21:30 on Aug 7 in New York, so Aug 7's offer is
    // truncated at 21:00 — while a UTC profile would get all of Aug 7.
    const now = new Date("2026-08-08T01:30:00Z");
    const ny = statedHoursOnDate("2026-08-07", NY, now);
    expect(ny.map((o) => o.hhmm)).toHaveLength(22);
    expect(ny[ny.length - 1].hhmm).toBe("21:00");
    expect(statedHoursOnDate("2026-08-07", UTC, now)).toHaveLength(24);
  });

  it("every option round-trips to its own date and hour", () => {
    const now = new Date("2026-08-07T13:45:00Z");
    for (const date of ["2026-08-05", "2026-03-08", "2026-11-01"]) {
      for (const o of statedHoursOnDate(date, NY, now)) {
        expect(zonedDateParts(NY, new Date(o.iso))).toEqual({
          date,
          hhmm: o.hhmm,
        });
      }
    }
  });

  it("a spring-forward day lacks its nonexistent hour and duplicates nothing", () => {
    // America/New_York, 2026-03-08: 02:00–02:59 does not exist.
    const now = new Date("2026-08-07T13:45:00Z");
    const options = statedHoursOnDate("2026-03-08", NY, now);
    expect(options).toHaveLength(23);
    const hours = options.map((o) => o.hhmm);
    expect(hours).not.toContain("02:00");
    expect(new Set(hours).size).toBe(hours.length);
  });

  it("a fall-back day offers each wall hour exactly once", () => {
    // America/New_York, 2026-11-01: 01:00 happens twice; the offer names it once.
    const now = new Date("2026-11-02T13:45:00Z");
    const options = statedHoursOnDate("2026-11-01", NY, now);
    expect(options).toHaveLength(24);
    const hours = options.map((o) => o.hhmm);
    expect(new Set(hours).size).toBe(24);
    const isos = options.map((o) => o.iso);
    expect(new Set(isos).size).toBe(24);
  });

  it("never offers an option the acceptance gate would refuse", () => {
    // The offer-and-gate agreement that keeps a refusable option off the screen
    // — including on the DST days and on a truncated today.
    for (const [date, nowIso] of [
      ["2026-08-07", "2026-08-07T13:45:00Z"],
      ["2026-03-08", "2026-08-07T13:45:00Z"],
      ["2026-11-01", "2026-11-01T15:00:00Z"],
    ] as const) {
      const now = new Date(nowIso);
      for (const o of statedHoursOnDate(date, NY, now)) {
        const verdict = judgeStatedAt(new Date(o.iso), NY, date, now);
        expect(verdict.kind).toBe("accepted");
        expect(
          verdict.kind === "accepted" ? verdict.at.toISOString() : null
        ).toBe(o.iso);
      }
    }
  });
});

describe("statedInstantOnDate (the pair rule, by construction)", () => {
  it("anchors a wall time on the named day in the profile's zone", () => {
    const inst = statedInstantOnDate("2026-08-06", "19:00", NY);
    expect(inst?.toISOString()).toBe("2026-08-06T23:00:00.000Z");
    expect(zonedDateParts(NY, inst!)).toEqual({
      date: "2026-08-06",
      hhmm: "19:00",
    });
  });

  it("refuses garbage rather than inventing an instant", () => {
    expect(statedInstantOnDate("2026-08-06", "25:00", NY)).toBeNull();
    expect(statedInstantOnDate("2026-08-06", "", NY)).toBeNull();
    expect(statedInstantOnDate("not-a-date", "12:00", NY)).toBeNull();
  });

  it("refuses a wall time inside a DST gap instead of silently moving it", () => {
    expect(statedInstantOnDate("2026-03-08", "02:30", NY)).toBeNull();
    expect(statedInstantOnDate("2026-03-08", "03:00", NY)).not.toBeNull();
  });
});

describe("judgeStatedAt (the one gate, ex-acceptEatenAt)", () => {
  const now = new Date("2026-08-07T20:00:00Z");

  it("accepts an instant on the row's own local day", () => {
    const at = new Date("2026-08-07T15:00:00Z");
    expect(judgeStatedAt(at, UTC, "2026-08-07", now)).toEqual({
      kind: "accepted",
      at,
    });
  });

  it("judges the day in the profile's zone, not the runner's", () => {
    // 03:00Z on Aug 8 is 23:00 on Aug 7 in New York.
    const at = new Date("2026-08-08T03:00:00Z");
    expect(judgeStatedAt(at, NY, "2026-08-07", now2(at))).toEqual({
      kind: "accepted",
      at,
    });
    expect(judgeStatedAt(at, UTC, "2026-08-07", now2(at))).toEqual({
      kind: "refused",
      reason: "other-day",
    });
  });

  it("refuses a meaningfully future instant, tolerating clock skew", () => {
    const skewed = new Date(now.getTime() + STATED_FUTURE_SKEW_MS - 1000);
    expect(judgeStatedAt(skewed, UTC, "2026-08-07", now)).toEqual({
      kind: "accepted",
      at: skewed,
    });
    const future = new Date(now.getTime() + STATED_FUTURE_SKEW_MS + 1000);
    expect(judgeStatedAt(future, UTC, "2026-08-07", now)).toEqual({
      kind: "refused",
      reason: "future",
    });
  });

  it("refuses an instant off the row's day", () => {
    expect(
      judgeStatedAt(new Date("2026-08-06T12:00:00Z"), UTC, "2026-08-07", now)
    ).toEqual({ kind: "refused", reason: "other-day" });
  });

  // #2296, the whole point: absence and refusal are DIFFERENT answers. The old
  // `Date | null` shape said "null" to both, which is how a device clock running
  // fast could discard a stated eating time in silence for as long as the gate
  // has existed — nothing downstream could tell there had been anything to lose.
  it("separates 'nobody stated a time' from 'a time was stated and refused'", () => {
    expect(judgeStatedAt(null, UTC, "2026-08-07", now)).toEqual({
      kind: "unstated",
    });
    expect(judgeStatedAt(undefined, UTC, "2026-08-07", now)).toEqual({
      kind: "unstated",
    });
    expect(judgeStatedAt(new Date("nope"), UTC, "2026-08-07", now)).toEqual({
      kind: "refused",
      reason: "malformed",
    });
  });

  // The clock case the owner ruled on, at the exact tolerance: six minutes fast is
  // an ordinary un-NTP'd phone, not a forgery. It still loses the minute — the
  // ruling KEEPS the five-minute gate — but it is now a refusal a surface can name.
  it("names the clock, not the day, when a fast client states 'now'", () => {
    const sixMinutesFast = new Date(now.getTime() + 6 * 60 * 1000);
    expect(judgeStatedAt(sixMinutesFast, UTC, "2026-08-07", now)).toEqual({
      kind: "refused",
      reason: "future",
    });
    expect(STATED_FUTURE_SKEW_MS).toBe(5 * 60 * 1000);
  });

  it("has a note for every refusal reason, and none of them is empty", () => {
    // The completeness pin: a new reason without copy would render a surface's
    // sentence with a hole in it, which is a different flavour of the same silence.
    const reasons: StatedTimeRefusal[] = ["future", "other-day", "malformed"];
    for (const reason of reasons) {
      expect(STATED_TIME_REFUSAL_NOTE[reason].length).toBeGreaterThan(0);
    }
    expect(Object.keys(STATED_TIME_REFUSAL_NOTE).sort()).toEqual(
      [...reasons].sort()
    );
  });

  it("cannot answer `unstated` to a caller that is holding a statement", () => {
    // The overload's job, checked as a type AND at runtime: a call site with an
    // instant in hand should not have to write a branch for "there was no instant".
    const judged = judgeStatedAt(
      new Date("2026-08-07T15:00:00Z"),
      UTC,
      "2026-08-07",
      now
    );
    // `judged` is typed JudgedStatement here, so this reads `.at` with no narrowing
    // past `accepted` — the union has no third member to exclude.
    const asJudged: JudgedStatement = judged;
    expect(asJudged.kind).not.toBe("unstated");
  });

  it("is the same computation the food module re-exports", () => {
    // The move (#2236): one rule, worn by every surface — not a food copy and a
    // neutral copy that can drift.
    expect(judgeEatenAt).toBe(judgeStatedAt);
    expect(EATEN_AT_FUTURE_SKEW_MS).toBe(STATED_FUTURE_SKEW_MS);
  });

  function now2(at: Date): Date {
    // A "now" comfortably after `at`, so only the day rule is under test.
    return new Date(at.getTime() + 60 * 60 * 1000);
  }
});

describe("reanchorStatedAt (a date change moves the pair together)", () => {
  const now = new Date("2026-08-07T20:00:00Z");

  it("null stays null — a date change never invents a statement", () => {
    expect(reanchorStatedAt(null, "2026-08-06", UTC, now)).toBeNull();
  });

  it("keeps the wall time when it exists on the new day", () => {
    const at = statedInstantOnDate("2026-08-05", "09:30", NY)!.toISOString();
    const moved = reanchorStatedAt(at, "2026-08-06", NY, now);
    expect(zonedDateParts(NY, new Date(moved!))).toEqual({
      date: "2026-08-06",
      hhmm: "09:30",
    });
  });

  it("clears — never guesses — when the wall time would land in the future", () => {
    // 21:00 stated on yesterday, re-anchored onto a today whose local clock
    // reads 16:00: keeping the hour would state the future.
    const at = statedInstantOnDate("2026-08-06", "21:00", NY)!.toISOString();
    expect(reanchorStatedAt(at, "2026-08-07", NY, now)).toBeNull();
  });

  it("clears when the wall time does not exist on the new day (DST gap)", () => {
    const at = statedInstantOnDate("2026-08-05", "02:30", NY)!.toISOString();
    expect(reanchorStatedAt(at, "2026-03-08", NY, now)).toBeNull();
  });

  it("clears an unparseable statement instead of passing it through", () => {
    expect(reanchorStatedAt("nope", "2026-08-06", UTC, now)).toBeNull();
  });
});

describe("statedHhmm (the display half)", () => {
  it('renders "not stated" as empty, and an instant as its local wall clock', () => {
    expect(statedHhmm(null, NY)).toBe("");
    expect(statedHhmm("2026-08-06T23:00:00.000Z", NY)).toBe("19:00");
    expect(statedHhmm("nope", NY)).toBe("");
  });

  it("agrees with the day the acceptance gate would judge", () => {
    const iso = "2026-08-08T03:00:00.000Z";
    expect(statedHhmm(iso, NY)).toBe("23:00");
    expect(dateStrInTz(NY, new Date(iso))).toBe("2026-08-07");
  });
});
