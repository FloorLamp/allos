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
import { getIntradayDay, getIntradayDayWindows } from "@/lib/queries";
import { gatherHistoryLog } from "@/lib/history";
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
  return zonedWallTimeToUtc(TZ, day, hhmm)!.toISOString();
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
    `INSERT INTO metric_samples (profile_id, source, metric, date, started_at, ended_at, value)
     VALUES (?, 'health-connect', ?, ?, ?, ?, ?)`
  ).run(profileId, metric, wakeDay, start, end, value);
}

describe("getIntradayDay", () => {
  // #4918's empty-day ruling: ALWAYS a model now, never null — a day with nothing
  // intraday gets one whose four data layers are all empty.
  it("returns an empty model when nothing on the day is intraday", () => {
    const p = newProfile("Intraday Empty");
    const events: TimelineEvent[] = [
      { id: "body:1", date: DAY, category: "body", title: "Body metrics" },
    ];
    const model = getIntradayDay(p, DAY, events);
    expect(model.hr).toBeNull();
    expect(model.sleep).toEqual([]);
    expect(model.blocks).toEqual([]);
    expect(model.ticks).toEqual([]);
    expect(model.solarDay).toBeNull();
    expect(model.expectedSleep).toBeNull();
  });

  it("threads the daylight band and expected-sleep window through when the caller passes them", () => {
    const p = newProfile("Intraday Context");
    const model = getIntradayDay(p, DAY, [], {
      solarDay: { sunriseMin: 372, sunsetMin: 1146 },
      expectedSleep: { bedMinutes: 1380, wakeMinutes: 390 },
    });
    expect(model.solarDay).toEqual({ sunriseMin: 372, sunsetMin: 1146 });
    expect(model.expectedSleep).toEqual({
      startMinute: 0,
      endMinute: 390,
      clippedStart: true,
      clippedEnd: false,
    });
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
    expect(model!.blocks).toHaveLength(1);
    expect(model!.blocks[0]).toMatchObject({
      startMinute: 480,
      endMinute: 540,
    });
    // No HR, no sleep — the panel still renders for the block alone.
    expect(model!.hr).toBeNull();
    expect(model!.sleep).toEqual([]);
  });
});

// THE CHART'S OWN DAY READER (#5262). The day view hands the panel its feed's own
// resolved events because it also LISTS them; the dashboard's "day so far" row lists
// nothing, and the owner ruled it keeps the session blocks while the feed-sourced ticks
// leave.
//
// BOTH ARMS COMPOSE THROUGH THE SAME TWO FUNCTIONS, so what this can fail on is the
// READS either side of them: that the day-scoped pair finds the same rows the feed's
// bounded gather and practice ledger find, and that it applies the draft rule. Drop
// that rule and the husk below — started, never ended — arrives as a start-only window
// and lands on the rail the last line says is empty.
describe("getIntradayDayWindows", () => {
  function login(): number {
    return Number(
      db
        .prepare("INSERT INTO logins (username, password_hash) VALUES (?, 'x')")
        .run(`intraday_${Math.random().toString(36).slice(2, 8)}`)
        .lastInsertRowid
    );
  }

  it("composes the same blocks the record's day gather does, with the feed's ticks gone", () => {
    const p = newProfile("Intraday Windows");
    const loginId = login();
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, start_time, end_time, duration_min)
       VALUES (?, ?, 'cardio', 'Zone 2 base ride', '08:00', '09:00', 60)`
    ).run(p, DAY);
    db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date, start_time, end_time, duration_min)
       VALUES (?, 'Sauna', ?, '19:00', '19:25', 25)`
    ).run(p, DAY);
    // A CREATE-AT-START HUSK, which renders nowhere but its own page (#2870) — so it
    // must not put a mark on this axis either. Started, never ended, nothing logged in it.
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, start_time)
       VALUES (?, ?, 'strength', 'Untitled session', '17:00')`
    ).run(p, DAY);
    // A feed-sourced mark, so the arm below cannot pass by having nothing to drop.
    // The rail reads the EVENT instant only, so the use states one.
    db.prepare(
      `INSERT INTO substance_log_events (profile_id, substance, date, recorded_at, occurred_at)
       VALUES (?, 'nicotine', ?, ?, ?)`
    ).run(p, DAY, instant(DAY, "13:40"), instant(DAY, "13:40"));

    const feed = getIntradayDay(
      p,
      DAY,
      gatherHistoryLog(p, { loginId, day: DAY, limit: 200 }).dayEvents
    );
    const chart = getIntradayDay(p, DAY, getIntradayDayWindows(p, DAY));

    // The two real sessions, drawn identically but for the record's `feed:` id space,
    // and the husk in neither.
    expect(chart.blocks.map((b) => b.title)).toEqual([
      "Zone 2 base ride",
      "Sauna",
    ]);
    expect(
      chart.blocks.map(({ key, eventId, anchorId, ...rest }) => rest)
    ).toEqual(feed.blocks.map(({ key, eventId, anchorId, ...rest }) => rest));

    // The positive control and the subject, in that order: the feed arm draws the
    // substance tick, and the chart arm draws no rail at all.
    expect(feed.ticks.map((t) => t.category)).toEqual(["substance"]);
    expect(chart.ticks).toEqual([]);
  });
});
