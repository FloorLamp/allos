import { describe, it, expect } from "vitest";
import {
  lastNightSummary,
  latestDailySleepSummary,
  sleepRecordPresentation,
  baselineDeltaPhrase,
  formatHm,
  consistencyNights,
  markOffSchedule,
  buildSleepMoodHistory,
  attachEditableManualSleep,
  pairSleepMood,
  sleepTrendRangeWindows,
  sleepTrendWindow,
} from "../sleep-summary";
import type { SleepSession } from "../sleep-regularity";
import { mainSleepNights } from "../sleep-regularity";
import { DEFAULT_FORMAT_PREFS } from "../format-date";

// A helper to build a night session in UTC. bed on `bedDay`, wake on `wakeDay`.
function night(
  bedDay: string,
  bedHm: string,
  wakeDay: string,
  wakeHm: string,
  type?: string
): SleepSession {
  return {
    start: `${bedDay}T${bedHm}:00Z`,
    end: `${wakeDay}T${wakeHm}:00Z`,
    source: "manual",
    type,
  };
}

const TZ = "UTC";

describe("formatHm", () => {
  it("formats whole-minute durations compactly", () => {
    expect(formatHm(432)).toBe("7h 12m");
    expect(formatHm(420)).toBe("7h");
    expect(formatHm(45)).toBe("45m");
    expect(formatHm(0)).toBe("0m");
    expect(formatHm(-10)).toBe("0m"); // clamps negatives
  });
});

describe("sleepTrendWindow", () => {
  const rows = [
    { date: "2026-06-20", value: 1 },
    { date: "2026-07-05", value: 2 },
    { date: "2026-07-18", value: 3 },
    { date: "2026-07-22", value: 4 },
    { date: "2026-07-23", value: 5 },
  ];

  it("uses calendar days and excludes future observations", () => {
    expect(sleepTrendWindow(rows, "2026-07-22", 14)).toEqual([
      { date: "2026-07-18", value: 3 },
      { date: "2026-07-22", value: 4 },
    ]);
  });

  it("returns no data for a window containing no observations", () => {
    expect(
      sleepTrendWindow([{ date: "2026-07-01", value: 1 }], "2026-07-22", 14)
    ).toEqual([]);
  });
});

describe("sleepTrendRangeWindows", () => {
  it("enables a longer range only when it reveals additional observations", () => {
    const windows = sleepTrendRangeWindows(
      [
        { date: "2026-07-22", value: 7.5 },
        { date: "2026-07-18", value: 8 },
      ],
      [{ date: "2026-07-20", deep: 1.5 }],
      "2026-07-22",
      [14, 30, 90]
    );

    expect(
      windows.map((window) => ({
        days: window.days,
        hasAdditionalData: window.hasAdditionalData,
      }))
    ).toEqual([
      { days: 14, hasAdditionalData: true },
      { days: 30, hasAdditionalData: false },
      { days: 90, hasAdditionalData: false },
    ]);
  });

  it("enables the first range whose band contains older data", () => {
    const windows = sleepTrendRangeWindows(
      [{ date: "2026-06-20", value: 7.5 }],
      [],
      "2026-07-22",
      [14, 30, 90]
    );

    expect(windows.map((window) => window.hasAdditionalData)).toEqual([
      false,
      false,
      true,
    ]);
  });
});

describe("lastNightSummary", () => {
  // Seven prior identical 8h nights + a short last night, so the baseline is
  // stable and the delta is clearly negative.
  function priorNights(): SleepSession[] {
    const out: SleepSession[] = [];
    for (let d = 1; d <= 7; d++) {
      const wakeDay = `2026-03-${String(10 + d).padStart(2, "0")}`;
      const bedDay = `2026-03-${String(9 + d).padStart(2, "0")}`;
      out.push(night(bedDay, "23:00", wakeDay, "07:00")); // 8h
    }
    return out;
  }

  it("returns the MAIN overnight session for the latest wake-day", () => {
    const sessions = [
      ...priorNights(),
      night("2026-03-18", "23:30", "2026-03-19", "05:30"), // 6h overnight
    ];
    const s = lastNightSummary(sessions, TZ)!;
    expect(s.wakeDay).toBe("2026-03-19");
    expect(s.durationMin).toBe(360);
    // Bed/wake are emitted as minute-of-day NUMBERS (#1163), never baked strings —
    // the render layer formats them through the login's clock pref. 23:30 = 1410m,
    // 05:30 = 330m.
    expect(s.bedMinutes).toBe(23 * 60 + 30);
    expect(s.wakeMinutes).toBe(5 * 60 + 30);
    expect(s.napMin).toBe(0);
    expect(s.source).toBe("manual");
  });

  it("uses provider-reported asleep minutes instead of the wider bedtime window", () => {
    const session = night("2026-03-18", "23:00", "2026-03-19", "07:00");
    session.value = 425; // 7h05 asleep inside an 8h bedtime window
    expect(lastNightSummary([session], TZ)!.durationMin).toBe(425);
  });

  it("keeps a same-day nap SEPARATE from the main session (#1118)", () => {
    const sessions = [
      ...priorNights(),
      night("2026-03-18", "23:00", "2026-03-19", "07:00"), // 8h overnight (main)
      night("2026-03-19", "13:00", "2026-03-19", "13:45"), // 45m afternoon nap
    ];
    const s = lastNightSummary(sessions, TZ)!;
    expect(s.durationMin).toBe(480); // the night, not 480+45
    expect(s.napMin).toBe(45); // nap counted separately
  });

  it("does not attach wake-day stage totals to the main hero when a nap exists", () => {
    const s = lastNightSummary(
      [
        night("2026-03-18", "23:00", "2026-03-19", "07:00"),
        night("2026-03-19", "13:00", "2026-03-19", "13:45"),
      ],
      TZ,
      new Map([["2026-03-19", { deep: 90, rem: 110, light: 250, awake: 30 }]])
    )!;
    expect(s.stages).toBeNull();
  });

  it("computes the trailing baseline over prior nights and the signed delta", () => {
    const sessions = [
      ...priorNights(), // seven 8h (480m) nights
      night("2026-03-18", "23:00", "2026-03-19", "05:00"), // 6h = 360m
    ];
    const s = lastNightSummary(sessions, TZ)!;
    expect(s.baselineNights).toBe(7);
    expect(s.baselineAvgMin).toBe(480);
    expect(s.deltaMin).toBe(-120); // 360 − 480
  });

  it("has no baseline (null delta) when there is only one night", () => {
    const s = lastNightSummary(
      [night("2026-03-18", "23:00", "2026-03-19", "07:00")],
      TZ
    )!;
    expect(s.baselineNights).toBe(0);
    expect(s.baselineAvgMin).toBeNull();
    expect(s.deltaMin).toBeNull();
  });

  it("attaches the wake-day's stage composition when present", () => {
    const s = lastNightSummary(
      [night("2026-03-18", "23:00", "2026-03-19", "07:00")],
      TZ,
      new Map([["2026-03-19", { deep: 90, rem: 110, light: 250, awake: 30 }]])
    )!;
    expect(s.stages).toEqual({ deep: 90, rem: 110, light: 250, awake: 30 });
  });

  it("returns null with no usable sessions", () => {
    expect(lastNightSummary([], TZ)).toBeNull();
    // an invalid window (end <= start) is dropped
    expect(
      lastNightSummary(
        [{ start: "2026-03-19T07:00:00Z", end: "2026-03-18T23:00:00Z" }],
        TZ
      )
    ).toBeNull();
  });
});

describe("latestDailySleepSummary", () => {
  it("renders a duration-only latest row with a trailing baseline", () => {
    const summary = latestDailySleepSummary(
      [
        { date: "2026-03-17", value: 420 },
        { date: "2026-03-18", value: 450 },
        { date: "2026-03-19", value: 390 },
      ],
      "manual"
    )!;
    expect(summary).toMatchObject({
      wakeDay: "2026-03-19",
      durationMin: 390,
      bedMinutes: null,
      wakeMinutes: null,
      baselineAvgMin: 435,
      deltaMin: -45,
      source: "manual",
    });
  });
});

describe("sleepRecordPresentation — issue #1186", () => {
  const present = (wakeDay: string) =>
    sleepRecordPresentation(wakeDay, "2026-07-22", DEFAULT_FORMAT_PREFS);

  it("calls strictly yesterday Last night", () => {
    expect(present("2026-07-21")).toEqual({
      freshness: "last-night",
      label: "Last night",
    });
  });

  it("never calls a today wake-day Last night", () => {
    const result = present("2026-07-22");
    expect(result.freshness).toBe("recent");
    expect(result.label).toContain("Today");
    expect(result.label).not.toContain("Last night");
  });

  it("keeps a two-night-old record with an honest dated label", () => {
    const result = present("2026-07-20");
    expect(result.freshness).toBe("recent");
    expect(result.label).toContain("Monday, July 20");
    expect(result.label).toContain("2 nights ago");
  });

  it("hides a record older than the four-night relabel window", () => {
    expect(present("2026-07-17")).toEqual({
      freshness: "stale",
      label: "Sleep not synced",
    });
  });
});

describe("baselineDeltaPhrase", () => {
  const base = {
    wakeDay: "2026-03-19",
    durationMin: 360,
    bedMinutes: 23 * 60,
    wakeMinutes: 5 * 60,
    napMin: 0,
    baselineAvgMin: 480,
    baselineNights: 7,
    stages: null,
    source: "manual",
  };
  it("phrases under / over / on-average", () => {
    expect(baselineDeltaPhrase({ ...base, deltaMin: -40 })).toBe(
      "40m under your average"
    );
    expect(baselineDeltaPhrase({ ...base, deltaMin: 90 })).toBe(
      "1h 30m over your average"
    );
    expect(baselineDeltaPhrase({ ...base, deltaMin: 2 })).toBe(
      "right on your average"
    );
    expect(baselineDeltaPhrase({ ...base, deltaMin: null })).toBeNull();
  });
});

describe("consistencyNights", () => {
  it("re-expresses main nights in noon-anchored clock hours + weekend flag", () => {
    const sessions = [
      // 2026-03-14 is a Saturday (weekend wake).
      night("2026-03-13", "23:00", "2026-03-14", "07:00"),
      // 2026-03-16 is a Monday.
      night("2026-03-15", "22:30", "2026-03-16", "06:30"),
    ];
    const rows = consistencyNights(mainSleepNights(sessions, TZ), TZ);
    const sat = rows.find((r) => r.date === "2026-03-14")!;
    const mon = rows.find((r) => r.date === "2026-03-16")!;
    expect(sat.weekend).toBe(true);
    expect(mon.weekend).toBe(false);
    // 23:00 → noon-anchored 23.0; 07:00 → 31.0 (contiguous across midnight).
    expect(sat.bedHour).toBeCloseTo(23);
    expect(sat.wakeHour).toBeCloseTo(31);
    expect(mon.bedHour).toBeCloseTo(22.5);
    expect(mon.wakeHour).toBeCloseTo(30.5);
  });

  it("flags nights more than one hour from the canonical typical schedule", () => {
    const base = Array.from({ length: 7 }, (_, index) => ({
      date: `2026-03-${String(index + 1).padStart(2, "0")}`,
      bedHour: 23,
      wakeHour: 31,
      weekend: false,
      bedDeviationMin: null,
      wakeDeviationMin: null,
      offSchedule: false,
    }));
    const assessed = markOffSchedule(
      [
        ...base,
        {
          ...base[0],
          date: "2026-03-08",
          bedHour: 24.5,
          wakeHour: 32.5,
        },
      ],
      { typicalBedMinute: 23 * 60, typicalWakeMinute: 7 * 60 }
    );
    expect(assessed.slice(0, 7).every((night) => !night.offSchedule)).toBe(
      true
    );
    expect(assessed[7]).toMatchObject({
      bedDeviationMin: 90,
      wakeDeviationMin: 90,
      offSchedule: true,
    });
  });

  it("does not judge the schedule without a canonical typical time", () => {
    const sparse = markOffSchedule([
      {
        date: "2026-03-01",
        bedHour: 23,
        wakeHour: 31,
        weekend: false,
        bedDeviationMin: null,
        wakeDeviationMin: null,
        offSchedule: false,
      },
    ]);
    expect(sparse.every((night) => !night.offSchedule)).toBe(true);
    expect(sparse.every((night) => night.bedDeviationMin == null)).toBe(true);
  });
});

describe("pairSleepMood", () => {
  it("joins only dates present in BOTH series", () => {
    const nights = [
      { date: "2026-03-17", value: 450 },
      { date: "2026-03-18", value: 465 },
      { date: "2026-03-19", value: 480 },
    ];
    const moods = [
      { date: "2026-03-18", valence: 2 },
      { date: "2026-03-19", valence: 4 },
      { date: "2026-03-20", valence: 5 },
    ];
    const pairs = pairSleepMood(nights, moods);
    expect(pairs).toEqual([
      { date: "2026-03-18", sleepHours: 7.75, valence: 2 },
      { date: "2026-03-19", sleepHours: 8, valence: 4 },
    ]);
  });

  it("is empty when either series is empty", () => {
    expect(pairSleepMood([], [{ date: "x", valence: 3 }])).toEqual([]);
    expect(pairSleepMood([{ date: "x", value: 400 }], [])).toEqual([]);
  });

  it("keeps sleep-only, mood-only, and stage-only dates in the factual history", () => {
    expect(
      buildSleepMoodHistory(
        [
          { date: "2026-03-17", value: 450 },
          { date: "2026-03-18", value: 360 },
        ],
        [
          { date: "2026-03-18", valence: 2 },
          { date: "2026-03-19", valence: 5 },
        ],
        [
          {
            date: "2026-03-18",
            deep: 90,
            rem: 100,
            light: 210,
            awake: 20,
          },
          {
            date: "2026-03-20",
            deep: 75,
            rem: 80,
            light: 240,
            awake: 15,
          },
        ]
      )
    ).toEqual([
      {
        date: "2026-03-17",
        sleepHours: 7.5,
        valence: null,
        moodDetails: null,
        stages: null,
        bedtimeSupplements: null,
        sleepEditable: false,
        sleepEditHours: null,
      },
      {
        date: "2026-03-18",
        sleepHours: 6,
        valence: 2,
        moodDetails: {
          energy: null,
          anxiety: null,
          factors: [],
          notes: null,
        },
        stages: { deep: 90, rem: 100, light: 210, awake: 20 },
        bedtimeSupplements: null,
        sleepEditable: false,
        sleepEditHours: null,
      },
      {
        date: "2026-03-19",
        sleepHours: null,
        valence: 5,
        moodDetails: {
          energy: null,
          anxiety: null,
          factors: [],
          notes: null,
        },
        stages: null,
        bedtimeSupplements: null,
        sleepEditable: false,
        sleepEditHours: null,
      },
      {
        date: "2026-03-20",
        sleepHours: null,
        valence: null,
        moodDetails: null,
        stages: { deep: 75, rem: 80, light: 240, awake: 15 },
        bedtimeSupplements: null,
        sleepEditable: false,
        sleepEditHours: null,
      },
    ]);
  });

  it("edits only duration-only manual sleep and allows adding a missing duration", () => {
    const history = buildSleepMoodHistory(
      [
        { date: "2026-03-17", value: 465 },
        { date: "2026-03-18", value: 360 },
      ],
      [{ date: "2026-03-19", valence: 4 }]
    );
    const attached = attachEditableManualSleep(
      history,
      [
        { date: "2026-03-17", value: 465 },
        { date: "2026-03-18", value: 360 },
      ],
      [
        { date: "2026-03-17", source: "manual" },
        { date: "2026-03-18", source: "manual" },
        { date: "2026-03-18", source: "oura" },
      ]
    );
    expect(
      attached.map((row) => ({
        date: row.date,
        sleepEditable: row.sleepEditable,
        sleepEditHours: row.sleepEditHours,
      }))
    ).toEqual([
      {
        date: "2026-03-17",
        sleepEditable: true,
        sleepEditHours: 7.75,
      },
      {
        date: "2026-03-18",
        sleepEditable: false,
        sleepEditHours: null,
      },
      {
        date: "2026-03-19",
        sleepEditable: true,
        sleepEditHours: null,
      },
    ]);
  });
});
