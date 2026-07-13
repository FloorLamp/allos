// SERVER-ACTION TIER — a profile timezone change sweeps the rolling-window ingest
// rows that key on profile-LOCAL time at ingest (#608).
//
// hr_minutes.ts and Health Connect body_metrics.date are computed in the profile's
// timezone at ingest and never re-keyed, so a timezone change would make the next
// rolling-window push INSERT ~48h of duplicates under the shifted keys. saveProfile
// Settings now sweeps the current window's push-sourced rows on a tz change so the
// re-push repopulates cleanly. This drives the real action and asserts exactly which
// rows are swept (and which are preserved: manual rows, edit-locked rows, old rows).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { getTimezone, setTimezone } from "@/lib/settings";
import { saveProfileSettings } from "@/app/(app)/settings/profile/actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

function addBodyMetric(
  profileId: number,
  date: string,
  source: string | null,
  weight: number,
  edited = 0
) {
  db.prepare(
    "INSERT INTO body_metrics (profile_id, date, weight_kg, source, edited) VALUES (?, ?, ?, ?, ?)"
  ).run(profileId, date, weight, source, edited);
}
function addHrMinute(profileId: number, ts: string, source: string) {
  db.prepare(
    "INSERT INTO hr_minutes (profile_id, ts, bpm, n, source) VALUES (?, ?, 70, 6, ?)"
  ).run(profileId, ts, source);
}
function bodyMetricDates(profileId: number, source: string | null): string[] {
  return (
    db
      .prepare(
        "SELECT date FROM body_metrics WHERE profile_id = ? AND source IS ? ORDER BY date"
      )
      .all(profileId, source) as { date: string }[]
  ).map((r) => r.date);
}
function hrMinuteTimestamps(profileId: number): string[] {
  return (
    db
      .prepare("SELECT ts FROM hr_minutes WHERE profile_id = ? ORDER BY ts")
      .all(profileId) as { ts: string }[]
  ).map((r) => r.ts);
}

describe("saveProfileSettings sweeps ingest rows on a timezone change (#608)", () => {
  it("deletes the current window's push-sourced HC rows, keeps manual/edit-locked/old", async () => {
    const admin = createLogin({ role: "admin" });
    const profile = createProfile("Test Patient");
    actAs(admin, profile);
    setTimezone(profile.id, "America/New_York");

    const anchor = today(profile.id);
    const recent = shiftDateStr(anchor, -1); // in the ~3-day window
    const old = shiftDateStr(anchor, -10); // outside the window

    // Health Connect rows in the window (swept) + an edit-locked one (kept) + an old
    // one (kept) + a manual (source NULL) row in the window (kept).
    addBodyMetric(profile.id, recent, "health-connect", 80);
    addBodyMetric(profile.id, anchor, "health-connect", 81, /* edited */ 1);
    addBodyMetric(profile.id, old, "health-connect", 82);
    addBodyMetric(profile.id, recent, null, 83); // manual
    // Withings keys on the device zone, not the profile zone → must NOT be swept.
    addBodyMetric(profile.id, recent, "withings", 84);

    addHrMinute(profile.id, `${recent}T08:00`, "health-connect");
    addHrMinute(profile.id, `${old}T08:00`, "health-connect");

    // Change the timezone via the real action.
    await saveProfileSettings(fd({ timezone: "Asia/Tokyo" }));
    expect(getTimezone(profile.id)).toBe("Asia/Tokyo");

    // HC body_metrics in the window swept — except the edit-locked one.
    expect(bodyMetricDates(profile.id, "health-connect")).toEqual(
      [anchor, old].sort()
    );
    // Manual + Withings rows untouched.
    expect(bodyMetricDates(profile.id, null)).toEqual([recent]);
    expect(bodyMetricDates(profile.id, "withings")).toEqual([recent]);
    // Recent HC hr_minute swept, old one kept.
    expect(hrMinuteTimestamps(profile.id)).toEqual([`${old}T08:00`]);
  });

  it("does nothing when the timezone is unchanged", async () => {
    const admin = createLogin({ role: "admin" });
    const profile = createProfile("Ada Lovelace");
    actAs(admin, profile);
    setTimezone(profile.id, "America/New_York");
    const recent = shiftDateStr(today(profile.id), -1);
    addBodyMetric(profile.id, recent, "health-connect", 80);

    // Same timezone → no sweep.
    await saveProfileSettings(fd({ timezone: "America/New_York" }));
    expect(bodyMetricDates(profile.id, "health-connect")).toEqual([recent]);
  });
});
