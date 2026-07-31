// DB INTEGRATION TIER — the intraday panel's GATHER (issue #1068).
//
// The pure model is covered by lib/__tests__/intraday.test.ts; what only a real DB
// can prove is the input layer: that the day's HR comes back through the shared
// one-source-per-day reader, that a sleep session stored as ABSOLUTE instants lands
// on the right profile-local minutes (and bleeds in from the previous day rather
// than being re-attributed), that per-stage windows become sub-bands, and that the
// Zone 2 band is the profile's real zone model — not a second formula.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { getIntradayDay } from "@/lib/queries";
import { setProfileSetting } from "@/lib/settings";
import { zonedWallTimeToUtc } from "@/lib/date";
import type { TimelineEvent } from "@/lib/timeline-format";

const TZ = "America/New_York";
const DAY = "2026-05-14";
const PREV = "2026-05-13";

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setProfileSetting(id, "timezone", TZ);
  return id;
}

// hr_minutes.ts is PROFILE-LOCAL by design (#94) — seed it as the wall-clock
// minute string, exactly as the ingest writes it.
function seedHr(
  profileId: number,
  day: string,
  fromMinute: number,
  count: number,
  bpm: number,
  source = "health-connect"
): void {
  const ins = db.prepare(
    "INSERT INTO hr_minutes (profile_id, ts, bpm, bpm_min, bpm_max, n, source) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  for (let i = 0; i < count; i++) {
    const m = fromMinute + i;
    const ts = `${day}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(
      m % 60
    ).padStart(2, "0")}`;
    ins.run(profileId, ts, bpm, bpm - 3, bpm + 4, 6, source);
  }
}

// metric_samples windows are ABSOLUTE instants — built from local wall times so
// the fixture reads the way a person would describe it.
function instant(day: string, hhmm: string): string {
  return zonedWallTimeToUtc(TZ, day, hhmm).toISOString();
}

function seedSample(
  profileId: number,
  metric: string,
  wakeDay: string,
  start: string,
  end: string,
  value: number
): void {
  db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'health-connect', ?, ?, ?, ?, ?)`
  ).run(profileId, metric, wakeDay, start, end, value);
}

describe("getIntradayDay", () => {
  it("returns null when nothing on the day is intraday", () => {
    const p = newProfile("Intraday Empty");
    const events: TimelineEvent[] = [
      { id: "body:1", date: DAY, category: "body", title: "Body metrics" },
    ];
    expect(getIntradayDay(p, DAY, events)).toBeNull();
  });

  it("builds HR, sleep (clipped), stage sub-bands and a Zone 2 band", () => {
    const p = newProfile("Intraday Full");
    // ~40y with a resting HR → Karvonen zones, so Zone 2 is a real band.
    setProfileSetting(p, "birthdate", "1986-05-14");
    db.prepare(
      "INSERT INTO body_metrics (profile_id, date, resting_hr, source) VALUES (?, ?, 55, 'manual')"
    ).run(p, PREV);

    // A morning wear window: 06:00–06:59 at 62 bpm.
    seedHr(p, DAY, 360, 60, 62);
    // The overnight session started at 23:10 the PREVIOUS day and ended 06:40.
    seedSample(
      p,
      "sleep_min",
      DAY,
      instant(PREV, "23:10"),
      instant(DAY, "06:40"),
      450
    );
    seedSample(
      p,
      "sleep_deep_min",
      DAY,
      instant(DAY, "01:00"),
      instant(DAY, "02:00"),
      60
    );

    const model = getIntradayDay(p, DAY, []);
    expect(model).not.toBeNull();

    // HR: 60 one-minute buckets → 12 five-minute points, band from the columns.
    expect(model!.hr!.pointCount).toBe(12);
    expect(model!.hr!.min).toBe(59);
    expect(model!.hr!.max).toBe(66);
    // Zone 2 comes from the profile's zone model (Karvonen, max 180 / resting 55):
    // Z2 floor 130, Z3 floor 143.
    expect(model!.hr!.zone2).toEqual({ low: 130, high: 143 });

    // Sleep: clipped at midnight, marked as entering from the previous day.
    expect(model!.sleep).toHaveLength(1);
    expect(model!.sleep[0]).toMatchObject({
      startMinute: 0,
      endMinute: 400,
      clippedStart: true,
      clippedEnd: false,
    });
    expect(model!.sleep[0].stages).toEqual([
      { stage: "deep", startMinute: 60, endMinute: 120 },
    ]);
  });

  it("ignores a per-night stage TOTAL stamped with the whole session window", () => {
    // Oura/Withings write per-night stage totals, not windows — the row carries the
    // session's own span. Painting the whole block one stage would be a lie, so the
    // sub-band layer stays empty for that source shape.
    const p = newProfile("Intraday Stage Totals");
    seedSample(
      p,
      "sleep_min",
      DAY,
      instant(PREV, "23:00"),
      instant(DAY, "07:00"),
      480
    );
    seedSample(
      p,
      "sleep_rem_min",
      DAY,
      instant(PREV, "23:00"),
      instant(DAY, "07:00"),
      95
    );
    const model = getIntradayDay(p, DAY, []);
    expect(model!.sleep).toHaveLength(1);
    expect(model!.sleep[0].stages).toEqual([]);
  });

  it("keeps one HR source per day so two devices can't zig-zag the line", () => {
    const p = newProfile("Intraday Two Sources");
    seedHr(p, DAY, 480, 30, 120, "health-connect");
    seedHr(p, DAY, 480, 30, 60, "oura");
    const model = getIntradayDay(p, DAY, []);
    // One source wins outright — the merged band would otherwise span 57–124.
    const { min, max } = model!.hr!;
    expect(max - min).toBeLessThan(20);
  });

  it("draws a workout block from the feed's own activity event", () => {
    const p = newProfile("Intraday Workout");
    const events: TimelineEvent[] = [
      {
        id: "activity:77",
        date: DAY,
        category: "activity",
        title: "Zone 2 base ride",
        sortTime: "08:00",
        clockWindow: {
          date: DAY,
          start_time: "08:00",
          end_time: "09:00",
          duration_min: 60,
        },
      },
    ];
    const model = getIntradayDay(p, DAY, events);
    expect(model!.workouts).toHaveLength(1);
    expect(model!.workouts[0]).toMatchObject({
      startMinute: 480,
      endMinute: 540,
    });
    // No HR, no sleep — the panel still renders for the block alone.
    expect(model!.hr).toBeNull();
    expect(model!.sleep).toEqual([]);
  });
});
