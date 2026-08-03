// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issue #1727 — the med × weather safety composition over a realistic fixture. The pure
// decisions are pinned in lib/__tests__/weather-med-safety.test.ts; this seeds a real
// active stack plus a real cached weather series and asserts the END-TO-END behavior on
// the Upcoming surface:
//
//   • the enriched UV line renders WITH a photosensitizer fixture and not without —
//     and stays ONE item, never a second warning about the same afternoon;
//   • the standalone photosensitizer note appears on a high-UV day with no overexposure
//     and disappears the moment overexposure takes over;
//   • the heat-risk note requires BOTH the heatwave situation and a matching item;
//   • a `may`-obligation photosensitizer still triggers (obligation-blind, #1505 pinned).
//
// Runs via `npm run test:db` (vitest.db.config.ts).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setHomeLocation, setSkinType, setTimezone } from "@/lib/settings";
import { runWeatherSync } from "@/lib/integrations/weather-sync";
import type {
  DailyWeatherRow,
  HourlyUvRow,
  WeatherSource,
} from "@/lib/integrations/open-meteo";
import { collectUpcoming } from "@/lib/queries";
import { getWeatherMedWarnings } from "@/lib/queries/intake/warnings";
import { WEATHER_MED_PREFIX } from "@/lib/weather-med-safety";
import type { IntakeObligation } from "@/lib/types";

const LNG = -74;
let seq = 0;

// Each fixture profile gets its own coarse coordinate: the weather cache is global and
// location-keyed, so shared coordinates would make one test's weather another's.
function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`${name}-${seq++}`)
      .lastInsertRowid
  );
  setTimezone(id, "UTC");
  setHomeLocation(id, { lat: 30 + seq / 10, lng: LNG });
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

function source(
  daily: DailyWeatherRow[],
  hourly: HourlyUvRow[] = []
): WeatherSource {
  return {
    id: "fixture",
    async fetchHourly() {
      return { ok: true, rows: hourly };
    },
    async fetchDaily() {
      return { ok: true, rows: daily };
    },
  };
}

function trailing(
  endDate: string,
  count: number,
  make: (i: number) => Partial<DailyWeatherRow>
): DailyWeatherRow[] {
  const rows: DailyWeatherRow[] = [];
  for (let i = count - 1; i >= 0; i--) {
    rows.push({ ...emptyDay(shiftDateStr(endDate, -i)), ...make(i) });
  }
  return rows;
}

// An active intake item of either kind — the check is kind-blind, so both are used.
function addItem(
  profileId: number,
  name: string,
  kind: "medication" | "supplement",
  obligation: IntakeObligation = "must"
): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, kind, condition, obligation, active)
         VALUES (?, ?, ?, 'daily', ?, 1)`
      )
      .run(profileId, name, kind, obligation).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 tab', 'morning', 'any', 0)`
  ).run(id);
  return id;
}

function weatherMedItemsOf(profileId: number) {
  return collectUpcoming(profileId, today(profileId)).filter(
    (i) => i.domain === "weather-med"
  );
}

function uvItemsOf(profileId: number) {
  return collectUpcoming(profileId, today(profileId)).filter(
    (i) => i.domain === "uv-exposure"
  );
}

// An outdoor activity long enough to build a real UV dose (the overexposure path needs
// logged daylight outdoor minutes, not just a sunny forecast).
function seedOutdoorActivity(profileId: number, date: string) {
  db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, start_time, end_time, avg_temp_c)
     VALUES (?, ?, 'cardio', 'Long walk', '10:00', '15:00', 24)`
  ).run(profileId, date);
}

function uvHour(date: string, hour: number, uv: number): HourlyUvRow {
  return {
    hourTs: `${date}T${String(hour).padStart(2, "0")}:00`,
    uvIndex: uv,
    uvIndexClearSky: uv,
    shortwaveRadiation: 800,
    directRadiation: 650,
    diffuseRadiation: 150,
    precipitationMm: null,
  };
}

describe("the curated attribute gather is kind- and obligation-blind (#1727)", () => {
  it("matches a SUPPLEMENT photosensitizer", () => {
    const p = newProfile("wm-supplement");
    addItem(p, "St. John's Wort", "supplement");
    const hits = getWeatherMedWarnings(p, "photosensitizing");
    expect(hits.map((h) => h.entryKey)).toEqual(["st_johns_wort"]);
  });

  it("matches a `may`-obligation item exactly like a `must` one (#1505 pinned)", () => {
    // Obligation decides whether the app CONTACTS you about taking something. It says
    // nothing about whether the drug in your body reacts to sunlight.
    const p = newProfile("wm-may");
    addItem(p, "Doxycycline", "medication", "may");
    expect(getWeatherMedWarnings(p, "photosensitizing")).toHaveLength(1);
  });

  it("ignores an INACTIVE item (it is not in the stack)", () => {
    const p = newProfile("wm-inactive");
    const id = addItem(p, "Doxycycline", "medication");
    db.prepare(`UPDATE intake_items SET active = 0 WHERE id = ?`).run(id);
    expect(getWeatherMedWarnings(p, "photosensitizing")).toEqual([]);
  });

  it("produces nothing for an unrecognized item", () => {
    const p = newProfile("wm-unknown");
    addItem(p, "Greens Powder", "supplement");
    expect(getWeatherMedWarnings(p, "photosensitizing")).toEqual([]);
    expect(getWeatherMedWarnings(p, "heat-risk")).toEqual([]);
  });
});

describe("enriched UV line (#1727 composition 1)", () => {
  it("carries the med fact, as ONE item and not a second warning", async () => {
    const p = newProfile("wm-uv-enriched");
    setSkinType(p, 2);
    addItem(p, "Doxycycline", "medication");
    const anchor = today(p);
    seedOutdoorActivity(p, anchor);
    await runWeatherSync(
      p,
      source(
        trailing(anchor, 1, () => ({ uvIndexMax: 10, tempMaxC: 24 })),
        [10, 11, 12, 13, 14].map((h) => uvHour(anchor, h, 10))
      )
    );

    const uv = uvItemsOf(p);
    expect(uv).toHaveLength(1);
    expect(uv[0].detail).toContain("Doxycycline increases sun sensitivity");

    // The standalone note stands down while the overexposure line is speaking — one
    // line about one afternoon.
    expect(weatherMedItemsOf(p)).toHaveLength(0);
  });

  it("renders the plain UV line without a photosensitizer in the stack", async () => {
    const p = newProfile("wm-uv-plain");
    setSkinType(p, 2);
    addItem(p, "Vitamin D3", "supplement");
    const anchor = today(p);
    seedOutdoorActivity(p, anchor);
    await runWeatherSync(
      p,
      source(
        trailing(anchor, 1, () => ({ uvIndexMax: 10, tempMaxC: 24 })),
        [10, 11, 12, 13, 14].map((h) => uvHour(anchor, h, 10))
      )
    );

    const uv = uvItemsOf(p);
    expect(uv).toHaveLength(1);
    expect(uv[0].detail).not.toContain("sun sensitivity");
  });
});

describe("standalone photosensitizer note (#1727 composition 2)", () => {
  it("appears on a high-UV day with no overexposure signal", async () => {
    // No outdoor activity logged, so there is no DOSE to warn about — but the sun is
    // strong and the med is active, which is worth knowing before going out.
    const p = newProfile("wm-photo-standalone");
    addItem(p, "Doxycycline", "medication");
    const anchor = today(p);
    await runWeatherSync(
      p,
      source(trailing(anchor, 1, () => ({ uvIndexMax: 9, tempMaxC: 22 })))
    );

    const items = weatherMedItemsOf(p);
    expect(items).toHaveLength(1);
    expect(items[0].title).toContain("Doxycycline");
    expect(items[0].key.startsWith(WEATHER_MED_PREFIX)).toBe(true);
    expect(items[0].band).toBe("today");
  });

  it("stays silent on a low-UV day", async () => {
    const p = newProfile("wm-photo-lowuv");
    addItem(p, "Doxycycline", "medication");
    const anchor = today(p);
    await runWeatherSync(
      p,
      source(trailing(anchor, 1, () => ({ uvIndexMax: 2, tempMaxC: 14 })))
    );
    expect(weatherMedItemsOf(p)).toHaveLength(0);
  });

  it("stays silent with no cached weather at all (silence over guessing)", () => {
    const p = newProfile("wm-photo-nodata");
    addItem(p, "Doxycycline", "medication");
    expect(weatherMedItemsOf(p)).toHaveLength(0);
  });

  it("is dismissible — the shared bus silences that day's note", async () => {
    const p = newProfile("wm-photo-dismiss");
    addItem(p, "Doxycycline", "medication");
    const anchor = today(p);
    await runWeatherSync(
      p,
      source(trailing(anchor, 1, () => ({ uvIndexMax: 9, tempMaxC: 22 })))
    );
    const [item] = weatherMedItemsOf(p);
    db.prepare(
      `INSERT INTO upcoming_dismissals (profile_id, signal_key, dismissed_at)
       VALUES (?, ?, datetime('now'))`
    ).run(p, item.key);
    expect(weatherMedItemsOf(p)).toHaveLength(0);
  });
});

describe("heat-risk note (#1727 composition 3)", () => {
  it("requires BOTH the heatwave and a matching item", async () => {
    const p = newProfile("wm-heat-both");
    addItem(p, "Furosemide", "medication");
    const anchor = today(p);
    // Four consecutive hot days — a real heatwave under the #1726 predicate.
    await runWeatherSync(
      p,
      source(trailing(anchor, 4, () => ({ tempMaxC: 35 })))
    );

    const items = weatherMedItemsOf(p);
    expect(items).toHaveLength(1);
    expect(items[0].title).toContain("Furosemide");
    // collectUpcoming's canonical display units are Fahrenheit, and the figure follows
    // the login's scale rather than the storage one.
    expect(items[0].detail).toContain("95°F");

    const celsius = collectUpcoming(p, anchor, {
      temperatureUnit: "C",
      distanceUnit: "km",
    }).filter((i) => i.domain === "weather-med");
    expect(celsius[0].detail).toContain("35°C");
  });

  it("says nothing on a merely warm day, however many diuretics are in the stack", async () => {
    const p = newProfile("wm-heat-warm");
    addItem(p, "Furosemide", "medication");
    addItem(p, "Hydrochlorothiazide", "medication");
    const anchor = today(p);
    await runWeatherSync(
      p,
      source(trailing(anchor, 4, () => ({ tempMaxC: 27 })))
    );
    expect(weatherMedItemsOf(p)).toHaveLength(0);
  });

  it("says nothing during a heatwave with no heat-risk item", async () => {
    const p = newProfile("wm-heat-noitem");
    addItem(p, "Vitamin D3", "supplement");
    const anchor = today(p);
    await runWeatherSync(
      p,
      source(trailing(anchor, 4, () => ({ tempMaxC: 35 })))
    );
    expect(weatherMedItemsOf(p)).toHaveLength(0);
  });

  it("is NOT gated by weather-situation relevance — safety has its own gate", async () => {
    // The relevance gate keeps five context rows out of the life of someone with no
    // reason to care. A care-tier safety note must not be silenced by that unrelated
    // fact: taking the medication IS the reason to care.
    const p = newProfile("wm-heat-ungated");
    addItem(p, "Metoprolol", "medication");
    const anchor = today(p);
    await runWeatherSync(
      p,
      source(trailing(anchor, 4, () => ({ tempMaxC: 36 })))
    );
    // Nothing is keyed to a weather situation and no related symptom is logged, so the
    // SITUATION side is dormant — yet the safety note still speaks.
    expect(weatherMedItemsOf(p)).toHaveLength(1);
  });
});
