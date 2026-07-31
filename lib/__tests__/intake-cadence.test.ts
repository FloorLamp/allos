import { describe, expect, it } from "vitest";
import {
  cadenceDensity,
  cadenceLabel,
  cadenceOn,
  doseCadenceLabel,
  doseOnDay,
  hasCadence,
  normalizeWeekdays,
  parseWeekdays,
} from "@/lib/intake-cadence";
import { doseDueOn, isDueOn, isOfferedOn } from "@/lib/supplement-schedule";

// The calendar half of intake dueness (issue #1602). These are the rules that decide
// whether a weekly methotrexate is due TODAY, so the cases below are deliberately
// weighted toward the ways a date rule goes wrong quietly: the DST boundary, a
// month/year rollover, an anchor in the future, and a half-configured cadence.

// Fixed calendar anchors used throughout. 2026-03-04 is a Wednesday.
const WED = "2026-03-04";
const THU = "2026-03-05";
const MON = "2026-03-02";
const SUN = "2026-03-01";

const ctx = (date: string) => ({
  date,
  isWorkoutDay: false,
  activeSituations: new Set<string>(),
});

describe("parseWeekdays / normalizeWeekdays", () => {
  it("round-trips a canonical CSV", () => {
    expect([...parseWeekdays("1,4")].sort()).toEqual([1, 4]);
    expect(normalizeWeekdays([4, 1])).toBe("1,4");
  });

  it("is TOTAL on garbage rather than throwing (it runs inside a reminder tick)", () => {
    expect(parseWeekdays("banana").size).toBe(0);
    expect(parseWeekdays("9,-2,x").size).toBe(0);
    expect(parseWeekdays(null).size).toBe(0);
    expect(parseWeekdays("").size).toBe(0);
  });

  it("de-duplicates and sorts on the write side so a no-op edit stores identically", () => {
    expect(normalizeWeekdays([3, 1, 3, 1])).toBe("1,3");
    expect(normalizeWeekdays([])).toBeNull();
    expect(normalizeWeekdays([99])).toBeNull();
  });
});

describe("cadenceOn — weekly", () => {
  it("lands only on the chosen weekdays", () => {
    const weekly = { cadence_kind: "weekly" as const, cadence_weekdays: "1" };
    expect(cadenceOn(weekly, MON)).toBe(true);
    expect(cadenceOn(weekly, WED)).toBe(false);
  });

  it("supports several days (Mon+Thu)", () => {
    const mw = { cadence_kind: "weekly" as const, cadence_weekdays: "1,4" };
    expect(cadenceOn(mw, MON)).toBe(true);
    expect(cadenceOn(mw, THU)).toBe(true);
    expect(cadenceOn(mw, WED)).toBe(false);
  });

  it("treats Sunday as 0, matching lib/date's weekdayOfDateStr (not ISO 7)", () => {
    const sunday = { cadence_kind: "weekly" as const, cadence_weekdays: "0" };
    expect(cadenceOn(sunday, SUN)).toBe(true);
    expect(cadenceOn(sunday, MON)).toBe(false);
  });

  // The safety-critical direction: half-configured must behave like the daily item it
  // was, never like an item that is silently never due.
  it("FAILS OPEN when no weekday is configured", () => {
    expect(
      cadenceOn({ cadence_kind: "weekly", cadence_weekdays: null }, WED)
    ).toBe(true);
    expect(
      cadenceOn({ cadence_kind: "weekly", cadence_weekdays: "" }, WED)
    ).toBe(true);
    expect(
      cadenceOn({ cadence_kind: "weekly", cadence_weekdays: "junk" }, WED)
    ).toBe(true);
  });
});

describe("cadenceOn — interval", () => {
  const every3 = {
    cadence_kind: "interval" as const,
    cadence_interval_days: 3,
    cadence_anchor_date: "2026-03-01",
  };

  it("lands on the anchor and every N days after it", () => {
    expect(cadenceOn(every3, "2026-03-01")).toBe(true);
    expect(cadenceOn(every3, "2026-03-02")).toBe(false);
    expect(cadenceOn(every3, "2026-03-03")).toBe(false);
    expect(cadenceOn(every3, "2026-03-04")).toBe(true);
  });

  // A negative delta divisible by the interval would otherwise read as an on-day, so a
  // patch anchored on the 10th would be "due" on the 7th — before it was ever started.
  it("is never due BEFORE the anchor, even on a divisible offset", () => {
    expect(cadenceOn(every3, "2026-02-26")).toBe(false);
    expect(cadenceOn(every3, "2026-02-28")).toBe(false);
  });

  it("crosses a MONTH boundary by real day count, not by day-of-month arithmetic", () => {
    // 2026-02-27 + 3 = 2026-03-02 (February has 28 days in 2026).
    const feb = {
      cadence_kind: "interval" as const,
      cadence_interval_days: 3,
      cadence_anchor_date: "2026-02-27",
    };
    expect(cadenceOn(feb, "2026-03-02")).toBe(true);
    expect(cadenceOn(feb, "2026-03-01")).toBe(false);
  });

  it("crosses a YEAR boundary", () => {
    const ny = {
      cadence_kind: "interval" as const,
      cadence_interval_days: 7,
      cadence_anchor_date: "2025-12-29",
    };
    expect(cadenceOn(ny, "2026-01-05")).toBe(true);
    expect(cadenceOn(ny, "2026-01-04")).toBe(false);
  });

  // The stored dates are calendar days compared UTC-anchored, so a spring-forward day
  // (23 real hours) must not shift the count. US DST 2026 starts 2026-03-08.
  it("is DST-immune across a spring-forward boundary", () => {
    const dst = {
      cadence_kind: "interval" as const,
      cadence_interval_days: 2,
      cadence_anchor_date: "2026-03-06",
    };
    expect(cadenceOn(dst, "2026-03-08")).toBe(true); // the short day itself
    expect(cadenceOn(dst, "2026-03-10")).toBe(true); // and the day after it
    expect(cadenceOn(dst, "2026-03-09")).toBe(false);
  });

  it("FAILS OPEN on a missing, zero, negative or absurd configuration", () => {
    const base = { cadence_kind: "interval" as const };
    expect(cadenceOn({ ...base, cadence_interval_days: null }, WED)).toBe(true);
    expect(
      cadenceOn(
        {
          ...base,
          cadence_interval_days: 0,
          cadence_anchor_date: "2026-03-01",
        },
        WED
      )
    ).toBe(true);
    expect(
      cadenceOn(
        {
          ...base,
          cadence_interval_days: -3,
          cadence_anchor_date: "2026-03-01",
        },
        WED
      )
    ).toBe(true);
    // Interval 1 IS daily — no need to consult an anchor at all.
    expect(cadenceOn({ ...base, cadence_interval_days: 1 }, WED)).toBe(true);
    // A configured interval with no usable anchor cannot be counted from.
    expect(
      cadenceOn(
        { ...base, cadence_interval_days: 3, cadence_anchor_date: "nonsense" },
        WED
      )
    ).toBe(true);
  });
});

describe("cadenceOn — daily", () => {
  it("is every day, including when the row carries stale weekday/interval values", () => {
    expect(cadenceOn({}, WED)).toBe(true);
    expect(cadenceOn({ cadence_kind: "daily" }, WED)).toBe(true);
    expect(
      cadenceOn({ cadence_kind: "daily", cadence_weekdays: "1" }, WED)
    ).toBe(true);
  });
});

describe("doseOnDay", () => {
  it("has no opinion when the row carries no calendar", () => {
    expect(doseOnDay({}, WED)).toBe(true);
  });

  // The alternating-amount case: one item, two rows, each with its own history.
  it("splits alternating amounts by weekday", () => {
    const five = { weekdays: "1,3,5" }; // Mon/Wed/Fri
    const half = { weekdays: "0,2,4,6" }; // the rest
    expect(doseOnDay(five, WED)).toBe(true);
    expect(doseOnDay(half, WED)).toBe(false);
    expect(doseOnDay(five, THU)).toBe(false);
    expect(doseOnDay(half, THU)).toBe(true);
  });

  it("honours an INCLUSIVE validity window at both ends", () => {
    const win = { start_date: "2026-03-02", end_date: "2026-03-04" };
    expect(doseOnDay(win, "2026-03-01")).toBe(false);
    expect(doseOnDay(win, "2026-03-02")).toBe(true);
    expect(doseOnDay(win, "2026-03-04")).toBe(true);
    expect(doseOnDay(win, "2026-03-05")).toBe(false);
  });

  it("treats a one-sided window as open at the other end", () => {
    expect(doseOnDay({ start_date: "2026-03-02" }, "2026-12-31")).toBe(true);
    expect(doseOnDay({ end_date: "2026-03-02" }, "2020-01-01")).toBe(true);
  });

  it("ANDs the weekday subset with the window", () => {
    const row = { weekdays: "3", start_date: "2026-03-10" };
    expect(doseOnDay(row, WED)).toBe(false); // right weekday, before the window
    expect(doseOnDay(row, "2026-03-11")).toBe(true); // Wednesday, inside it
  });

  // A four-row prednisone taper: 40 → 30 → 20 → 10, one week each, no amount ever
  // edited and therefore no adherence history ever rewritten.
  it("expresses a taper as consecutive windows with exactly one row live per day", () => {
    const taper = [
      { amount: "40 mg", start_date: "2026-03-01", end_date: "2026-03-07" },
      { amount: "30 mg", start_date: "2026-03-08", end_date: "2026-03-14" },
      { amount: "20 mg", start_date: "2026-03-15", end_date: "2026-03-21" },
      { amount: "10 mg", start_date: "2026-03-22", end_date: "2026-03-28" },
    ];
    for (const [date, expected] of [
      ["2026-03-04", "40 mg"],
      ["2026-03-09", "30 mg"],
      ["2026-03-16", "20 mg"],
      ["2026-03-23", "10 mg"],
    ] as const) {
      const live = taper.filter((d) => doseOnDay(d, date));
      expect(live.map((d) => d.amount)).toEqual([expected]);
    }
    // After the last window every row is silent — without any of them being retired.
    expect(taper.filter((d) => doseOnDay(d, "2026-04-01"))).toEqual([]);
  });
});

describe("cadence composes into the dueness gate", () => {
  const weeklyMust = {
    condition: "daily" as const,
    situation: null,
    obligation: "must" as const,
    cadence_kind: "weekly" as const,
    cadence_weekdays: "1",
  };

  // The whole point of the issue: the item stays `must` — reminders and escalation
  // intact — and the machinery says "not today" instead of the user having to silence
  // it by demoting it.
  it("a weekly `must` item is due on its day and NOT due on the others", () => {
    expect(isDueOn(weeklyMust, ctx(MON))).toBe(true);
    expect(isDueOn(weeklyMust, ctx(WED))).toBe(false);
  });

  it("cadence never INVENTS obligation — a `may` item is still never due", () => {
    expect(isDueOn({ ...weeklyMust, obligation: "may" }, ctx(MON))).toBe(false);
  });

  // Guaranteed access: a collapsed item must not become indistinguishable from a
  // deleted one, so on a `may` item the cadence is a label and never a gate.
  it("a `may` item stays OFFERED on its off-days", () => {
    const mayWeekly = { ...weeklyMust, obligation: "may" as const };
    expect(isOfferedOn(mayWeekly, ctx(MON))).toBe(true);
    expect(isOfferedOn(mayWeekly, ctx(WED))).toBe(true);
  });

  it("doseDueOn ANDs the item cadence with the row's own calendar", () => {
    const row = { weekdays: "1" };
    const otherRow = { weekdays: "4" };
    expect(doseDueOn(weeklyMust, row, ctx(MON))).toBe(true);
    // The row wants Thursday, the item only does Mondays: neither day is due.
    expect(doseDueOn(weeklyMust, otherRow, ctx(MON))).toBe(false);
    expect(doseDueOn(weeklyMust, otherRow, ctx(THU))).toBe(false);
  });

  it("a held item is still not due on a cadence day (held beats everything)", () => {
    const held = { ...weeklyMust, pause_situation: "Pre-surgery" };
    expect(
      isDueOn(held, { ...ctx(MON), activeSituations: new Set(["Pre-surgery"]) })
    ).toBe(false);
  });
});

describe("cadenceDensity — the refill projection input", () => {
  it("is 1 for daily and for a fail-open cadence", () => {
    expect(cadenceDensity({})).toBe(1);
    expect(
      cadenceDensity({ cadence_kind: "weekly", cadence_weekdays: null })
    ).toBe(1);
    expect(
      cadenceDensity({ cadence_kind: "interval", cadence_interval_days: null })
    ).toBe(1);
  });

  it("scales with the number of weekly days", () => {
    expect(
      cadenceDensity({ cadence_kind: "weekly", cadence_weekdays: "1" })
    ).toBeCloseTo(1 / 7);
    expect(
      cadenceDensity({ cadence_kind: "weekly", cadence_weekdays: "1,3,5" })
    ).toBeCloseTo(3 / 7);
  });

  it("is the reciprocal of an interval", () => {
    expect(
      cadenceDensity({ cadence_kind: "interval", cadence_interval_days: 3 })
    ).toBeCloseTo(1 / 3);
  });

  // 12 tablets of a once-weekly med are ~12 weeks of supply, not ~12 days — the
  // difference between a refill nudge that is useful and one that fires every week.
  it("turns 12 weekly tablets into ~84 days of supply rather than ~12", () => {
    const density = cadenceDensity({
      cadence_kind: "weekly",
      cadence_weekdays: "1",
    });
    expect(12 / (1 * density)).toBeCloseTo(84);
  });
});

describe("labels", () => {
  it("names a single weekday in the plural and a set with slashes", () => {
    expect(
      cadenceLabel({ cadence_kind: "weekly", cadence_weekdays: "1" })
    ).toBe("Mondays");
    expect(
      cadenceLabel({ cadence_kind: "weekly", cadence_weekdays: "1,4" })
    ).toBe("Mon/Thu");
  });

  it("says nothing for a plain daily item (a qualifier everywhere would be noise)", () => {
    expect(cadenceLabel({})).toBeNull();
    expect(cadenceLabel({ cadence_kind: "daily" })).toBeNull();
    // All seven days IS daily, however it was reached.
    expect(
      cadenceLabel({
        cadence_kind: "weekly",
        cadence_weekdays: "0,1,2,3,4,5,6",
      })
    ).toBeNull();
    expect(
      cadenceLabel({ cadence_kind: "interval", cadence_interval_days: 1 })
    ).toBeNull();
  });

  it("names an interval, with the everyday-English case for 2", () => {
    expect(
      cadenceLabel({ cadence_kind: "interval", cadence_interval_days: 2 })
    ).toBe("Every other day");
    expect(
      cadenceLabel({ cadence_kind: "interval", cadence_interval_days: 3 })
    ).toBe("Every 3 days");
  });

  // A label must carry the attribute that actually distinguishes two otherwise
  // identical rows, or an alternating pair reads as two mystery duplicates.
  it("distinguishes the rows of an alternating pair", () => {
    expect(doseCadenceLabel({ weekdays: "1,3,5" })).toBe("Mon/Wed/Fri");
    expect(doseCadenceLabel({ weekdays: "0,2,4,6" })).toBe("Sun/Tue/Thu/Sat");
    expect(doseCadenceLabel({})).toBeNull();
  });

  it("names a dose window", () => {
    expect(doseCadenceLabel({ end_date: "2026-03-07" })).toBe(
      "until 2026-03-07"
    );
    expect(doseCadenceLabel({ start_date: "2026-03-08" })).toBe(
      "from 2026-03-08"
    );
    expect(
      doseCadenceLabel({ start_date: "2026-03-08", end_date: "2026-03-14" })
    ).toBe("2026-03-08 to 2026-03-14");
    expect(doseCadenceLabel({ weekdays: "1", start_date: "2026-03-08" })).toBe(
      "Mon · from 2026-03-08"
    );
  });

  it("hasCadence is the cheap UI predicate over the same rule", () => {
    expect(hasCadence({})).toBe(false);
    expect(hasCadence({ cadence_kind: "weekly", cadence_weekdays: "1" })).toBe(
      true
    );
  });
});
