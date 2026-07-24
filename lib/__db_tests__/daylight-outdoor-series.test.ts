// DB INTEGRATION TIER — the daylight-outdoor-minutes TREND series (issue #1171).
// The Trends "Sun / outdoor time" chart is a pure FORMATTER over the SAME
// getDaylightOutdoorMinutesByDay computation the DaylightChip and the coaching
// average read (#221 — one question, one computation). This fixture pins that
// equivalence end-to-end: over one seeded profile, the chart series, the per-day
// chip map, and the window total agree; and it's empty without a home location.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  getDaylightOutdoorMinutesByDay,
  getDaylightOutdoorMinutesTotal,
  getDaylightOutdoorMinutesSeries,
} from "@/lib/queries";
import { setHomeLocation } from "@/lib/settings";
import { lastNDates } from "@/lib/date";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// A midday outdoor session (avg_temp_c present = the persisted outdoor signal).
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

describe("getDaylightOutdoorMinutesSeries (#1171)", () => {
  it("is a formatter that agrees with the chip map and the window total", () => {
    const p = newProfile("sun-series");
    const anchor = today(p);
    setHomeLocation(p, { lat: 40.7, lng: -74 });
    const dates = lastNDates(anchor, 30);
    // Outdoor walks on three distinct days across the window; other days have none.
    const d1 = dates[dates.length - 1]; // today
    const d2 = dates[dates.length - 5];
    const d3 = dates[dates.length - 12];
    seedOutdoorActivity(p, d1, "10:00", "11:00");
    seedOutdoorActivity(p, d2, "13:00", "13:30");
    seedOutdoorActivity(p, d3, "09:00", "10:30");

    const byDay = getDaylightOutdoorMinutesByDay(p, dates); // the chip source
    const series = getDaylightOutdoorMinutesSeries(p, dates); // the chart source
    const total = getDaylightOutdoorMinutesTotal(p, dates); // the average source

    // Three days logged minutes; the chart is exactly the chip map, sorted.
    expect(series.length).toBe(byDay.size);
    expect(series.length).toBe(3);
    for (const point of series) {
      expect(point.value).toBe(byDay.get(point.date));
      expect(point.value).toBeGreaterThan(0);
    }
    // Ascending by date.
    const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date));
    expect(series.map((s) => s.date)).toEqual(sorted.map((s) => s.date));
    // The chart's summed minutes equal the window total the coaching average uses.
    expect(series.reduce((s, p) => s + p.value, 0)).toBe(total);
  });

  it("is empty when the profile has no home location (sun features off)", () => {
    const p = newProfile("sun-series-nohome");
    const anchor = today(p);
    const dates = lastNDates(anchor, 30);
    seedOutdoorActivity(p, dates[dates.length - 1], "10:00", "11:00");
    expect(getDaylightOutdoorMinutesSeries(p, dates)).toEqual([]);
  });
});
