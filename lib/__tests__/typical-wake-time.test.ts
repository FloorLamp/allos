import { describe, it, expect } from "vitest";
import {
  typicalBedTime,
  typicalWakeTime,
  type SleepSession,
} from "../sleep-regularity";

// A UTC overnight session: bed the evening BEFORE `wakeDay`, waking at `wakeHhmm`
// on `wakeDay`. With tz "UTC" the wall clock equals the stored instant, so the
// wake clock-minute is hand-checkable.
function utcNight(
  wakeDay: string,
  wakeHhmm = "07:00",
  bedHhmm = "23:00"
): SleepSession {
  const prev = new Date(wakeDay + "T00:00:00Z");
  prev.setUTCDate(prev.getUTCDate() - 1);
  const prevDay = prev.toISOString().slice(0, 10);
  return {
    start: `${prevDay}T${bedHhmm}:00Z`,
    end: `${wakeDay}T${wakeHhmm}:00Z`,
  };
}

function consecutiveWakeDays(start: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(start + "T00:00:00Z");
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const hhmm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(
    2,
    "0"
  )}`;

describe("typicalWakeTime", () => {
  it("returns the median wake clock-minute over the window", () => {
    const days = consecutiveWakeDays("2026-06-01", 16);
    const sessions = days.map((d) => utcNight(d, "07:00"));
    // 07:00 = 420 minutes.
    expect(typicalWakeTime(sessions, "UTC")).toBe(420);
  });

  it("takes the MEDIAN, not the mean (robust to an outlier wake)", () => {
    const days = consecutiveWakeDays("2026-06-01", 15);
    // 14 nights at 07:00, one late 11:00 wake — the median stays 07:00.
    const sessions = days.map((d, i) =>
      utcNight(d, i === 0 ? "11:00" : "07:00")
    );
    expect(typicalWakeTime(sessions, "UTC")).toBe(420);
  });

  it("averages the two middle values on an even night count", () => {
    // 8 nights at 06:00 (360) and 8 at 08:00 (480) → median 420 (07:00).
    const days = consecutiveWakeDays("2026-06-01", 16);
    const sessions = days.map((d, i) => utcNight(d, i < 8 ? "06:00" : "08:00"));
    expect(typicalWakeTime(sessions, "UTC")).toBe(420);
  });

  it("ignores a same-day afternoon nap (the nap's wake must not poison the median)", () => {
    const days = consecutiveWakeDays("2026-06-01", 16);
    const sessions: SleepSession[] = [];
    for (const d of days) {
      sessions.push(utcNight(d, "07:00")); // main overnight
      // A 2-hour afternoon nap ending 15:00 the same wake-day — LONGER "wake"
      // clock time (15:00 = 900), but shorter duration than the overnight, so
      // mainSleepSession excludes it.
      sessions.push({ start: `${d}T13:00:00Z`, end: `${d}T15:00:00Z` });
    }
    // Median wake stays the overnight's 07:00 (420), not blended toward 15:00.
    expect(typicalWakeTime(sessions, "UTC")).toBe(420);
  });

  it("returns null below the minimum-nights gate (sparse data is meaningless)", () => {
    const days = consecutiveWakeDays("2026-06-01", 10); // < default 14
    const sessions = days.map((d) => utcNight(d, "07:00"));
    expect(typicalWakeTime(sessions, "UTC")).toBeNull();
  });

  it("returns null with no sessions at all", () => {
    expect(typicalWakeTime([], "UTC")).toBeNull();
  });

  it("only counts nights inside the rolling window", () => {
    // 16 recent nights at 06:30 (390) plus 20 much-older nights at 09:00 that
    // fall outside the 28-day window ending at the latest night.
    const older = consecutiveWakeDays("2026-01-01", 20).map((d) =>
      utcNight(d, "09:00")
    );
    const recent = consecutiveWakeDays("2026-06-01", 16).map((d) =>
      utcNight(d, "06:30")
    );
    // 06:30 = 390 minutes.
    expect(typicalWakeTime([...older, ...recent], "UTC")).toBe(390);
  });

  it("keeps early/late wakes contiguous via the noon anchor (no midnight wrap)", () => {
    // A very early 05:15 (315) wake across enough nights resolves cleanly.
    const days = consecutiveWakeDays("2026-06-01", 16);
    const sessions = days.map((d) => utcNight(d, hhmm(315), "22:00"));
    expect(typicalWakeTime(sessions, "UTC")).toBe(315);
  });
});

describe("typicalBedTime", () => {
  it("shares the canonical window and median derivation for bedtime", () => {
    const days = consecutiveWakeDays("2026-06-01", 16);
    const sessions = days.map((day, index) =>
      utcNight(day, "07:00", index === 0 ? "20:00" : "23:00")
    );
    expect(typicalBedTime(sessions, "UTC")).toBe(23 * 60);
  });
});
