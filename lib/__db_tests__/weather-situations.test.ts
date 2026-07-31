// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issue #1726 — the weather-derived situations end to end. The pure predicates are
// pinned in lib/__tests__/weather-situations.test.ts; this seeds a real cached daily
// series through the SYNC (so the ingest's idempotency and accounting are exercised on
// the way in, not bypassed) and asserts the three payoffs the issue promises:
//
//   1. situational intake gating — a pollen-keyed antihistamine goes due exactly while
//      the High pollen situation holds, and not otherwise;
//   2. situation-impact — a heatwave fixture yields a pooled impact card from windows
//      reconstructed out of the cache, with nothing written;
//   3. the state line renders for the surfaces (bar, check-in, digest) that share it.
//
// Plus the relevance gate: a profile with weather data but no reason to care sees
// nothing at all.
//
// Runs via `npm run test:db` (vitest.db.config.ts). The `db` singleton is pointed at a
// throwaway per-file temp DB by lib/__db_tests__/setup.ts.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setHomeLocation, setTimezone } from "@/lib/settings";
import {
  getSituationEvents,
  resolveSituationId,
} from "@/lib/settings/profile-attrs";
import { runWeatherSync } from "@/lib/integrations/weather-sync";
import type {
  DailyWeatherRow,
  WeatherSource,
} from "@/lib/integrations/open-meteo";
import { getWeatherDays } from "@/lib/integrations/weather-cache";
import {
  getEffectiveActiveSituations,
  getDerivedSituationLines,
  getSituationalDueCount,
  resolveDerivedSituations,
} from "@/lib/queries";
import {
  getWeatherSituationWindows,
  weatherSituationsRelevant,
} from "@/lib/queries/weather-situations";
import { getSituationImpacts } from "@/lib/queries/situation-impact";
import {
  BUILTIN_HEATWAVE_SITUATION,
  BUILTIN_HIGH_POLLEN_SITUATION,
  HEATWAVE_ENTER_C,
  POLLEN_ENTER,
} from "@/lib/weather-situations";

// The daily cache is GLOBAL and keyed by (coarse location, date) — two profiles in the
// same city deliberately SHARE rows (migration 128's scoping rationale). So each fixture
// profile gets its OWN coarse coordinate: otherwise one test's series would be another
// test's weather, which is correct product behavior and useless test isolation.
const LNG = -74;
let seq = 0;
const homeByProfile = new Map<number, { lat: number; lng: number }>();

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`${name}-${seq++}`)
      .lastInsertRowid
  );
  setTimezone(id, "UTC");
  // 0.1° apart — exactly the storage precision, so no two fixtures collide.
  const home = { lat: 20 + seq / 10, lng: LNG };
  homeByProfile.set(id, home);
  setHomeLocation(id, home);
  return id;
}

function homeOf(profileId: number): { lat: number; lng: number } {
  return homeByProfile.get(profileId)!;
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

// A fixture source that returns a fixed daily series regardless of the requested window
// (the sync's own window math is exercised by the #1172 suite; here we control the
// rows). No hourly rows — the daily half is what this file is about.
function dailySource(rows: DailyWeatherRow[]): WeatherSource {
  return {
    id: "fixture",
    async fetchHourly() {
      return { ok: true, rows: [] };
    },
    async fetchDaily() {
      return { ok: true, rows };
    },
  };
}

// `count` consecutive days ending on `endDate`, each built by `make`.
function trailing(
  endDate: string,
  count: number,
  make: (date: string, i: number) => Partial<DailyWeatherRow>
): DailyWeatherRow[] {
  const rows: DailyWeatherRow[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const date = shiftDateStr(endDate, -i);
    rows.push({ ...emptyDay(date), ...make(date, i) });
  }
  return rows;
}

// A situational supplement keyed to `situation`, with one dose.
function keyItem(profileId: number, name: string, situation: string): number {
  const sid = resolveSituationId(profileId, situation)!;
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, kind, condition, obligation, situation, situation_id, active)
         VALUES (?, ?, 'supplement', 'situational', 'should', ?, ?, 1)`
      )
      .run(profileId, name, situation, sid).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 tab', 'morning', 'any', 0)`
  ).run(itemId);
  return itemId;
}

describe("weather ingest — idempotent daily cache (#1726)", () => {
  it("inserts on first sync, reports unchanged on re-sync, and counts the split", async () => {
    const p = newProfile("weather-daily-idem");
    const anchor = today(p);
    const rows = trailing(anchor, 3, (_d, i) => ({
      tempMaxC: 20 + i,
      pressureMslHpa: 1010,
    }));
    const src = dailySource(rows);

    const first = await runWeatherSync(p, src);
    expect(first).toMatchObject({ days: 3, inserted: 3, unchanged: 0 });

    const second = await runWeatherSync(p, src);
    expect(second).toMatchObject({ days: 3, inserted: 0, unchanged: 3 });

    // Never duplicated — the (lat, lng, date) key held.
    const { lat, lng } = homeOf(p);
    expect(
      getWeatherDays(lat, lng, shiftDateStr(anchor, -10), anchor)
    ).toHaveLength(3);

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
    expect(ev.unchanged).toBe(3);
  });

  it("a partial fetch never erases an already-cached reading", async () => {
    // The load-bearing degradation case: the air-quality half fails on a later run, so
    // pollen/AQI come back null. COALESCE must keep what was already stored rather than
    // wiping it — a re-fetch destroying data it simply didn't ask for.
    const p = newProfile("weather-partial");
    const anchor = today(p);
    await runWeatherSync(
      p,
      dailySource(
        trailing(anchor, 1, () => ({ tempMaxC: 25, aqi: 140, pollenTree: 120 }))
      )
    );
    const after = await runWeatherSync(
      p,
      dailySource(trailing(anchor, 1, () => ({ tempMaxC: 26 })))
    );
    expect(after).toMatchObject({ updated: 1 });

    const { lat, lng } = homeOf(p);
    const [cached] = getWeatherDays(lat, lng, anchor, anchor);
    expect(cached.tempMaxC).toBe(26);
    expect(cached.aqi).toBe(140);
    expect(cached.pollenTree).toBe(120);
  });

  it("degrades rather than failing when the whole daily fetch errors", async () => {
    const p = newProfile("weather-daily-fail");
    const res = await runWeatherSync(p, {
      id: "fixture",
      async fetchHourly() {
        return { ok: true, rows: [] };
      },
      async fetchDaily() {
        return { ok: false, rows: [], status: 503, error: "upstream down" };
      },
    });
    // The RUN still succeeded (the hourly half is what the UV dose needs); the daily
    // failure is reported as a partial, and no situation has data to fire on.
    expect(res).toMatchObject({ days: 0, partial: "upstream down" });
    const anchor = today(p);
    expect(resolveDerivedSituations(p, anchor).weather).toEqual([]);
  });
});

describe("situational intake gating on weather (#1726 payoff 1)", () => {
  it("a pollen-keyed antihistamine goes due while High pollen holds", async () => {
    const p = newProfile("pollen-due");
    keyItem(p, "Cetirizine", BUILTIN_HIGH_POLLEN_SITUATION);
    const anchor = today(p);
    await runWeatherSync(
      p,
      dailySource(
        trailing(anchor, 3, () => ({
          tempMaxC: 18,
          pollenGrass: POLLEN_ENTER.grass + 10,
        }))
      )
    );

    expect(
      getEffectiveActiveSituations(p, anchor).has(BUILTIN_HIGH_POLLEN_SITUATION)
    ).toBe(true);
    expect(getSituationalDueCount(p)).toBe(1);
  });

  it("and is not due on a low-pollen day", async () => {
    const p = newProfile("pollen-quiet");
    keyItem(p, "Cetirizine", BUILTIN_HIGH_POLLEN_SITUATION);
    const anchor = today(p);
    await runWeatherSync(
      p,
      dailySource(trailing(anchor, 3, () => ({ tempMaxC: 18, pollenGrass: 1 })))
    );

    expect(
      getEffectiveActiveSituations(p, anchor).has(BUILTIN_HIGH_POLLEN_SITUATION)
    ).toBe(false);
    expect(getSituationalDueCount(p)).toBe(0);
  });

  it("never activates on a FORECAST day — only weather that has happened", async () => {
    // The series reaches ahead for the planning surfaces; the situation must not.
    const p = newProfile("pollen-forecast");
    keyItem(p, "Cetirizine", BUILTIN_HIGH_POLLEN_SITUATION);
    const anchor = today(p);
    await runWeatherSync(
      p,
      dailySource([
        { ...emptyDay(anchor), tempMaxC: 18, pollenGrass: 1 },
        {
          ...emptyDay(shiftDateStr(anchor, 2)),
          tempMaxC: 18,
          pollenGrass: POLLEN_ENTER.grass + 50,
        },
      ])
    );
    expect(
      getEffectiveActiveSituations(p, anchor).has(BUILTIN_HIGH_POLLEN_SITUATION)
    ).toBe(false);
  });

  it("stays silent for a profile with no home location", async () => {
    const id = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('no-home-weather')").run()
        .lastInsertRowid
    );
    setTimezone(id, "UTC");
    keyItem(id, "Cetirizine", BUILTIN_HIGH_POLLEN_SITUATION);
    const anchor = today(id);
    expect(weatherSituationsRelevant(id, anchor)).toBe(false);
    expect(resolveDerivedSituations(id, anchor).weather).toEqual([]);
  });
});

describe("relevance gating (#1726)", () => {
  it("a profile with weather data but no keyed item and no related symptom sees nothing", async () => {
    const p = newProfile("weather-irrelevant");
    const anchor = today(p);
    await runWeatherSync(
      p,
      dailySource(
        trailing(anchor, 4, () => ({ tempMaxC: HEATWAVE_ENTER_C + 3 }))
      )
    );
    expect(weatherSituationsRelevant(p, anchor)).toBe(false);
    expect(resolveDerivedSituations(p, anchor).weather).toEqual([]);
    expect(getDerivedSituationLines(p, anchor).weather).toEqual([]);
  });

  it("a logged weather-explainable symptom turns relevance on", async () => {
    const p = newProfile("weather-symptom");
    const anchor = today(p);
    db.prepare(
      `INSERT INTO symptom_logs (profile_id, date, symptom, severity)
       VALUES (?, ?, 'Headache', 2)`
    ).run(p, shiftDateStr(anchor, -3));
    await runWeatherSync(
      p,
      dailySource(
        trailing(anchor, 4, () => ({ tempMaxC: HEATWAVE_ENTER_C + 3 }))
      )
    );
    expect(weatherSituationsRelevant(p, anchor)).toBe(true);
    expect(
      resolveDerivedSituations(p, anchor).weather.map((s) => s.name)
    ).toContain(BUILTIN_HEATWAVE_SITUATION);
  });

  it("an unrelated symptom does not", async () => {
    const p = newProfile("weather-unrelated-symptom");
    const anchor = today(p);
    db.prepare(
      `INSERT INTO symptom_logs (profile_id, date, symptom, severity)
       VALUES (?, ?, 'Ankle soreness', 2)`
    ).run(p, shiftDateStr(anchor, -3));
    expect(weatherSituationsRelevant(p, anchor)).toBe(false);
  });
});

describe("weather state lines (#1726)", () => {
  it("render for an active situation with keyed items, in the login's units", async () => {
    const p = newProfile("weather-line");
    keyItem(p, "Electrolytes", BUILTIN_HEATWAVE_SITUATION);
    const anchor = today(p);
    await runWeatherSync(
      p,
      dailySource(trailing(anchor, 4, () => ({ tempMaxC: 35 })))
    );

    expect(getDerivedSituationLines(p, anchor, "C").weather).toEqual([
      "Heatwave (35°C) — 1 item active (auto)",
    ]);
    expect(getDerivedSituationLines(p, anchor, "F").weather).toEqual([
      "Heatwave (95°F) — 1 item active (auto)",
    ]);
  });

  it("render nothing when the situation holds but nothing is keyed to it", async () => {
    // Relevance is on (a keyed pollen item), the heatwave holds — but no item is keyed
    // to the heatwave, so there is nothing to acknowledge.
    const p = newProfile("weather-line-unkeyed");
    keyItem(p, "Cetirizine", BUILTIN_HIGH_POLLEN_SITUATION);
    const anchor = today(p);
    await runWeatherSync(
      p,
      dailySource(trailing(anchor, 4, () => ({ tempMaxC: 35 })))
    );
    expect(
      resolveDerivedSituations(p, anchor).weather.map((s) => s.name)
    ).toContain(BUILTIN_HEATWAVE_SITUATION);
    expect(getDerivedSituationLines(p, anchor).weather).toEqual([]);
  });
});

describe("weather situation impact (#1726 payoff 2)", () => {
  it("reconstructs windows from the cache and writes nothing", async () => {
    const p = newProfile("weather-impact");
    keyItem(p, "Electrolytes", BUILTIN_HEATWAVE_SITUATION);
    const anchor = today(p);
    // A hot spell of five days, then four mild ones.
    await runWeatherSync(
      p,
      dailySource(
        trailing(anchor, 9, (_d, i) => ({ tempMaxC: i >= 4 ? 35 : 20 }))
      )
    );

    const windows = getWeatherSituationWindows(
      p,
      BUILTIN_HEATWAVE_SITUATION,
      anchor
    );
    expect(windows).toEqual([
      { start: shiftDateStr(anchor, -8), end: shiftDateStr(anchor, -4) },
    ]);

    // Derived means derived. Keying an item to the situation created its VOCABULARY row
    // (that is the item form's doing, not the engine's) — but nothing ever flipped it
    // ACTIVE, and no dated transition was logged. The windows above came entirely from
    // the cached series.
    const row = db
      .prepare(
        `SELECT active FROM situations WHERE profile_id = ? AND name = ?`
      )
      .get(p, BUILTIN_HEATWAVE_SITUATION) as { active: number };
    expect(row.active).toBe(0);
    expect(getSituationEvents(p)).toEqual([]);
  });

  it("yields a pooled impact card once the outcome series is rich enough", async () => {
    const p = newProfile("weather-impact-card");
    keyItem(p, "Electrolytes", BUILTIN_HEATWAVE_SITUATION);
    const anchor = today(p);
    await runWeatherSync(
      p,
      dailySource(
        trailing(anchor, 20, (_d, i) => ({ tempMaxC: i < 6 ? 35 : 20 }))
      )
    );
    // Resting HR: higher through the hot spell than on the baseline days before it.
    // `metric:resting_hr` resolves from body_metrics (lib/protocol-metrics), which is
    // the series the pooled comparison reads.
    for (let i = 19; i >= 0; i--) {
      db.prepare(
        `INSERT INTO body_metrics (profile_id, date, resting_hr, source)
         VALUES (?, ?, ?, 'test')`
      ).run(p, shiftDateStr(anchor, -i), i < 6 ? 62 : 54);
    }

    const impacts = getSituationImpacts(p, anchor, "kg");
    const heat = impacts.find(
      (i) => i.situation === BUILTIN_HEATWAVE_SITUATION
    );
    expect(heat).toBeDefined();
    expect(heat!.windowCount).toBe(1);
    expect(heat!.duringDays).toBe(6);
    const hr = heat!.outcomes.find((o) => o.key === "metric:resting_hr");
    // The heatwave days really did run hotter-hearted than the baseline ones — the whole
    // point of pointing the existing pooled engine at a weather window.
    expect(hr?.meanDelta).toBeGreaterThan(0);
  });

  it("produces no card for a profile that isn't weather-relevant", async () => {
    const p = newProfile("weather-impact-irrelevant");
    const anchor = today(p);
    await runWeatherSync(
      p,
      dailySource(
        trailing(anchor, 12, (_d, i) => ({ tempMaxC: i < 6 ? 35 : 20 }))
      )
    );
    expect(getSituationImpacts(p, anchor, "kg")).toEqual([]);
  });
});
