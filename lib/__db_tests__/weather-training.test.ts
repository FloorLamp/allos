// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issue #1724 — weather-aware training over a realistic fixture. The pure envelope and
// parking rules are pinned in lib/__tests__/weather-training.test.ts; this seeds real
// logged rides joined to real cached weather and asserts the END-TO-END recommendation:
// a winter cyclist's ride survives a cold day, a fair-weather cyclist's is parked with
// the reason disclosed and the indoor alternative offered, and — the inversion the issue
// is really about — a parked activity stops winning the least-recently-done variety slot
// instead of being pushed harder exactly when conditions are worst.
//
// Runs via `npm run test:db` (vitest.db.config.ts).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setHomeLocation, setTimezone } from "@/lib/settings";
import {
  upsertUvHours,
  upsertWeatherDays,
} from "@/lib/integrations/weather-cache";
import type { DailyWeatherRow } from "@/lib/integrations/open-meteo";
import { gatherCoachingInput } from "@/lib/queries/coaching";
import { recommendNextWorkout } from "@/lib/workout-recommendation";
import {
  getToleranceEnvelopes,
  sessionWeather,
} from "@/lib/queries/weather-training";
import { contextNotes } from "@/lib/coaching/engine";
import { recommendCoaching } from "@/lib/coaching";
import { buildTrainingLogFeedPage } from "@/lib/training-log-feed";
import type { UnitPrefs } from "@/lib/settings";

// A login reading in Celsius, so the stamp assertions name the canonical figure.
const CELSIUS_UNITS: UnitPrefs = {
  weightUnit: "kg",
  distanceUnit: "km",
  temperatureUnit: "C",
};

const LNG = -74;
let seq = 0;
const homeByProfile = new Map<number, { lat: number; lng: number }>();

// Each fixture gets its own coarse coordinate — the weather cache is global and
// location-keyed, so shared coordinates would make one test's weather another's.
function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`${name}-${seq++}`)
      .lastInsertRowid
  );
  setTimezone(id, "UTC");
  const home = { lat: 60 + seq / 10, lng: LNG };
  homeByProfile.set(id, home);
  setHomeLocation(id, home);
  return id;
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

// Cache one day's weather at the profile's home location.
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

// Cache one local day's HOURLY precipitation (mm per hour, index = hour) at the
// profile's home location — the series the wet-park description's timing clause reads.
function cacheHours(
  profileId: number,
  date: string,
  mmByHour: readonly number[]
): void {
  const home = homeByProfile.get(profileId)!;
  upsertUvHours(
    home.lat,
    home.lng,
    mmByHour.map((mm, hour) => ({
      hourTs: `${date}T${String(hour).padStart(2, "0")}:00`,
      uvIndex: null,
      uvIndexClearSky: null,
      shortwaveRadiation: null,
      directRadiation: null,
      diffuseRadiation: null,
      precipitationMm: mm,
    })),
    "test"
  );
}

// Log a session on `date`, and cache the weather it happened in.
function logSession(
  profileId: number,
  date: string,
  activity: string,
  tempMaxC: number,
  precipitationMm = 0
): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min)
     VALUES (?, ?, 'cardio', ?, 60)`
  ).run(profileId, date, activity);
  cacheDay(profileId, date, { tempMaxC, precipitationMm });
}

// A season of rides at the given temperatures, one per week going back from today.
function seedRides(
  profileId: number,
  activity: string,
  temps: readonly number[]
): void {
  const anchor = today(profileId);
  temps.forEach((t, i) => {
    logSession(profileId, shiftDateStr(anchor, -(7 * (i + 1))), activity, t);
  });
}

function parkedOf(profileId: number) {
  return recommendNextWorkout(gatherCoachingInput(profileId, "kg", "km"))
    .parked;
}

describe("the shared session-to-weather join (#1724/#1728)", () => {
  it("joins logged sessions to the weather of their day, and writes nothing", () => {
    const p = newProfile("wt-join");
    const anchor = today(p);
    logSession(p, shiftDateStr(anchor, -3), "Cycling", 14, 2);

    const joined = sessionWeather(p, shiftDateStr(anchor, -30), anchor);
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({
      activity: "Cycling",
      tempMaxC: 14,
      precipitationMm: 2,
    });

    // Derived at READ time — nothing is stamped onto the activity row (#1728).
    const cols = db
      .prepare(`SELECT * FROM activities WHERE profile_id = ?`)
      .get(p) as Record<string, unknown>;
    expect(Object.keys(cols)).not.toContain("temp_max_c");
    expect(Object.keys(cols)).not.toContain("weather_code");
  });

  it("keeps a session whose day has NO cached weather, with null conditions", () => {
    const p = newProfile("wt-join-gap");
    const anchor = today(p);
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, duration_min)
       VALUES (?, ?, 'cardio', 'Cycling', 60)`
    ).run(p, shiftDateStr(anchor, -2));

    const joined = sessionWeather(p, shiftDateStr(anchor, -30), anchor);
    expect(joined).toHaveLength(1);
    expect(joined[0].tempMaxC).toBeNull();
  });
});

describe("tolerance revealed from real logged history (#1724)", () => {
  it("the winter cyclist's ride is NOT parked on a cold day", () => {
    const p = newProfile("wt-winter");
    seedRides(p, "Cycling", [1, 2, 3, 4, 6, 8, 10, 12]);
    const anchor = today(p);
    cacheDay(p, anchor, { tempMaxC: 3, precipitationMm: 0 });

    const env = getToleranceEnvelopes(p, anchor).get("cycling")!;
    expect(env.revealed).toBe(true);
    expect(parkedOf(p)).toEqual([]);
  });

  it("the fair-weather cyclist's ride IS parked, with the reason and the alternative", () => {
    const p = newProfile("wt-fair");
    seedRides(p, "Cycling", [16, 18, 19, 20, 22, 23, 25, 27]);
    // The profile has logged an indoor trainer before, so the engine may offer it.
    logSession(p, shiftDateStr(today(p), -2), "Stationary Bike", 20);
    const anchor = today(p);
    cacheDay(p, anchor, { tempMaxC: 3, precipitationMm: 0 });

    const parked = parkedOf(p);
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      activity: "Cycling",
      reason: "cold",
      alternative: "Stationary Bike",
      revealed: true,
    });
  });

  it("falls through with the disclosure intact when the profile owns no alternative", () => {
    const p = newProfile("wt-noalt");
    seedRides(p, "Cycling", [16, 18, 19, 20, 22, 23, 25, 27]);
    const anchor = today(p);
    cacheDay(p, anchor, { tempMaxC: 3 });

    const parked = parkedOf(p);
    expect(parked).toHaveLength(1);
    // No trainer logged and none owned: no alternative is invented...
    expect(parked[0].alternative).toBeNull();
    // ...but the disclosure still explains the absence (#838, never silent).
    const nw = recommendNextWorkout(gatherCoachingInput(p, "kg", "km"));
    const notes = contextNotes(nw);
    expect(notes.some((n) => n.includes("Too cold for cycling"))).toBe(true);
  });

  it("offers an alternative the profile OWNS the equipment for", () => {
    const p = newProfile("wt-equip");
    seedRides(p, "Cycling", [16, 18, 19, 20, 22, 23, 25, 27]);
    db.prepare(
      `INSERT INTO equipment (profile_id, name) VALUES (?, 'Stationary Bike')`
    ).run(p);
    const anchor = today(p);
    cacheDay(p, anchor, { tempMaxC: 3 });
    expect(parkedOf(p)[0].alternative).toBe("Stationary Bike");
  });

  it("does no gating at all without cached weather (silence over guessing)", () => {
    const p = newProfile("wt-nodata");
    seedRides(p, "Cycling", [16, 18, 19, 20, 22, 23, 25, 27]);
    // Deliberately no cached row for TODAY.
    expect(parkedOf(p)).toEqual([]);
  });

  it("does no gating for a profile with no home location", () => {
    const id = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('wt-nohome')").run()
        .lastInsertRowid
    );
    setTimezone(id, "UTC");
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, duration_min)
       VALUES (?, ?, 'cardio', 'Cycling', 60)`
    ).run(id, today(id));
    expect(parkedOf(id)).toEqual([]);
  });

  it("never parks an INDOOR activity, however hostile the day", () => {
    const p = newProfile("wt-indoor");
    seedRides(p, "Treadmill", [16, 18, 19, 20, 22, 23, 25, 27]);
    const anchor = today(p);
    cacheDay(p, anchor, { tempMaxC: -30, precipitationMm: 80 });
    expect(parkedOf(p)).toEqual([]);
  });
});

describe("seasonal parking must not read as staleness (#1724 part 4)", () => {
  it("a parked ride stops winning the least-recently-done slot, and returns when it clears", () => {
    // THE INVERSION THIS FIXES: the variety ranker favours the least-recently-done
    // activity, so as winter parks the bike the ride goes stale and gets pushed HARDER
    // exactly when conditions are worst.
    const p = newProfile("wt-variety");
    const anchor = today(p);
    // Cycling is the STALEST activity (oldest last-done) — it would win variety.
    seedRides(p, "Cycling", [16, 18, 19, 20, 22, 23, 25, 27]);
    // A recent indoor session, so there is something else to pick.
    logSession(p, shiftDateStr(anchor, -1), "Rowing", 20);

    // Cold day: the ride is parked, so the pick is NOT cycling.
    cacheDay(p, anchor, { tempMaxC: 3 });
    const cold = recommendNextWorkout(gatherCoachingInput(p, "kg", "km"));
    expect(cold.parked.map((x) => x.activity)).toEqual(["Cycling"]);
    const coldPick = cold.items.find((i) => i.kind === "cardio")?.activity;
    expect(coldPick?.activity ?? "").not.toBe("Cycling");

    // The gate lifts and the ride returns naturally — no special case, just the
    // exclusion ending.
    cacheDay(p, anchor, { tempMaxC: 20 });
    const mild = recommendNextWorkout(gatherCoachingInput(p, "kg", "km"));
    expect(mild.parked).toEqual([]);
    const mildPick = mild.items.find((i) => i.kind === "cardio")?.activity;
    expect(mildPick?.activity).toBe("Cycling");
  });
});

describe("cross-surface agreement (#221)", () => {
  it("the disclosure the coaching surfaces render comes from the one core result", () => {
    const p = newProfile("wt-cross");
    seedRides(p, "Cycling", [16, 18, 19, 20, 22, 23, 25, 27]);
    logSession(p, shiftDateStr(today(p), -2), "Stationary Bike", 20);
    cacheDay(p, today(p), { tempMaxC: 3 });

    const nw = recommendNextWorkout(gatherCoachingInput(p, "kg", "km"));
    const notes = contextNotes(nw);
    const line = notes.find((n) => n.startsWith("Too cold for cycling"));
    expect(line).toBeDefined();
    expect(line).toContain("Stationary Bike instead");
    expect(line).toContain("resumes when it warms up");
  });
});

describe("the parked figure reads in the reason's own unit (#1967)", () => {
  it("a WET park describes the rain — never millimetres wearing a °C", () => {
    // The reported line was "Too wet for cycling (45°C)": the day's precipitation, in
    // millimetres, formatted as an ambient temperature. End to end, over a real cached
    // day, the figure is now the day's own weather.
    const p = newProfile("wt-wet");
    seedRides(p, "Cycling", [16, 18, 19, 20, 22, 23, 25, 27]);
    const anchor = today(p);
    cacheDay(p, anchor, { tempMaxC: 18, precipitationMm: 45, weatherCode: 65 });
    // A morning of rain in the LOCAL day's hourly cache, so the phrase can place it.
    cacheHours(
      p,
      anchor,
      Array.from({ length: 24 }, (_, hour) => (hour >= 6 && hour <= 10 ? 6 : 0))
    );

    const parked = parkedOf(p);
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      reason: "wet",
      quantity: "precipitation",
      value: 45,
      weatherCode: 65,
    });

    const nw = recommendNextWorkout(gatherCoachingInput(p, "kg", "km"));
    const line = contextNotes(nw).find((n) => n.startsWith("Too wet"))!;
    expect(line).toContain("Too wet for cycling (heavy rain in the morning)");
    expect(line).not.toContain("°C");
    expect(line).not.toContain("45");
  });

  it("renders intensity alone when the hours don't cluster — never invented timing", () => {
    const p = newProfile("wt-wet-scattered");
    seedRides(p, "Cycling", [16, 18, 19, 20, 22, 23, 25, 27]);
    const anchor = today(p);
    cacheDay(p, anchor, { tempMaxC: 18, precipitationMm: 45, weatherCode: 61 });
    cacheHours(
      p,
      anchor,
      Array.from({ length: 24 }, () => 2)
    );

    const nw = recommendNextWorkout(gatherCoachingInput(p, "kg", "km"));
    const line = contextNotes(nw).find((n) => n.startsWith("Too wet"))!;
    expect(line).toContain("Too wet for cycling (heavy rain)");
  });

  it("a COLD park reads in the LOGIN's temperature scale on a surface that has one", () => {
    // Units belong to the login. The dashboard passes its preference through the gather;
    // the notification path keeps canonical °C, which is deliberate policy.
    const p = newProfile("wt-fahrenheit");
    seedRides(p, "Cycling", [16, 18, 19, 20, 22, 23, 25, 27]);
    const anchor = today(p);
    cacheDay(p, anchor, { tempMaxC: 3 });

    const notesOf = (unit: "C" | "F") =>
      recommendCoaching(gatherCoachingInput(p, "kg", "km", unit)).flatMap(
        (r) => r.notes ?? []
      );
    expect(notesOf("F").find((n) => n.startsWith("Too cold"))).toContain(
      "(37°F)"
    );
    // No login to read a preference from ⇒ canonical °C (the notification path).
    expect(notesOf("C").find((n) => n.startsWith("Too cold"))).toContain(
      "(3°C)"
    );
  });
});

describe("conditions stamps on the training log feed (#1728)", () => {
  it("stamps an outdoor session with the weather of its day, writing nothing", () => {
    const p = newProfile("wt-stamp");
    const anchor = today(p);
    logSession(p, anchor, "Cycling", 31);
    cacheDay(p, anchor, { tempMaxC: 31, weatherCode: 0 });

    const feed = buildTrainingLogFeedPage(p, null, CELSIUS_UNITS);
    const card = feed.groups[0].cards[0];
    expect(card.metrics[0]).toBe("31°C · clear");

    // Read-time only: the activity row gained nothing.
    const row = db
      .prepare(`SELECT * FROM activities WHERE profile_id = ?`)
      .get(p) as Record<string, unknown>;
    expect(Object.keys(row)).not.toContain("weather_code");
  });

  it("renders no stamp for an INDOOR session, however good the data", () => {
    const p = newProfile("wt-stamp-indoor");
    const anchor = today(p);
    logSession(p, anchor, "Treadmill", 31);
    cacheDay(p, anchor, { tempMaxC: 31, weatherCode: 0 });

    const feed = buildTrainingLogFeedPage(p, null, CELSIUS_UNITS);
    // No stamp anywhere in the metrics row — the outdoor flag decides, not the data.
    const metrics = feed.groups[0].cards[0].metrics;
    expect(metrics.some((m) => m.includes("·"))).toBe(false);
  });

  it("renders no stamp when the cache never covered that day", () => {
    const p = newProfile("wt-stamp-gap");
    const anchor = today(p);
    db.prepare(
      `INSERT INTO activities (profile_id, date, type, title, duration_min)
       VALUES (?, ?, 'cardio', 'Cycling', 60)`
    ).run(p, anchor);

    const feed = buildTrainingLogFeedPage(p, null, CELSIUS_UNITS);
    const metrics = feed.groups[0].cards[0].metrics;
    expect(metrics.some((m) => m.includes("·"))).toBe(false);
  });
});
