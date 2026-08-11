import { describe, it, expect } from "vitest";
import {
  redoseNoticeDecision,
  redoseWindowStatus,
  effectiveMaxDailyCount,
  prnMaxSignalKey,
  PRN_MAX_PREFIX,
  parseAmountMg,
  prnDayExposure,
} from "@/lib/prn-redose";

// The arming administration was given at a fixed instant; `now` is offset from it.
const GIVEN = new Date("2026-07-15T10:00:00Z");
const hoursAfter = (h: number) => new Date(GIVEN.getTime() + h * 3_600_000);

const base = {
  minIntervalHours: 6,
  maxDailyCount: 4,
  latestAdministrationId: 42,
  latestGivenAt: GIVEN,
  countToday: 1,
  now: hoursAfter(6),
  notifiedAdministrationId: null as number | null,
  tickMinutes: 5,
};

describe("redoseNoticeDecision — one-shot window", () => {
  it("FIRES exactly when the minimum interval has elapsed and under the max", () => {
    const d = redoseNoticeDecision(base);
    expect(d.kind).toBe("fire");
    if (d.kind === "fire") {
      expect(d.administrationId).toBe(42);
      expect(d.countToday).toBe(1);
      expect(d.maxDailyCount).toBe(4);
    }
  });

  it("NOT-YET before the interval elapses", () => {
    const d = redoseNoticeDecision({ ...base, now: hoursAfter(5.5) });
    expect(d.kind).toBe("not-yet");
    if (d.kind === "not-yet") expect(d.opensInHours).toBeCloseTo(0.5, 5);
  });

  it("NOT-ARMED when nothing has been logged", () => {
    expect(
      redoseNoticeDecision({
        ...base,
        latestAdministrationId: null,
        latestGivenAt: null,
      }).kind
    ).toBe("not-armed");
  });

  it("ONE-SHOT: already-notified when the marker matches the latest administration", () => {
    expect(
      redoseNoticeDecision({ ...base, notifiedAdministrationId: 42 }).kind
    ).toBe("already-notified");
  });

  it("RE-ARMS on a NEWER administration (marker holds the OLD id)", () => {
    // Marker still points at the old administration (41); a new one (42) is latest →
    // eligible again.
    const d = redoseNoticeDecision({ ...base, notifiedAdministrationId: 41 });
    expect(d.kind).toBe("fire");
  });

  it("SUPPRESSED at the confirmed daily max (window open but count reached)", () => {
    expect(redoseNoticeDecision({ ...base, countToday: 4 }).kind).toBe(
      "suppressed-max"
    );
    expect(redoseNoticeDecision({ ...base, countToday: 5 }).kind).toBe(
      "suppressed-max"
    );
  });

  it("does NOT consider quiet hours — a 3am elapse still fires (no waking input)", () => {
    // The decision has no hour/waking-window field at all: proof the notice is
    // overnight-capable by construction.
    const overnight = new Date("2026-07-16T03:00:00Z");
    const d = redoseNoticeDecision({
      ...base,
      // The interval opens at 03:00 — the overnight case, inside the first band.
      latestGivenAt: new Date("2026-07-15T21:00:00Z"),
      now: overnight,
    });
    expect(d.kind).toBe("fire");
  });

  it("does not catch up on a redose window that opened weeks ago", () => {
    expect(
      redoseNoticeDecision({ ...base, now: hoursAfter(6 + 554) }).kind
    ).toBe("missed-window");
  });

  it("has one bounded retry band an hour after the window opens", () => {
    expect(redoseNoticeDecision({ ...base, now: hoursAfter(7) }).kind).toBe(
      "fire"
    );
    expect(redoseNoticeDecision({ ...base, now: hoursAfter(7.2) }).kind).toBe(
      "missed-window"
    );
  });
});

describe("redoseWindowStatus — marker-agnostic surfacing", () => {
  it("null when nothing logged", () => {
    expect(
      redoseWindowStatus({
        minIntervalHours: 6,
        maxDailyCount: 4,
        latestGivenAt: null,
        countToday: 0,
        now: GIVEN,
      })
    ).toBeNull();
  });

  it("open + not-at-max before/after the interval", () => {
    const closed = redoseWindowStatus({
      minIntervalHours: 6,
      maxDailyCount: 4,
      latestGivenAt: GIVEN,
      countToday: 2,
      now: hoursAfter(3),
    })!;
    expect(closed.open).toBe(false);
    expect(closed.opensInHours).toBeCloseTo(3, 5);
    expect(closed.atMax).toBe(false);

    const open = redoseWindowStatus({
      minIntervalHours: 6,
      maxDailyCount: 4,
      latestGivenAt: GIVEN,
      countToday: 4,
      now: hoursAfter(7),
    })!;
    expect(open.open).toBe(true);
    expect(open.atMax).toBe(true);
  });
});

// #1458: the sick-kid config — "Minimum hours between doses = 6", "Maximum doses per
// day" left blank. The window half is fully computable from the interval alone, so the
// status must exist; only the ceiling half degrades.
describe("redoseWindowStatus — interval-only config (#1458)", () => {
  it("describes the window with no confirmed daily max, and is never atMax", () => {
    const before = redoseWindowStatus({
      minIntervalHours: 6,
      maxDailyCount: null,
      latestGivenAt: GIVEN,
      countToday: 1,
      now: hoursAfter(1),
    })!;
    expect(before).not.toBeNull();
    expect(before.open).toBe(false);
    expect(before.opensInHours).toBeCloseTo(5, 5);
    expect(before.maxDailyCount).toBeNull();
    expect(before.atMax).toBe(false);

    const after = redoseWindowStatus({
      minIntervalHours: 6,
      maxDailyCount: null,
      latestGivenAt: GIVEN,
      countToday: 9,
      now: hoursAfter(7),
    })!;
    expect(after.open).toBe(true);
    // An unconfigured ceiling is never a reached one, however high the count runs.
    expect(after.atMax).toBe(false);
  });

  it("still returns null when nothing has been logged", () => {
    expect(
      redoseWindowStatus({
        minIntervalHours: 6,
        maxDailyCount: null,
        latestGivenAt: null,
        countToday: 0,
        now: GIVEN,
      })
    ).toBeNull();
  });
});

describe("effectiveMaxDailyCount (#1027 widening, #1458 degradation)", () => {
  it("takes the most conservative confirmed max", () => {
    expect(effectiveMaxDailyCount(6, 4)).toBe(4);
    expect(effectiveMaxDailyCount(4, 6)).toBe(4);
  });

  it("falls back to whichever side is confirmed", () => {
    expect(effectiveMaxDailyCount(null, 4)).toBe(4);
    expect(effectiveMaxDailyCount(4, null)).toBe(4);
    expect(effectiveMaxDailyCount(4, undefined)).toBe(4);
  });

  it("is null when no member carries a confirmed max", () => {
    expect(effectiveMaxDailyCount(null, null)).toBeNull();
    expect(effectiveMaxDailyCount(undefined, undefined)).toBeNull();
    // A stored 0 is not a confirmed ceiling.
    expect(effectiveMaxDailyCount(0, null)).toBeNull();
  });
});

describe("prnMaxSignalKey", () => {
  it("keys on the item id under the registered prefix", () => {
    expect(prnMaxSignalKey(7)).toBe(`${PRN_MAX_PREFIX}7`);
  });
});

// ---- Amount-aware day exposure (#1854) --------------------------------------

describe("parseAmountMg", () => {
  it("parses a leading number + mass unit, mg canonical", () => {
    expect(parseAmountMg("200 mg")).toBe(200);
    expect(parseAmountMg("200mg")).toBe(200);
    expect(parseAmountMg("0.5 g")).toBe(500);
    expect(parseAmountMg("500 mcg")).toBe(0.5);
    expect(parseAmountMg("500 µg")).toBe(0.5);
  });

  it("takes the administered mg off a liquid concentration line", () => {
    expect(parseAmountMg("240 mg / 7.5 mL")).toBe(240);
    expect(parseAmountMg("160 mg per 5 mL")).toBe(160);
  });

  it("refuses anything that is not a mass — never a guess", () => {
    expect(parseAmountMg("2 tablets")).toBeNull();
    expect(parseAmountMg("1 capsule")).toBeNull();
    expect(parseAmountMg("400 IU")).toBeNull();
    expect(parseAmountMg("5 mL")).toBeNull();
    expect(parseAmountMg("")).toBeNull();
    expect(parseAmountMg(null)).toBeNull();
    expect(parseAmountMg(undefined)).toBeNull();
    // A per-kg rate is a rate, not an administered amount.
    expect(parseAmountMg("10 mg/kg")).toBeNull();
  });
});

describe("prnDayExposure — basis selection (#1854)", () => {
  it("mg basis when the mg max is confirmed and every amount parses (3 × 800 mg vs 1200 mg/day)", () => {
    expect(
      prnDayExposure({
        amounts: ["800 mg", "800 mg", "800 mg"],
        maxDailyAmountMg: 1200,
        maxDailyCount: 6,
      })
    ).toEqual({
      basis: "mg",
      total: 2400,
      max: 1200,
      over: true,
      atMax: true,
      unknownAmounts: 0,
    });
  });

  it("mg basis stays calm when the milligrams are under the ceiling a count would have tripped", () => {
    const e = prnDayExposure({
      amounts: ["200 mg", "200 mg", "200 mg", "200 mg", "200 mg"],
      maxDailyAmountMg: 1200,
      maxDailyCount: 4, // 5 rows would be over on the count basis
    });
    expect(e).toMatchObject({ basis: "mg", total: 1000, over: false });
  });

  it("count fallback when an amount does not parse and a count max exists", () => {
    const e = prnDayExposure({
      amounts: ["800 mg", "1 tablet"],
      maxDailyAmountMg: 1200,
      maxDailyCount: 1,
    });
    expect(e).toEqual({
      basis: "count",
      total: 2,
      max: 1,
      over: true,
      atMax: true,
      unknownAmounts: 0,
    });
  });

  it("count basis when no mg max is confirmed", () => {
    const e = prnDayExposure({
      amounts: ["800 mg", "800 mg"],
      maxDailyAmountMg: null,
      maxDailyCount: 4,
    });
    expect(e).toMatchObject({ basis: "count", total: 2, over: false });
  });

  it("mg lower bound when there is NO count fallback: known sum judged, unknowns counted", () => {
    const e = prnDayExposure({
      amounts: ["800 mg", "800 mg", "1 tablet"],
      maxDailyAmountMg: 1200,
      maxDailyCount: null,
    });
    expect(e).toEqual({
      basis: "mg",
      total: 1600,
      max: 1200,
      over: true,
      atMax: true,
      unknownAmounts: 1,
    });
  });

  it("atMax without over at exactly the ceiling", () => {
    const e = prnDayExposure({
      amounts: ["600 mg", "600 mg"],
      maxDailyAmountMg: 1200,
      maxDailyCount: null,
    });
    expect(e).toMatchObject({ over: false, atMax: true });
  });

  it("null when NO ceiling is confirmed (the liability gate) — a 0 is not a ceiling", () => {
    expect(
      prnDayExposure({
        amounts: ["800 mg"],
        maxDailyAmountMg: null,
        maxDailyCount: null,
      })
    ).toBeNull();
    expect(
      prnDayExposure({
        amounts: ["800 mg"],
        maxDailyAmountMg: 0,
        maxDailyCount: 0,
      })
    ).toBeNull();
  });

  it("an empty day on the mg basis is 0 of max", () => {
    expect(
      prnDayExposure({ amounts: [], maxDailyAmountMg: 1200, maxDailyCount: 6 })
    ).toMatchObject({ basis: "mg", total: 0, over: false, atMax: false });
  });
});

describe("redoseNoticeDecision × exposure (#1854)", () => {
  it("suppresses at the mg ceiling although the count reads calm", () => {
    const d = redoseNoticeDecision({
      ...base,
      countToday: 3, // < maxDailyCount 4 — the pre-#1854 gate would fire
      exposure: prnDayExposure({
        amounts: ["800 mg", "800 mg", "800 mg"],
        maxDailyAmountMg: 1200,
        maxDailyCount: 4,
      }),
    });
    expect(d.kind).toBe("suppressed-max");
  });

  it("fires under the mg ceiling although the count would have suppressed, and carries the exposure", () => {
    const exposure = prnDayExposure({
      amounts: ["200 mg", "200 mg", "200 mg", "200 mg"],
      maxDailyAmountMg: 2400,
      maxDailyCount: 4,
    });
    const d = redoseNoticeDecision({
      ...base,
      countToday: 4, // == maxDailyCount — the count gate would suppress
      exposure,
    });
    expect(d.kind).toBe("fire");
    if (d.kind === "fire") expect(d.exposure).toEqual(exposure);
  });

  it("a null exposure keeps the count gate exactly as before", () => {
    const d = redoseNoticeDecision({ ...base, countToday: 4, exposure: null });
    expect(d.kind).toBe("suppressed-max");
  });
});

describe("redoseWindowStatus × exposure (#1854)", () => {
  it("atMax follows the exposure verdict and the exposure rides the status", () => {
    const exposure = prnDayExposure({
      amounts: ["800 mg", "800 mg", "800 mg"],
      maxDailyAmountMg: 1200,
      maxDailyCount: 6,
    });
    const s = redoseWindowStatus({
      minIntervalHours: 6,
      maxDailyCount: 6,
      latestGivenAt: GIVEN,
      countToday: 3,
      now: hoursAfter(7),
      exposure,
    })!;
    expect(s.atMax).toBe(true); // 2400 mg ≥ 1200 mg/day; "3 of 6" would read calm
    expect(s.exposure).toEqual(exposure);
  });
});
