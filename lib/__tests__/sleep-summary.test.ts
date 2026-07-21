import { describe, it, expect } from "vitest";
import {
  lastNightSummary,
  baselineDeltaPhrase,
  formatHm,
  consistencyNights,
  pairSleepMood,
} from "../sleep-summary";
import type { SleepSession } from "../sleep-regularity";
import { mainSleepNights } from "../sleep-regularity";

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
    expect(s.bedLocal).toBe("23:30");
    expect(s.wakeLocal).toBe("05:30");
    expect(s.napMin).toBe(0);
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

describe("baselineDeltaPhrase", () => {
  const base = {
    wakeDay: "2026-03-19",
    durationMin: 360,
    bedLocal: "23:00",
    wakeLocal: "05:00",
    napMin: 0,
    baselineAvgMin: 480,
    baselineNights: 7,
    stages: null,
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
});

describe("pairSleepMood", () => {
  it("joins only dates present in BOTH series", () => {
    const nights = [
      { date: "2026-03-17", value: 450 },
      { date: "2026-03-18", value: 360 },
      { date: "2026-03-19", value: 480 },
    ];
    const moods = [
      { date: "2026-03-18", valence: 2 },
      { date: "2026-03-19", valence: 4 },
      { date: "2026-03-20", valence: 5 },
    ];
    const pairs = pairSleepMood(nights, moods);
    expect(pairs).toEqual([
      { date: "2026-03-18", sleepHours: 6, valence: 2 },
      { date: "2026-03-19", sleepHours: 8, valence: 4 },
    ]);
  });

  it("is empty when either series is empty", () => {
    expect(pairSleepMood([], [{ date: "x", valence: 3 }])).toEqual([]);
    expect(pairSleepMood([{ date: "x", value: 400 }], [])).toEqual([]);
  });
});
