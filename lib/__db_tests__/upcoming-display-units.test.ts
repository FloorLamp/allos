// DB INTEGRATION TIER — display units on Upcoming item strings (#1019). Drives
// the REAL generator fan-out (collectUpcoming) with and without the viewer's
// login unit prefs and pins the display-unit policy end-to-end:
//   • the temperature red-flag item renders °C for a °C-pref viewer and canonical
//     °F for a login-less caller — with the IDENTICAL suppression key either way;
//   • the endurance event item formats its distance per the distanceUnit pref
//     (mi vs canonical km) — with the identical `endurance-event:<id>` key.
// Identity being display-independent is what keeps the shared dismissal bus and
// the calendar feed unaffected by a pref flip.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { collectUpcoming } from "@/lib/queries";
import { TEMP_RED_FLAG_PREFIX } from "@/lib/temp-red-flag";
import { shiftDateStr } from "@/lib/date";

let profile: number;
let planId: number;

const items = (units?: {
  temperatureUnit: "F" | "C";
  distanceUnit: "km" | "mi";
}) => collectUpcoming(profile, today(profile), units);

beforeAll(() => {
  profile = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('DISPLAY-UNITS')").run()
      .lastInsertRowid
  );
  const on = today(profile);

  // Open illness episode + a crossing (hyperpyrexia) reading today → the temp
  // red-flag generator emits its care-tier item.
  db.prepare(
    `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
     VALUES (?, 'Illness', ?, NULL)`
  ).run(profile, shiftDateStr(on, -1));
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, unit,
        canonical_name, source)
     VALUES (?, ?, 'vitals', 'Body Temperature', '104.5', 104.5, 'degF',
             'Body Temperature', 'manual')`
  ).run(profile, on);

  // An active endurance plan with a future event → the event item.
  planId = Number(
    db
      .prepare(
        `INSERT INTO endurance_plans
           (profile_id, event_name, discipline, event_date, target_distance_km)
         VALUES (?, NULL, 'run', ?, 10)`
      )
      .run(profile, shiftDateStr(on, 60)).lastInsertRowid
  );
});

describe("temperature red-flag item display units (#1019)", () => {
  const redFlagItem = (units?: Parameters<typeof items>[0]) =>
    items(units).find((i) => i.key.startsWith(TEMP_RED_FLAG_PREFIX));

  it("renders the viewer's °C pref on the web boundary", () => {
    const item = redFlagItem({ temperatureUnit: "C", distanceUnit: "km" })!;
    expect(item.title).toContain("40.3 °C");
    expect(item.title).not.toContain("104.5 °F");
  });

  it("defaults to canonical °F for login-less callers", () => {
    const item = redFlagItem()!;
    expect(item.title).toContain("104.5 °F");
  });

  it("keeps the suppression key identical across display units", () => {
    const c = redFlagItem({ temperatureUnit: "C", distanceUnit: "km" })!;
    const f = redFlagItem()!;
    expect(c.key).toBe(f.key);
  });
});

describe("endurance event item distance unit (#1019)", () => {
  const eventItem = (units?: Parameters<typeof items>[0]) =>
    items(units).find((i) => i.key === `endurance-event:${planId}`);

  it("formats the distance per the viewer's mi pref", () => {
    const item = eventItem({ temperatureUnit: "F", distanceUnit: "mi" })!;
    expect(item.detail).toBe("Run · 6.21 mi");
    expect(item.title).toContain("6.21 mi Run");
  });

  it("defaults to canonical km, same key either way", () => {
    const km = eventItem()!;
    expect(km.detail).toBe("Run · 10 km");
    const mi = eventItem({ temperatureUnit: "F", distanceUnit: "mi" })!;
    expect(mi.key).toBe(km.key);
  });
});
