// PURE TIER — the one event-window physiology computation (#4775 §1).
//
// The case this file exists for is COVERAGE. Every other number here is arithmetic a
// reader can check by hand; `covered` is the one that decides whether a send states
// anything at all, and it fails silently in exactly one direction — a frontier still
// inside the window produces a mean, a peak and a zone split that all look like
// readings and are all describing a session whose tail has not been delivered yet.

import { describe, expect, it } from "vitest";
import {
  eventPhysiology,
  localMinutesBetween,
  physiologyDaySpan,
  practiceEffectBpm,
  shiftLocalMinutes,
  usualValue,
  zoneMinutesClause,
  PRE_WINDOW_MIN,
  RECOVERY_BOUND_MIN,
  USUAL_MIN_EVENTS,
  type EventPhysiologyInput,
} from "@/lib/event-physiology";
import { buildZoneModel, type HrBucket } from "@/lib/training-zones";

const DAY = "2026-05-20";
const WINDOW = { start: `${DAY}T10:00`, end: `${DAY}T10:30` };

// A flat-ish stream from `from` for `count` minutes at `bpm`, one bucket a minute.
function run(
  from: string,
  count: number,
  bpm: number | ((i: number) => number)
) {
  return Array.from({ length: count }, (_, i) => ({
    ts: shiftLocalMinutes(from, i),
    bpm: typeof bpm === "number" ? bpm : bpm(i),
  }));
}

const ZONE_MODEL = buildZoneModel({ age: 40, restingHr: 50 });

function physiology(over: Partial<EventPhysiologyInput> = {}) {
  return eventPhysiology({
    window: WINDOW,
    minutes: [],
    zoneModel: ZONE_MODEL,
    restingCeilingBpm: 58,
    frontier: `${DAY}T12:00`,
    now: `${DAY}T12:30`,
    ...over,
  });
}

describe("local-minute arithmetic", () => {
  it.each([
    [`${DAY}T23:50`, 30, "2026-05-21T00:20"],
    [`${DAY}T00:10`, -20, "2026-05-19T23:50"],
    ["2026-02-28T23:00", 120, "2026-03-01T01:00"],
  ])("shifts %s by %i minutes", (from, add, expected) => {
    expect(shiftLocalMinutes(from, add)).toBe(expected);
  });

  it("measures a difference across midnight without a timezone", () => {
    expect(localMinutesBetween(`${DAY}T23:50`, "2026-05-21T00:20")).toBe(30);
    expect(localMinutesBetween("2026-05-21T00:20", `${DAY}T23:50`)).toBe(-30);
  });

  // The gather bounds its read from this, so a span that clipped either band would
  // silently shorten recovery or drop the pre-window baseline.
  it("spans the pre-window and recovery bands, not the window's own day", () => {
    expect(
      physiologyDaySpan({ start: `${DAY}T00:05`, end: `${DAY}T23:30` })
    ).toEqual({ from: "2026-05-19", to: "2026-05-21" });
  });
});

describe("in-window facts", () => {
  it("measures only the minutes inside the window", () => {
    const p = physiology({
      minutes: [
        ...run(`${DAY}T09:40`, 20, 55), // before, incl. the pre-window band
        ...run(`${DAY}T10:00`, 30, (i) => 120 + i), // 120..149
        ...run(`${DAY}T10:30`, 10, 70), // after — the window is half-open
      ],
    });
    expect(p.inWindow).toEqual({
      measuredMin: 30,
      meanBpm: 134.5,
      peakBpm: 149,
      lowBpm: 120,
    });
    // 15 minutes before 10:00, i.e. 09:45..09:59 — not the whole 09:40 run.
    expect(p.preWindowMeanBpm).toBe(55);
    expect(p.minutes).toHaveLength(30);
  });

  it("has no in-window facts and no zone split through a wear gap", () => {
    const p = physiology({ minutes: run(`${DAY}T09:00`, 30, 55) });
    expect(p.inWindow).toBeNull();
    expect(p.zoneMinutes).toBeNull();
  });

  it("counts MEASURED minutes, never the window's length", () => {
    // Ten minutes of a thirty-minute window: the watch was off the wrist for the rest.
    const p = physiology({ minutes: run(`${DAY}T10:00`, 10, 130) });
    expect(p.inWindow?.measuredMin).toBe(10);
  });

  it("states no pre-window mean when the band is empty", () => {
    const p = physiology({ minutes: run(`${DAY}T10:00`, 30, 130) });
    expect(p.preWindowMeanBpm).toBeNull();
  });

  // The boundary the pre-window band draws: a minute one tick outside it is out.
  it.each([
    [PRE_WINDOW_MIN, 1],
    [PRE_WINDOW_MIN + 1, 0],
  ])(
    "a bucket %i min before the start is %i minutes of baseline",
    (back, n) => {
      const p = physiology({
        minutes: [{ ts: shiftLocalMinutes(WINDOW.start, -back), bpm: 61 }],
      });
      expect(p.preWindowMeanBpm).toBe(n === 1 ? 61 : null);
    }
  );
});

describe("recovery", () => {
  it("counts minutes from the end until bpm re-enters the resting range", () => {
    const p = physiology({
      minutes: [
        ...run(`${DAY}T10:00`, 30, 140),
        ...run(`${DAY}T10:30`, 12, 90), // still elevated
        ...run(`${DAY}T10:42`, 10, 56), // back inside (ceiling 58)
      ],
    });
    expect(p.recoveryMin).toBe(12);
  });

  it("is null when the stream stops before recovery — not a bounded number", () => {
    const p = physiology({
      minutes: [...run(`${DAY}T10:00`, 30, 140), ...run(`${DAY}T10:30`, 5, 95)],
    });
    expect(p.recoveryMin).toBeNull();
  });

  it("is null when the profile has no resting-HR history", () => {
    const p = physiology({
      restingCeilingBpm: null,
      minutes: [
        ...run(`${DAY}T10:00`, 30, 140),
        ...run(`${DAY}T10:30`, 20, 50),
      ],
    });
    expect(p.recoveryMin).toBeNull();
  });

  // The bound is a horizon, not a clamp: a return one minute past it is not a
  // 120-minute recovery, it is no answer at all.
  it.each([
    [RECOVERY_BOUND_MIN, RECOVERY_BOUND_MIN],
    [RECOVERY_BOUND_MIN + 1, null],
  ])("a return at +%i minutes reports %s", (offset, expected) => {
    const p = physiology({
      minutes: [
        ...run(`${DAY}T10:00`, 30, 140),
        { ts: shiftLocalMinutes(WINDOW.end, offset), bpm: 52 },
      ],
    });
    expect(p.recoveryMin).toBe(expected);
  });
});

describe("coverage — the honesty gate", () => {
  // THE case. The pipeline runs 30–61 min behind the wrist, so at the finish tap the
  // stream holds minutes only up to somewhere inside the session. Every number the
  // result carries is then a partial window's, and every one of them looks real.
  it("is false when the frontier sits INSIDE the window", () => {
    const p = physiology({
      frontier: `${DAY}T10:12`,
      minutes: run(`${DAY}T10:00`, 12, 140),
    });
    expect(p.covered).toBe(false);
    // The facts are still computed — the gate is what stops them being SAID.
    expect(p.inWindow?.measuredMin).toBe(12);
  });

  it.each([
    [`${DAY}T10:29`, false],
    [`${DAY}T10:30`, true],
    [`${DAY}T10:31`, true],
  ])("frontier %s ⇒ covered %s", (frontier, covered) => {
    expect(physiology({ frontier }).covered).toBe(covered);
  });

  it("is false when the profile has no stream at all", () => {
    const p = physiology({ frontier: null });
    expect(p.covered).toBe(false);
    expect(p.frontierAgeMin).toBeNull();
  });

  it("ages the frontier against now, never below zero", () => {
    expect(
      physiology({ frontier: `${DAY}T12:00`, now: `${DAY}T12:45` })
        .frontierAgeMin
    ).toBe(45);
    // A frontier ahead of the caller's clock is clock skew, not negative age.
    expect(
      physiology({ frontier: `${DAY}T13:00`, now: `${DAY}T12:45` })
        .frontierAgeMin
    ).toBe(0);
  });
});

describe("zone minutes", () => {
  it("splits the in-window minutes through the profile's model", () => {
    const p = physiology({
      minutes: [
        ...run(`${DAY}T10:00`, 20, 120),
        ...run(`${DAY}T10:20`, 10, 165),
      ],
    });
    expect(p.zoneMinutes?.reduce((a, b) => a + b, 0)).toBe(30);
    expect(zoneMinutesClause(p.zoneMinutes!)).toMatch(
      /^Z\d \d+ min( · Z\d \d+ min)*$/
    );
  });

  it("has no split without a zone model", () => {
    expect(
      physiology({ zoneModel: null, minutes: run(`${DAY}T10:00`, 5, 120) })
        .zoneMinutes
    ).toBeNull();
  });

  it("names only the zones with minutes in them", () => {
    expect(zoneMinutesClause([0, 24, 11, 0, 0])).toBe("Z2 24 min · Z3 11 min");
    expect(zoneMinutesClause([0, 0, 0, 0, 0])).toBeNull();
  });
});

describe("usual", () => {
  it.each([
    [[], null],
    [[10, 12], null],
    [[10, 12, 14], 12],
  ])("%j prior events ⇒ usual %s", (priors, expected) => {
    expect(usualValue(priors)).toBe(expected);
  });

  it("is the floor exactly, not one above it", () => {
    expect(usualValue(Array(USUAL_MIN_EVENTS - 1).fill(20))).toBeNull();
    expect(usualValue(Array(USUAL_MIN_EVENTS).fill(20))).toBe(20);
  });

  it("averages the ten most recent and forgets the rest", () => {
    // Newest first: ten 30s, then a stretch of 0s that must not pull the mean down.
    expect(usualValue([...Array(10).fill(30), ...Array(40).fill(0)])).toBe(30);
  });
});

describe("practice effect", () => {
  it("states a signed rise over the resting reference", () => {
    const p = physiology({ minutes: run(`${DAY}T10:00`, 30, 95) });
    expect(practiceEffectBpm(p, 60)).toBe(35);
  });

  // A meditation's fall and a sauna's rise are the same statement with a sign.
  it("states a fall as a negative number rather than nothing", () => {
    const p = physiology({ minutes: run(`${DAY}T10:00`, 30, 52) });
    expect(practiceEffectBpm(p, 60)).toBe(-8);
  });

  it.each([
    ["no in-window minutes", [] as HrBucket[], 60],
    ["no resting reference", run(`${DAY}T10:00`, 30, 95), null],
  ])("is null with %s", (_label, minutes, resting) => {
    expect(practiceEffectBpm(physiology({ minutes }), resting)).toBeNull();
  });
});
