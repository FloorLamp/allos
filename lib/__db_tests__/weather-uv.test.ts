// DB INTEGRATION TIER (issue #1172): the Open-Meteo weather/UV sync + the two-sided
// UV-dose read layer against the real schema. Fully offline — the WeatherSource is a
// fixture, no network. Covers: sync idempotency (dedup the hourly series on
// location+hour, re-fetch is `unchanged`), historical backfill of a past logged
// activity, the UV-dose crossing (getUvDoseForDay), and the overexposure care finding
// firing only past the skin-type threshold + staying silent without a skin type.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { setHomeLocation, setTimezone, setSkinType } from "@/lib/settings";
import {
  runWeatherSync,
  WEATHER_FORECAST_DAYS,
  type WeatherSyncResult,
} from "@/lib/integrations/weather-sync";
import type {
  WeatherSource,
  HourlyUvRow,
  DailyWeatherRow,
} from "@/lib/integrations/open-meteo";
import { getUvHoursForDay } from "@/lib/integrations/weather-cache";
import { getUvDoseForDay } from "@/lib/queries/weather";
import { decideUvOverexposure } from "@/lib/uv-overexposure";
import { collectUpcoming } from "@/lib/queries";

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setHomeLocation(id, { lat: 40.7, lng: -74 });
  setTimezone(id, "America/New_York");
  return id;
}

function seedOutdoorActivity(
  profileId: number,
  date: string,
  start: string,
  end: string
) {
  db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, start_time, end_time, avg_temp_c)
     VALUES (?, ?, 'cardio', 'Walk', ?, ?, 18)`
  ).run(profileId, date, start, end);
}

// A fixture source that returns a fixed set of hourly rows regardless of the requested
// window (the sync's own window math is exercised separately; here we control the rows).
function fixtureSource(
  rows: HourlyUvRow[],
  dailyRows: DailyWeatherRow[] = []
): WeatherSource {
  return {
    id: "fixture",
    async fetchHourly() {
      return { ok: true, rows };
    },
    async fetchDaily() {
      return { ok: true, rows: dailyRows };
    },
  };
}

function uvRow(hourTs: string, uvIndex: number): HourlyUvRow {
  return {
    hourTs,
    uvIndex,
    uvIndexClearSky: uvIndex + 0.3,
    shortwaveRadiation: 500,
    directRadiation: 400,
    diffuseRadiation: 100,
    precipitationMm: null,
  };
}

const DATE = "2026-06-15";

describe("runWeatherSync — idempotent hourly cache (#1172)", () => {
  it("inserts on first sync and reports unchanged on re-sync (dedup on location+hour)", async () => {
    const p = newProfile("weather-idem");
    const rows = [uvRow(`${DATE}T10:00`, 6), uvRow(`${DATE}T11:00`, 7)];
    const src = fixtureSource(rows);

    const first = (await runWeatherSync(p, src)) as WeatherSyncResult;
    expect(first.inserted).toBe(2);
    expect(first.unchanged).toBe(0);

    const second = (await runWeatherSync(p, src)) as WeatherSyncResult;
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(2);

    // Exactly two rows cached for the location+day — never duplicated.
    expect(getUvHoursForDay(40.7, -74, DATE)).toHaveLength(2);
  });

  it("round-trips HOURLY PRECIPITATION through the same idempotent upsert (#1967)", async () => {
    // The column the wet-park description's timing clause reads. It rides the existing
    // (location, hour) upsert, so the accounting rules are unchanged: a re-fetch of the
    // same window rewrites nothing, and a changed millimetre value alone is an update.
    const p = newProfile("weather-precip");
    // Its OWN coordinate: the cache is global and location-keyed, so sharing this
    // file's default one would make another test's hours this test's.
    const home = { lat: 44.4, lng: -63.6 };
    setHomeLocation(p, home);
    const wet = { ...uvRow(`${DATE}T09:00`, 3), precipitationMm: 2.4 };
    const dry = { ...uvRow(`${DATE}T10:00`, 4), precipitationMm: 0 };

    const first = (await runWeatherSync(
      p,
      fixtureSource([wet, dry])
    )) as WeatherSyncResult;
    expect(first.inserted).toBe(2);
    expect(
      getUvHoursForDay(home.lat, home.lng, DATE).map((h) => h.precipitationMm)
    ).toEqual([2.4, 0]);

    const again = (await runWeatherSync(
      p,
      fixtureSource([wet, dry])
    )) as WeatherSyncResult;
    expect(again.unchanged).toBe(2);
    expect(again.updated).toBe(0);

    const changed = (await runWeatherSync(
      p,
      fixtureSource([{ ...wet, precipitationMm: 5.1 }, dry])
    )) as WeatherSyncResult;
    expect(changed.updated).toBe(1);
    expect(changed.unchanged).toBe(1);
    expect(getUvHoursForDay(home.lat, home.lng, DATE)[0].precipitationMm).toBe(
      5.1
    );
  });

  it("updates a changed hour and appends a sync event with the split", async () => {
    const p = newProfile("weather-update");
    await runWeatherSync(p, fixtureSource([uvRow(`${DATE}T10:00`, 5)]));
    const res = (await runWeatherSync(
      p,
      fixtureSource([uvRow(`${DATE}T10:00`, 8)])
    )) as WeatherSyncResult;
    expect(res.updated).toBe(1);
    const cached = getUvHoursForDay(40.7, -74, DATE);
    expect(cached[0].uvIndex).toBe(8);

    const ev = db
      .prepare(
        `SELECT ok, inserted, updated, unchanged FROM integration_sync_events
          WHERE profile_id = ? AND provider = 'weather' ORDER BY id DESC LIMIT 1`
      )
      .get(p) as {
      ok: number;
      inserted: number;
      updated: number;
      unchanged: number;
    };
    expect(ev.ok).toBe(1);
    expect(ev.updated).toBe(1);
  });

  it("no-ops gracefully without a home location", async () => {
    const id = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('no-home')").run()
        .lastInsertRowid
    );
    const res = await runWeatherSync(
      id,
      fixtureSource([uvRow(`${DATE}T10:00`, 6)])
    );
    expect(res).toHaveProperty("error");
  });

  it("records a failed sync event on a provider error", async () => {
    const p = newProfile("weather-fail");
    const failing: WeatherSource = {
      id: "fixture",
      async fetchHourly() {
        return { ok: false, rows: [], status: 500, error: "boom" };
      },
      async fetchDaily() {
        return { ok: false, rows: [], status: 500, error: "boom" };
      },
    };
    const res = await runWeatherSync(p, failing);
    expect(res).toHaveProperty("error");
    const ev = db
      .prepare(
        `SELECT ok FROM integration_sync_events
          WHERE profile_id = ? AND provider = 'weather' ORDER BY id DESC LIMIT 1`
      )
      .get(p) as { ok: number };
    expect(ev.ok).toBe(0);
  });

  // #1771 defect 2: the daily half (#1743) reaches WEATHER_FORECAST_DAYS ahead, but
  // the hourly-fetch FAILURE paths used to stamp the hourly half's shorter window —
  // so interleaved events of one provider described two different window shapes, and
  // Review implied a failure had shrunk the coverage target. The window describes what
  // the RUN SET OUT TO COVER, so every event of a run now stamps the same one.
  it("stamps the same window on a failed run as on a successful one", async () => {
    const p = newProfile("weather-window");
    const failing: WeatherSource = {
      id: "fixture",
      async fetchHourly() {
        return { ok: false, rows: [], status: 503, error: "upstream down" };
      },
      async fetchDaily() {
        return { ok: false, rows: [], status: 503, error: "upstream down" };
      },
    };
    await runWeatherSync(p, failing);
    await runWeatherSync(p, fixtureSource([uvRow(`${DATE}T10:00`, 6)]));

    const events = db
      .prepare(
        `SELECT ok, window_start, window_end FROM integration_sync_events
          WHERE profile_id = ? AND provider = 'weather' ORDER BY id`
      )
      .all(p) as {
      ok: number;
      window_start: string | null;
      window_end: string | null;
    }[];
    expect(events).toHaveLength(2);
    const [failure, success] = events;
    expect(failure.ok).toBe(0);
    expect(success.ok).toBe(1);
    expect(failure.window_start).toBe(success.window_start);
    expect(failure.window_end).toBe(success.window_end);
    // And that shared window is the run's full intended reach — the daily half's, a
    // week past today, not the hourly half's today+1.
    const todayUtc = new Date().toISOString().slice(0, 10);
    const expectedEnd = new Date(`${todayUtc}T00:00:00Z`);
    expectedEnd.setUTCDate(expectedEnd.getUTCDate() + WEATHER_FORECAST_DAYS);
    expect(success.window_end).toBe(expectedEnd.toISOString().slice(0, 10));
  });

  // A failure that happens in the WRITE half (the upsert throws) takes the second
  // failure path — it stamps the same run window too.
  it("stamps the run window on a cache-write failure as well", async () => {
    const p = newProfile("weather-window-write");
    const bad = fixtureSource([
      // An hour timestamp the cache upsert refuses — drives the catch path.
      { ...uvRow(`${DATE}T10:00`, 6), hourTs: null as unknown as string },
    ]);
    await runWeatherSync(p, bad);
    await runWeatherSync(p, fixtureSource([uvRow(`${DATE}T11:00`, 6)]));
    const events = db
      .prepare(
        `SELECT ok, window_start, window_end FROM integration_sync_events
          WHERE profile_id = ? AND provider = 'weather' ORDER BY id`
      )
      .all(p) as {
      ok: number;
      window_start: string | null;
      window_end: string | null;
    }[];
    const failure = events.find((e) => e.ok === 0);
    const success = events.find((e) => e.ok === 1);
    expect(failure).toBeTruthy();
    expect(success).toBeTruthy();
    expect(failure!.window_end).toBe(success!.window_end);
    expect(failure!.window_start).toBe(success!.window_start);
  });
});

describe("getUvDoseForDay — the ONE crossing, with historical backfill", () => {
  it("crosses a past logged activity with backfilled UV (live source)", async () => {
    const p = newProfile("weather-backfill");
    // A past outdoor walk 10:00–12:00 whose UV is backfilled AFTER the fact.
    seedOutdoorActivity(p, DATE, "10:00", "12:00");
    await runWeatherSync(
      p,
      fixtureSource([uvRow(`${DATE}T10:00`, 6), uvRow(`${DATE}T11:00`, 6)])
    );

    const dose = getUvDoseForDay(p, DATE);
    expect(dose).not.toBeNull();
    expect(dose!.uvSource).toBe("live");
    expect(dose!.outdoorMinutes).toBe(120);
    // 120 min at UV6 → 720 UV-minutes.
    expect(dose!.uvMinutes).toBe(720);
  });

  it("returns null without a home location (feature off)", () => {
    const id = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('no-home-2')").run()
        .lastInsertRowid
    );
    expect(getUvDoseForDay(id, DATE)).toBeNull();
  });

  it("degrades to a clear-sky estimate when no live UV is cached", () => {
    // A DISTINCT home location that no other test synced UV for — the cache is
    // location-keyed and GLOBAL, so reusing 40.7/-74 would hit another test's live
    // rows (which is the correct shared-cache behavior). Los Angeles has no rows.
    const p = Number(
      db
        .prepare("INSERT INTO profiles (name) VALUES ('weather-clearsky')")
        .run().lastInsertRowid
    );
    setHomeLocation(p, { lat: 34.0, lng: -118.2 });
    setTimezone(p, "America/Los_Angeles");
    seedOutdoorActivity(p, DATE, "10:00", "12:00");
    // No sync → no cached rows → the sun.ts elevation ceiling fills in.
    const dose = getUvDoseForDay(p, DATE);
    expect(dose).not.toBeNull();
    expect(dose!.uvSource).toBe("clear-sky");
    expect(dose!.outdoorMinutes).toBe(120);
  });
});

describe("overexposure care finding — past threshold only, silent without skin type", () => {
  it("fires past the skin-type MED and surfaces on Upcoming as a care item", async () => {
    const p = newProfile("weather-burn");
    seedOutdoorActivity(p, DATE, "10:00", "12:00");
    setSkinType(p, 2); // Fitzpatrick II, MED 2.5 SED
    // 120 min at UV9 → SED = 120×9×0.015 = 16.2 ≫ 2.5.
    await runWeatherSync(
      p,
      fixtureSource([uvRow(`${DATE}T10:00`, 9), uvRow(`${DATE}T11:00`, 9)])
    );

    const dose = getUvDoseForDay(p, DATE)!;
    expect(dose.overexposed).toBe(true);
    expect(decideUvOverexposure(DATE, dose)).not.toBeNull();

    // End-to-end wiring: it appears on the Upcoming care list under uv-exposure.
    const items = collectUpcoming(p, DATE);
    const uv = items.filter((i) => i.domain === "uv-exposure");
    expect(uv).toHaveLength(1);
    expect(uv[0].key).toContain("uv-exposure:");
  });

  it("stays silent without a skin type even at a high dose", async () => {
    const p = newProfile("weather-noburn");
    seedOutdoorActivity(p, DATE, "10:00", "12:00");
    // No skin type set.
    await runWeatherSync(
      p,
      fixtureSource([uvRow(`${DATE}T10:00`, 9), uvRow(`${DATE}T11:00`, 9)])
    );

    const dose = getUvDoseForDay(p, DATE)!;
    expect(dose.overexposed).toBeNull();
    expect(decideUvOverexposure(DATE, dose)).toBeNull();
    const items = collectUpcoming(p, DATE);
    expect(items.filter((i) => i.domain === "uv-exposure")).toHaveLength(0);
  });
});
