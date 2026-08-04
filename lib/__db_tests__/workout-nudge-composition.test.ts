// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// The composed workout nudge, end to end over a realistic fixture — the seam the pure
// tier cannot see, because every bug in this cluster lived between the core and the
// formatter rather than inside either:
//
//   #2015 — the `← today` marker was read off `items[0]`, whose order is FIXED (cardio
//           first), so a day behind on both suggested a back workout and marked Cardio.
//   #2016 — the cardio routine-gap item, activity already picked, was dropped whole at
//           the same boundary: two recommendations in, one session out.
//   #2017 — a wellness practice reached the "Behind this week" list, a second contact
//           for a fact that already has its own pace-aware nudge, and was eligible to
//           SCOPE the strength workout.
//   #2002 — the weather-parking disclosure never reached Telegram, though the engine's
//           own comments promise the nudge renders it.
//
// Runs via `npm run test:db` (vitest.db.config.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  setHomeLocation,
  setTimezone,
  setWeekMode,
  type UnitPrefs,
} from "@/lib/settings";
import { upsertWeatherDays } from "@/lib/integrations/weather-cache";
import type { DailyWeatherRow } from "@/lib/integrations/open-meteo";
import { logPracticeSession } from "@/lib/queries";
import { practiceIdentity } from "@/lib/practice";
import { gatherCoachingInput } from "@/lib/queries/coaching";
import { recommendNextWorkout } from "@/lib/workout-recommendation";
import { recommendWorkout } from "@/lib/notifications/recommend";
import { buildWorkoutTargetReminder } from "@/lib/notifications/workouts";
import { buildPracticeReminder } from "@/lib/notifications/practices";
import { digestWorkoutLine } from "@/lib/notifications/workout-format";
import { plainBody } from "@/lib/notifications/rich-text";
import { recommendCoaching } from "@/lib/coaching";

// A login reading canonical units, matching what the notification path assumes.
const CELSIUS_UNITS: UnitPrefs = {
  weightUnit: "kg",
  distanceUnit: "km",
  temperatureUnit: "C",
};

let seq = 0;
const homeByProfile = new Map<number, { lat: number; lng: number }>();

// Each fixture gets its own coarse coordinate — the weather cache is global and
// location-keyed, so shared coordinates would make one test's weather another's.
function makeProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`${name}-${seq++}`)
      .lastInsertRowid
  );
  setTimezone(id, "UTC");
  // Rolling weeks: the window is always the trailing 7 days, so the fixture's counts
  // don't depend on which weekday the run lands on.
  setWeekMode(id, "rolling");
  const home = { lat: 20 + seq / 10, lng: -74 };
  homeByProfile.set(id, home);
  setHomeLocation(id, home);
  return id;
}

function target(
  profileId: number,
  scopeKind: string,
  scopeValue: string,
  perWeek: number
): number {
  const identity =
    scopeKind === "practice" ? practiceIdentity(scopeValue) : null;
  return Number(
    db
      .prepare(
        `INSERT INTO frequency_targets
           (profile_id, scope_kind, scope_value, scope_identity, per_week)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(profileId, scopeKind, scopeValue, identity, perWeek).lastInsertRowid
  );
}

// A strength session on `date` with one set of each named lift.
function logLifts(
  profileId: number,
  date: string,
  exercises: readonly string[]
): void {
  const actId = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min)
         VALUES (?, ?, 'strength', 'Workout', 45)`
      )
      .run(profileId, date).lastInsertRowid
  );
  const ins = db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
     VALUES (?, ?, ?, 60, 5)`
  );
  for (const [i, exercise] of exercises.entries())
    ins.run(actId, exercise, i + 1);
}

function logCardio(profileId: number, date: string, activity: string): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min)
     VALUES (?, ?, 'cardio', ?, 40)`
  ).run(profileId, date, activity);
}

function emptyDay(date: string): DailyWeatherRow {
  return {
    date,
    tempMaxC: null,
    tempMinC: null,
    pressureMslHpa: null,
    precipitationMm: null,
    weatherCode: null,
    uvIndexMax: null,
    aqi: null,
    pollenTree: null,
    pollenGrass: null,
    pollenWeed: null,
  };
}

function cacheDay(
  profileId: number,
  date: string,
  over: Partial<DailyWeatherRow>
): void {
  const home = homeByProfile.get(profileId)!;
  upsertWeatherDays(
    home.lat,
    home.lng,
    [{ ...emptyDay(date), ...over }],
    "test"
  );
}

// THE REPORTED STATE (#2015's screenshot), as real rows: back untrained this week and
// out of its recovery window, chest and cardio each half done, and a wellness practice
// short of its weekly floor.
function seedReportedProfile(name: string): {
  pid: number;
  backId: number;
  chestId: number;
  cardioId: number;
  practiceId: number;
} {
  const pid = makeProfile(name);
  const t = today(pid);
  const backId = target(pid, "region", "Back", 2);
  const chestId = target(pid, "region", "Chest", 2);
  const cardioId = target(pid, "type", "cardio", 2);
  const practiceId = target(pid, "practice", "Red light therapy", 3);

  // Outside the 7-day window: back has history to suggest from, but 0 sessions this week.
  logLifts(pid, shiftDateStr(t, -10), [
    "Lat Pulldown",
    "Cable Row",
    "Deadlift",
    "Pull Up",
  ]);
  logLifts(pid, shiftDateStr(t, -3), ["Barbell Bench Press"]);
  logCardio(pid, shiftDateStr(t, -2), "Running");
  logPracticeSession(pid, "Red light therapy", shiftDateStr(t, -4));
  logPracticeSession(pid, "Red light therapy", shiftDateStr(t, -2));

  return { pid, backId, chestId, cardioId, practiceId };
}

describe("the composed workout nudge (#2015/#2016/#2017)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-08T12:00:00Z")); // a Wednesday
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("suggests the strength session and marks the target that produced it (#2015)", () => {
    const { pid, backId, cardioId } = seedReportedProfile("nudge-driver");
    const rec = recommendWorkout(pid)!;
    const msg = buildWorkoutTargetReminder(pid)!;
    const body = plainBody(msg.body);

    // The title, the focus and every suggested exercise are back work...
    expect(msg.title).toBe("🏋️ Today's workout — Back workout");
    expect(rec.focus).toEqual(["Back"]);
    expect(body).toContain("Suggested: Lat Pulldown");

    // ...so the marker is on Back, and Back — the larger deficit — leads the list.
    // Reading the driver off items[0] put it on Cardio and pushed Back to second.
    const marked = rec.behind.filter((t) => t.driving).map((t) => t.id);
    expect(marked).toContain(backId);
    expect(rec.behind[0].id).toBe(backId);
    expect(rec.behind[0].driving).toBe(true);
    // Both named sessions are marked (#2016), Back first by deficit.
    expect(marked).toEqual([backId, cardioId]);
  });

  it("names the cardio session it computed instead of dropping it (#2016)", () => {
    const { pid } = seedReportedProfile("nudge-cardio");
    const rec = recommendWorkout(pid)!;
    const body = plainBody(buildWorkoutTargetReminder(pid)!.body);

    // The activity the core's picker chose reaches the reader.
    expect(rec.cardio).toEqual({ activity: "Running", count: 1, perWeek: 2 });
    expect(body).toContain("Plus a cardio session — Running, 1/2 this week.");
    // Strength still leads: it carries the exercise list.
    expect(body.indexOf("Suggested:")).toBeLessThan(
      body.indexOf("Plus a cardio session")
    );
    // The digest preview names the same two sessions (#221 — one computation).
    expect(digestWorkoutLine(rec)!.endsWith("+ cardio")).toBe(true);
  });

  it("carries no practice target, which keeps its own send (#2017)", () => {
    const { pid, practiceId } = seedReportedProfile("nudge-practice");
    const rec = recommendWorkout(pid)!;
    const body = plainBody(buildWorkoutTargetReminder(pid)!.body);

    expect(body).toContain("Behind this week:");
    expect(body).not.toContain("Red light therapy");
    expect(rec.behind.map((t) => t.id)).not.toContain(practiceId);
    expect(rec.behind.map((t) => t.scopeKind)).not.toContain("practice");

    // The fact keeps exactly ONE channel, not zero: the practice nudge still fires for
    // the same target, with the same shortfall.
    const practice = buildPracticeReminder(pid, "nonce1")!;
    expect(practice.kind).toBe("practice");
    expect(practice.body).toContain(
      "Red light therapy — 2 of 3 this week, one more to go"
    );
  });

  it("scopes the workout to a trainable region even when a practice is further behind", () => {
    // A practice names no muscle region, so `trainable()` short-circuited to true and it
    // passed the recovery gate unconditionally. At 0/3 it beat Back's 0/2 on fraction and
    // would have scoped a strength workout to a light-therapy gap.
    const pid = makeProfile("nudge-scope");
    const t = today(pid);
    const backId = target(pid, "region", "Back", 2);
    target(pid, "practice", "Red light therapy", 3);
    logLifts(pid, shiftDateStr(t, -10), ["Lat Pulldown", "Cable Row"]);

    const rec = recommendWorkout(pid)!;
    expect(rec.focus).toEqual(["Back"]);
    expect(rec.behind.map((t) => t.id)).toEqual([backId]);
    expect(plainBody(buildWorkoutTargetReminder(pid)!.body)).toContain(
      "Behind this week: Back 0/2 ← today"
    );
  });
});

describe("the workout nudge discloses today's weather parking (#2002)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-08T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the parked activity, the reason, and the stand-in that took its slot", () => {
    // A fair-weather cyclist: a season of rides in the high teens and twenties, then a
    // cold day. The dashboard has always said so; Telegram said nothing at all and
    // silently swapped in the indoor bike.
    const pid = makeProfile("nudge-parked");
    const t = today(pid);
    target(pid, "type", "cardio", 2);
    for (const [i, temp] of [16, 18, 19, 20, 22, 23, 25, 27].entries()) {
      const date = shiftDateStr(t, -(7 * (i + 1)));
      logCardio(pid, date, "Cycling");
      cacheDay(pid, date, { tempMaxC: temp, precipitationMm: 0 });
    }
    // An indoor session the profile has actually done, so the engine may offer it.
    logCardio(pid, shiftDateStr(t, -2), "Stationary Bike");
    cacheDay(pid, shiftDateStr(t, -2), { tempMaxC: 20, precipitationMm: 0 });
    cacheDay(pid, t, { tempMaxC: 3, precipitationMm: 0 });

    // The core parked it and picked the stand-in...
    const nw = recommendNextWorkout(gatherCoachingInput(pid, "kg", "km"));
    expect(nw.parked.map((p) => p.activity)).toEqual(["Cycling"]);
    expect(nw.parked[0].alternative).toBe("Stationary Bike");

    // ...and the Telegram message now SAYS so, in the same words the dashboard uses.
    const rec = recommendWorkout(pid)!;
    const body = plainBody(buildWorkoutTargetReminder(pid)!.body);
    const disclosure = rec.parkedNotes!.find((n) => n.startsWith("Too cold"))!;
    expect(disclosure).toContain("Stationary Bike instead");
    expect(body).toContain(disclosure);

    // One formatter, one answer: the dashboard card renders the identical line.
    const dashboard = recommendCoaching(
      gatherCoachingInput(
        pid,
        CELSIUS_UNITS.weightUnit,
        CELSIUS_UNITS.distanceUnit,
        CELSIUS_UNITS.temperatureUnit
      )
    ).flatMap((r) => r.notes ?? []);
    expect(dashboard).toContain(disclosure);

    // The parked ride never surfaces as the suggestion itself (#1724 still holds).
    expect(rec.cardio?.activity).not.toBe("Cycling");
    expect(body).not.toContain("Plus a cardio session — Cycling");
  });

  it("says nothing about weather on a day with nothing parked", () => {
    const pid = makeProfile("nudge-unparked");
    const t = today(pid);
    target(pid, "type", "cardio", 2);
    for (const [i, temp] of [16, 18, 19, 20, 22, 23, 25, 27].entries()) {
      const date = shiftDateStr(t, -(7 * (i + 1)));
      logCardio(pid, date, "Cycling");
      cacheDay(pid, date, { tempMaxC: temp, precipitationMm: 0 });
    }
    cacheDay(pid, t, { tempMaxC: 20, precipitationMm: 0 });

    const rec = recommendWorkout(pid)!;
    expect(rec.parkedNotes).toEqual([]);
    expect(plainBody(buildWorkoutTargetReminder(pid)!.body)).not.toContain(
      "Too cold"
    );
  });
});
