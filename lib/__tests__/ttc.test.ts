import { describe, expect, it } from "vitest";
import {
  BBT_MIN_BASELINE_READINGS,
  BBT_RISE_THRESHOLD_F,
  FERTILE_DAYS_BEFORE_OVULATION,
  LH_SURGE_TO_OVULATION_DAYS,
  MUCUS_QUALITIES,
  PROGESTERONE_DRAW_DAYS_AFTER_OVULATION,
  TTC_WORKUP_MONTHS,
  TTC_WORKUP_MONTHS_OLDER,
  TTC_WORKUP_OLDER_AGE,
  TTC_WORKUP_PREFIX,
  confirmOvulation,
  decideWorkupPrompt,
  fertileWindow,
  isFertileMucus,
  lutealPhaseLengthDays,
  mucusFromOrdinal,
  mucusOrdinal,
  progesteroneTiming,
  tryingDuration,
  workupThresholdMonths,
  type DatedTemperature,
} from "@/lib/ttc";
import { shiftDateStr } from "@/lib/date";

// PURE TIER — the #1680 trying-to-conceive derivations. No DB, no clock: every case names
// its own deep-past dates, so nothing drifts with the wall clock.

const TODAY = "2019-06-10";

// A plausible follicular baseline series ending the day before `TODAY`'s cycle work.
function series(startDate: string, temps: number[]): DatedTemperature[] {
  return temps.map((degF, i) => ({ date: shiftDateStr(startDate, i), degF }));
}

describe("mucus vocabulary — one ordinal mapping, both directions", () => {
  it("round-trips every quality through its stored 1–4 ordinal", () => {
    for (const q of MUCUS_QUALITIES) {
      expect(mucusFromOrdinal(mucusOrdinal(q))).toBe(q);
    }
    expect(mucusOrdinal("dry")).toBe(1);
    expect(mucusOrdinal("egg_white")).toBe(MUCUS_QUALITIES.length);
    expect(mucusFromOrdinal(0)).toBeNull();
    expect(mucusFromOrdinal(9)).toBeNull();
  });

  it("treats creamy and egg-white as the fertile pattern, dry and sticky as not", () => {
    expect(isFertileMucus("dry")).toBe(false);
    expect(isFertileMucus("sticky")).toBe(false);
    expect(isFertileMucus("creamy")).toBe(true);
    expect(isFertileMucus("egg_white")).toBe(true);
  });
});

describe("fertileWindow — evidence ranking (LH > mucus > calendar)", () => {
  const calendar = {
    estimatedDate: "2019-06-16",
    windowStart: "2019-06-14",
    windowEnd: "2019-06-18",
  };

  it("a positive LH test today wins over mucus and calendar", () => {
    const w = fertileWindow({
      today: TODAY,
      lhTests: [{ date: TODAY, result: "positive" }],
      mucus: [{ date: TODAY, quality: "egg_white" }],
      calendarOvulation: calendar,
    });
    expect(w?.evidence).toBe("lh");
    expect(w?.start).toBe(TODAY);
    expect(w?.end).toBe(shiftDateStr(TODAY, LH_SURGE_TO_OVULATION_DAYS));
  });

  it("fertile mucus wins over the calendar when no surge is recorded", () => {
    const w = fertileWindow({
      today: TODAY,
      lhTests: [{ date: TODAY, result: "negative" }],
      mucus: [{ date: TODAY, quality: "creamy" }],
      calendarOvulation: calendar,
    });
    expect(w?.evidence).toBe("mucus");
    expect(w?.basisDate).toBe(TODAY);
  });

  it("non-fertile mucus does not outrank the calendar", () => {
    const w = fertileWindow({
      today: TODAY,
      lhTests: [],
      mucus: [{ date: TODAY, quality: "sticky" }],
      calendarOvulation: calendar,
    });
    expect(w?.evidence).toBe("calendar");
  });

  it("a stale positive LH test no longer describes the current window", () => {
    const w = fertileWindow({
      today: TODAY,
      lhTests: [{ date: shiftDateStr(TODAY, -4), result: "positive" }],
      mucus: [],
      calendarOvulation: calendar,
    });
    expect(w?.evidence).toBe("calendar");
  });

  it("the calendar window spans the fertile days around the estimate", () => {
    const w = fertileWindow({
      today: TODAY,
      lhTests: [],
      mucus: [],
      calendarOvulation: calendar,
    });
    expect(w?.start).toBe(
      shiftDateStr(calendar.windowStart, -FERTILE_DAYS_BEFORE_OVULATION)
    );
    expect(w?.basisDate).toBe(calendar.estimatedDate);
  });

  it("returns nothing with no evidence at all", () => {
    expect(
      fertileWindow({
        today: TODAY,
        lhTests: [],
        mucus: [],
        calendarOvulation: null,
      })
    ).toBeNull();
  });

  it("returns nothing while a pregnancy is recorded, whatever the evidence", () => {
    expect(
      fertileWindow({
        today: TODAY,
        lhTests: [{ date: TODAY, result: "positive" }],
        mucus: [{ date: TODAY, quality: "egg_white" }],
        calendarOvulation: calendar,
        suspended: true,
      })
    ).toBeNull();
  });
});

describe("confirmOvulation — a sustained rise, read retrospectively", () => {
  it("finds the classic three-over-six rise and dates ovulation the day before", () => {
    // Six baseline mornings around 97.3, then three clearly elevated ones.
    const readings = series(
      "2019-05-20",
      [97.3, 97.2, 97.4, 97.3, 97.2, 97.3, 97.9, 98.0, 97.9]
    );
    const c = confirmOvulation(readings);
    expect(c).not.toBeNull();
    expect(c?.firstHighDate).toBe("2019-05-26");
    expect(c?.ovulationDate).toBe("2019-05-25");
    expect(c?.baselineF).toBe(97.4);
    expect(c?.riseF).toBeGreaterThanOrEqual(BBT_RISE_THRESHOLD_F);
  });

  it("ignores a noisy blip that isn't sustained", () => {
    const readings = series(
      "2019-05-20",
      [97.3, 97.2, 97.4, 97.3, 97.2, 97.3, 98.1, 97.2, 97.3, 97.2]
    );
    expect(confirmOvulation(readings)).toBeNull();
  });

  it("ignores a sustained rise smaller than the threshold", () => {
    const readings = series(
      "2019-05-20",
      [97.3, 97.2, 97.4, 97.3, 97.2, 97.3, 97.5, 97.5, 97.5]
    );
    expect(confirmOvulation(readings)).toBeNull();
  });

  it("works across missed mornings — the rule counts READINGS, not calendar days", () => {
    // A six-reading baseline spread over nine days, then three elevated readings with a
    // gap in the middle. The rise is real; the missed mornings must not hide it.
    const readings: DatedTemperature[] = [
      { date: "2019-05-20", degF: 97.3 },
      { date: "2019-05-21", degF: 97.2 },
      { date: "2019-05-23", degF: 97.4 },
      { date: "2019-05-24", degF: 97.3 },
      { date: "2019-05-27", degF: 97.2 },
      { date: "2019-05-28", degF: 97.3 },
      { date: "2019-05-30", degF: 97.9 },
      { date: "2019-06-01", degF: 98.0 },
      { date: "2019-06-02", degF: 97.95 },
    ];
    const c = confirmOvulation(readings);
    expect(c?.firstHighDate).toBe("2019-05-30");
    expect(c?.ovulationDate).toBe("2019-05-28");
  });

  it("refuses to call a rise off too thin a baseline", () => {
    const readings = series("2019-05-20", [97.3, 97.2, 97.9, 98.0, 97.9]);
    expect(readings.length).toBeLessThan(BBT_MIN_BASELINE_READINGS + 3);
    expect(confirmOvulation(readings)).toBeNull();
  });

  it("sorts an out-of-order series before reading it", () => {
    const ordered = series(
      "2019-05-20",
      [97.3, 97.2, 97.4, 97.3, 97.2, 97.3, 97.9, 98.0, 97.9]
    );
    const shuffled = [...ordered].reverse();
    expect(confirmOvulation(shuffled)).toEqual(confirmOvulation(ordered));
  });
});

describe("lutealPhaseLengthDays", () => {
  it("counts confirmed ovulation → the next period start", () => {
    expect(lutealPhaseLengthDays("2019-05-25", "2019-06-07")).toBe(13);
  });

  it("returns null when the next period isn't after the ovulation date", () => {
    expect(lutealPhaseLengthDays("2019-06-07", "2019-06-07")).toBeNull();
    expect(lutealPhaseLengthDays("2019-06-07", "2019-05-25")).toBeNull();
  });
});

describe("progesteroneTiming — legibility, not interpretation", () => {
  it("names a mid-luteal draw", () => {
    const t = progesteroneTiming(
      shiftDateStr("2019-05-25", PROGESTERONE_DRAW_DAYS_AFTER_OVULATION),
      "2019-05-25"
    );
    expect(t?.daysAfterOvulation).toBe(PROGESTERONE_DRAW_DAYS_AFTER_OVULATION);
    expect(t?.midLuteal).toBe(true);
  });

  it("flags a draw well outside the mid-luteal window", () => {
    const t = progesteroneTiming("2019-06-05", "2019-05-25");
    expect(t?.midLuteal).toBe(false);
    expect(t?.daysAfterOvulation).toBe(11);
  });

  it("says nothing about a draw that precedes ovulation", () => {
    expect(progesteroneTiming("2019-05-20", "2019-05-25")).toBeNull();
  });
});

describe("tryingDuration — declared start only", () => {
  it("reports elapsed months, days and cycles attempted", () => {
    const d = tryingDuration("2018-06-10", "2019-06-10", [
      "2018-05-01", // before the declared start — not counted
      "2018-07-03",
      "2018-08-01",
    ]);
    expect(d?.months).toBe(12);
    expect(d?.days).toBe(365);
    expect(d?.cyclesAttempted).toBe(2);
  });

  it("returns null for a future or unparseable start", () => {
    expect(tryingDuration("2019-07-01", "2019-06-10")).toBeNull();
    expect(tryingDuration("not-a-date", "2019-06-10")).toBeNull();
  });
});

describe("decideWorkupPrompt — the 12-month / 6-month-over-35 boundaries", () => {
  it("uses the longer threshold below the age line and for an unknown age", () => {
    expect(workupThresholdMonths(30)).toBe(TTC_WORKUP_MONTHS);
    expect(workupThresholdMonths(null)).toBe(TTC_WORKUP_MONTHS);
    expect(workupThresholdMonths(TTC_WORKUP_OLDER_AGE - 1)).toBe(
      TTC_WORKUP_MONTHS
    );
  });

  it("shortens the threshold at the age line", () => {
    expect(workupThresholdMonths(TTC_WORKUP_OLDER_AGE)).toBe(
      TTC_WORKUP_MONTHS_OLDER
    );
    expect(workupThresholdMonths(41)).toBe(TTC_WORKUP_MONTHS_OLDER);
  });

  it("stays silent one month short and speaks exactly at the threshold", () => {
    const short = decideWorkupPrompt({
      ttcStart: "2018-07-10",
      today: "2019-06-10", // 11 months
      age: 30,
    });
    expect(short).toBeNull();

    const at = decideWorkupPrompt({
      ttcStart: "2018-06-10",
      today: "2019-06-10", // 12 months
      age: 30,
    });
    expect(at?.months).toBe(TTC_WORKUP_MONTHS);
    expect(at?.dedupeKey).toBe(`${TTC_WORKUP_PREFIX}2018-06-10`);
    expect(at?.thresholdMonths).toBe(TTC_WORKUP_MONTHS);
  });

  it("speaks six months earlier from the older-age line", () => {
    const at = decideWorkupPrompt({
      ttcStart: "2018-12-10",
      today: "2019-06-10", // 6 months
      age: TTC_WORKUP_OLDER_AGE,
    });
    expect(at?.thresholdMonths).toBe(TTC_WORKUP_MONTHS_OLDER);

    const younger = decideWorkupPrompt({
      ttcStart: "2018-12-10",
      today: "2019-06-10",
      age: TTC_WORKUP_OLDER_AGE - 1,
    });
    expect(younger).toBeNull();
  });

  it("says nothing without a declaration, and nothing during a pregnancy", () => {
    expect(
      decideWorkupPrompt({ ttcStart: null, today: "2019-06-10", age: 40 })
    ).toBeNull();
    expect(
      decideWorkupPrompt({
        ttcStart: "2017-01-01",
        today: "2019-06-10",
        age: 40,
        pregnant: true,
      })
    ).toBeNull();
  });

  it("keeps the copy neutral — no encouragement, no odds, no failure", () => {
    const p = decideWorkupPrompt({
      ttcStart: "2018-06-10",
      today: "2019-06-10",
      age: 30,
    });
    const text = `${p?.title} ${p?.detail}`.toLowerCase();
    for (const banned of [
      "keep trying",
      "chance",
      "odds",
      "unfortunately",
      "failed",
      "success",
      "don't give up",
    ]) {
      expect(text, banned).not.toContain(banned);
    }
  });
});
