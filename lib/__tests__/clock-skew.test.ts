import { describe, it, expect } from "vitest";
import {
  PLAUSIBLE_OFFSET_MINUTE_PARTS,
  MIN_PLAUSIBLE_OFFSET_MIN,
  MAX_PLAUSIBLE_OFFSET_MIN,
  MINUTES_PER_DAY,
  EVENING_CANDIDATE_CLOCK,
  MORNING_CANDIDATE_CLOCK,
  isOffsetShaped,
  plausibleOffsetMinutes,
  formatOffset,
  clockAtMinute,
  minutesFromBase,
  clockGapMinutes,
  spansMidnight,
  nearMidnightCandidate,
  localReadingOf,
  canonicalizeSourceClock,
  type ClockReading,
} from "@/lib/clock-skew";

// THE clock-skew primitive (#2088). The source-clock-error family was repaired one
// symptom at a time — a whole-hour rescue (#2011/#2055), the fractional offsets the
// world actually uses (#2063/#2092), the same gap across midnight (#2056) — because
// "a source's timestamp disagrees with the profile's clock by a plausible offset"
// was being answered at DETECTION, differently each time. This is the one answer, and
// this is its one test surface.

const at = (date: string, minutes: number): ClockReading => ({ date, minutes });

describe("the plausible-offset table", () => {
  it("admits a whole hour, a half hour, and three quarters", () => {
    expect(PLAUSIBLE_OFFSET_MINUTE_PARTS).toEqual([0, 30, 45]);
    expect(plausibleOffsetMinutes(60)).toBe(60); // the common non-DST utc_offset
    expect(plausibleOffsetMinutes(30)).toBe(30); // India +5:30 read as +5:00
    expect(plausibleOffsetMinutes(105)).toBe(105); // Chatham +12:45 as +11:00
    expect(plausibleOffsetMinutes(120)).toBe(120); // doubly-wrong offset / travel
  });

  it("refuses a gap that is not offset-SHAPED — the entire safety margin", () => {
    // Two genuinely distinct back-to-back sessions do not begin an exact offset
    // apart. 1h12m is the shape of a real second workout, not of a wrong clock.
    expect(plausibleOffsetMinutes(72)).toBeNull();
    expect(isOffsetShaped(72)).toBe(false);
    // The quarter hour is the documented exclusion: reachable in principle, but it
    // is also the grid people schedule on.
    expect(isOffsetShaped(75)).toBe(false);
    expect(plausibleOffsetMinutes(75)).toBeNull();
  });

  it("refuses gaps outside the bounds, including no gap at all", () => {
    expect(plausibleOffsetMinutes(0)).toBeNull();
    expect(plausibleOffsetMinutes(MIN_PLAUSIBLE_OFFSET_MIN - 1)).toBeNull();
    expect(plausibleOffsetMinutes(MAX_PLAUSIBLE_OFFSET_MIN + 60)).toBeNull();
  });

  it("is sign-blind — a gap is a disagreement, not a direction", () => {
    expect(plausibleOffsetMinutes(-60)).toBe(60);
  });

  it("spells an offset the way a person reads it", () => {
    expect(formatOffset(60)).toBe("1h");
    expect(formatOffset(30)).toBe("30m");
    expect(formatOffset(105)).toBe("1h45m");
  });
});

describe("continuous-clock arithmetic across midnight (#2056)", () => {
  it("measures the next day's minute from the base day's midnight", () => {
    expect(minutesFromBase(at("2026-07-09", 30), "2026-07-08")).toBe(
      MINUTES_PER_DAY + 30
    );
    expect(minutesFromBase(at("2026-07-08", 1410), "2026-07-08")).toBe(1410);
    expect(minutesFromBase(at("2026-07-07", 30), "2026-07-08")).toBe(
      30 - MINUTES_PER_DAY
    );
  });

  it("reads a 23:30 / next-day-00:30 pair as ONE hour apart", () => {
    // The whole of #2056: comparing minutes-of-day made this 1380 minutes — a gap
    // no offset table would ever admit — when it is the hour a wrong offset moved.
    expect(clockGapMinutes(at("2026-07-08", 1410), at("2026-07-09", 30))).toBe(
      60
    );
    expect(
      plausibleOffsetMinutes(
        clockGapMinutes(at("2026-07-08", 1410), at("2026-07-09", 30)) as number
      )
    ).toBe(60);
    // Order-independent.
    expect(clockGapMinutes(at("2026-07-09", 30), at("2026-07-08", 1410))).toBe(
      60
    );
  });

  it("still measures a same-day gap the way it always did", () => {
    expect(clockGapMinutes(at("2026-07-08", 545), at("2026-07-08", 485))).toBe(
      60
    );
  });

  it("declines an unparseable date rather than guessing", () => {
    expect(
      clockGapMinutes(at("not-a-date", 60), at("2026-07-08", 60))
    ).toBeNull();
  });

  it("says when a pair spans midnight at all", () => {
    expect(spansMidnight(at("2026-07-08", 1410), at("2026-07-09", 30))).toBe(
      true
    );
    expect(spansMidnight(at("2026-07-08", 540), at("2026-07-08", 600))).toBe(
      false
    );
  });
});

describe("the near-midnight candidate window", () => {
  it("derives its bounds from the offset the table would forgive", () => {
    expect(EVENING_CANDIDATE_CLOCK).toBe("22:00");
    expect(MORNING_CANDIDATE_CLOCK).toBe("02:00");
    expect(clockAtMinute(MINUTES_PER_DAY - MAX_PLAUSIBLE_OFFSET_MIN)).toBe(
      EVENING_CANDIDATE_CLOCK
    );
  });

  it("admits adjacent days near midnight, in either order", () => {
    expect(
      nearMidnightCandidate(at("2026-07-08", 1410), at("2026-07-09", 30))
    ).toBe(true);
    expect(
      nearMidnightCandidate(at("2026-07-09", 30), at("2026-07-08", 1410))
    ).toBe(true);
  });

  it("admits nothing further out than the band, or further than a day", () => {
    // 21:59 on the evening side, 02:01 on the morning side, and a two-day gap.
    expect(
      nearMidnightCandidate(at("2026-07-08", 1319), at("2026-07-09", 30))
    ).toBe(false);
    expect(
      nearMidnightCandidate(at("2026-07-08", 1410), at("2026-07-09", 121))
    ).toBe(false);
    expect(
      nearMidnightCandidate(at("2026-07-08", 1410), at("2026-07-10", 30))
    ).toBe(false);
    // Same-day readings are the ordinary group's business, not this one's.
    expect(
      nearMidnightCandidate(at("2026-07-08", 1410), at("2026-07-08", 1430))
    ).toBe(false);
  });

  it("admits nothing without a clock on both sides", () => {
    expect(nearMidnightCandidate(null, at("2026-07-09", 30))).toBe(false);
    expect(nearMidnightCandidate(at("2026-07-08", 1410), null)).toBe(false);
  });
});

describe("branch A — a true instant needs no evidence", () => {
  it("reads the instant on the PROFILE's clock, moving the local day when it must", () => {
    // 23:30 in Berlin on 8 July is 21:30 UTC. A source that filed the same instant
    // as "22:30" was a whole hour out — and in London it is a different local day.
    const instant = new Date("2026-07-08T21:30:00Z");
    expect(localReadingOf(instant, "Europe/Berlin")).toEqual({
      date: "2026-07-08",
      minutes: 23 * 60 + 30,
    });
    expect(
      localReadingOf(new Date("2026-07-08T23:30:00Z"), "Europe/Berlin")
    ).toEqual({ date: "2026-07-09", minutes: 90 });
  });

  it("canonicalizes a wrongly-offset wall clock, naming what moved", () => {
    const verdict = canonicalizeSourceClock({
      reported: at("2026-07-08", 22 * 60 + 30),
      instant: { at: new Date("2026-07-08T21:30:00Z"), tz: "Europe/Berlin" },
    });
    expect(verdict).toEqual({
      kind: "canonical",
      reading: { date: "2026-07-08", minutes: 23 * 60 + 30 },
      offsetMinutes: 60,
      changed: true,
      movesDate: false,
    });
  });

  it("says so when the wrong offset moves the DATE too (#2056 at ingest)", () => {
    // The source filed 23:30 on the 8th against a UTC clock; in Berlin that
    // instant is 01:30 on the NINTH. The row belongs on the next local day, and the
    // gap is measured across it rather than as the 22 hours minutes-of-day would say.
    const verdict = canonicalizeSourceClock({
      reported: at("2026-07-08", 23 * 60 + 30),
      instant: { at: new Date("2026-07-08T23:30:00Z"), tz: "Europe/Berlin" },
    });
    expect(verdict).toMatchObject({
      kind: "canonical",
      reading: { date: "2026-07-09", minutes: 90 },
      offsetMinutes: 120,
      changed: true,
      movesDate: true,
    });
  });

  it("is IDEMPOTENT — an already-canonical row reports no change", () => {
    const verdict = canonicalizeSourceClock({
      reported: at("2026-07-08", 23 * 60 + 30),
      instant: { at: new Date("2026-07-08T21:30:00Z"), tz: "Europe/Berlin" },
    });
    expect(verdict).toMatchObject({ kind: "canonical", changed: false });
    expect(verdict).toMatchObject({ offsetMinutes: 0, movesDate: false });
  });
});

describe("branch B — a bare wall clock, and what may be concluded from it", () => {
  it("REFUSES a lone row: no evidence, no inference", () => {
    // The #2055 discipline, now enforced by the primitive rather than by the shape
    // of whoever happened to call it. A single row's clock is never shifted on a
    // suspicion.
    expect(
      canonicalizeSourceClock({ reported: at("2026-07-08", 1410) })
    ).toEqual({ kind: "refused", reason: "no-evidence" });
    expect(
      canonicalizeSourceClock({
        reported: at("2026-07-08", 1410),
        evidence: [],
      })
    ).toEqual({ kind: "refused", reason: "no-evidence" });
  });

  it("reports a SKEW — never a winner — when cross-source evidence supports one", () => {
    // Nothing in two wall clocks says which source lied (#2055), so the primitive
    // measures the disagreement and stops. The person resolves it in Review.
    expect(
      canonicalizeSourceClock({
        reported: at("2026-07-08", 1410),
        evidence: [at("2026-07-09", 30)],
      })
    ).toEqual({ kind: "skew", offsetMinutes: 60, spansMidnight: true });
    expect(
      canonicalizeSourceClock({
        reported: at("2026-07-08", 545),
        evidence: [at("2026-07-08", 515)],
      })
    ).toEqual({ kind: "skew", offsetMinutes: 30, spansMidnight: false });
  });

  it("prefers the SMALLEST plausible offset among several candidates", () => {
    expect(
      canonicalizeSourceClock({
        reported: at("2026-07-08", 600),
        evidence: [at("2026-07-08", 480), at("2026-07-08", 570)],
      })
    ).toMatchObject({ kind: "skew", offsetMinutes: 30 });
  });

  it("refuses evidence whose gap is not offset-shaped", () => {
    expect(
      canonicalizeSourceClock({
        reported: at("2026-07-08", 600),
        evidence: [at("2026-07-08", 528)],
      })
    ).toEqual({ kind: "refused", reason: "not-offset-shaped" });
  });
});

describe("what canonicalization must never touch", () => {
  it("refuses an EDIT-LOCKED row before it looks at anything else", () => {
    // A manual correction outranks every source, instant or not — the same stance
    // isEditLocked enforces on every ingest path.
    expect(
      canonicalizeSourceClock({
        reported: at("2026-07-08", 22 * 60 + 30),
        instant: { at: new Date("2026-07-08T21:30:00Z"), tz: "Europe/Berlin" },
        editLocked: true,
      })
    ).toEqual({ kind: "refused", reason: "edit-locked" });
  });

  it("refuses a row with no clock at all", () => {
    expect(canonicalizeSourceClock({ reported: null })).toEqual({
      kind: "refused",
      reason: "no-clock",
    });
    expect(
      canonicalizeSourceClock({
        reported: null,
        instant: { at: new Date("nonsense"), tz: "UTC" },
      })
    ).toEqual({ kind: "refused", reason: "no-clock" });
  });
});
