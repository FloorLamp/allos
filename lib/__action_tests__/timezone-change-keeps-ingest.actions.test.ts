// SERVER-ACTION TIER — a profile timezone change DELETES NOTHING (#3524).
//
// This file used to assert the opposite, and the assertion it made is the bug. Until
// this change, `saveProfileSettings`, the travel one-tap accept and onboarding all ran
// `sweepIngestWindowForTimezoneChange`, which deleted every non-edit-locked Health
// Connect `body_metrics` row from `today − 3` forward on the argument that "the next
// push repopulates them cleanly under the new keys". The exporter re-sends one day, not
// three, so four days of a production profile's resting HR were destroyed across two
// travel switches — the reason #3524 is a P1.
//
// The re-key the sweep existed to prevent (#608) is real and is still handled; it moved
// to where the evidence for it is. On the next Health Connect push, each incoming reading
// carries its instant, and the row that instant was filed under in a zone the profile has
// left is the one that gets deleted — nothing else. That is pinned in
// lib/__db_tests__/hc-timezone-rekey-reconcile.test.ts; what belongs HERE is the action's
// own half: driving the real Server Actions and showing that a zone change on its own
// touches no row of anybody's.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { getTimezone, setTimezone } from "@/lib/settings";
import { saveProfileSettings } from "@/app/(app)/settings/profile/actions";
import { acceptTravelTimezone } from "@/app/(app)/travel-actions";
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
function bodyMetricDates(profileId: number, source: string | null): string[] {
  return (
    db
      .prepare(
        "SELECT date FROM body_metrics WHERE profile_id = ? AND source IS ? ORDER BY date"
      )
      .all(profileId, source) as { date: string }[]
  ).map((r) => r.date);
}

describe("a timezone change deletes no ingest rows (#3524)", () => {
  it("saveProfileSettings moves the zone and keeps every body_metrics row", async () => {
    const admin = createLogin({ role: "admin" });
    const profile = createProfile("Test Patient");
    actAs(admin, profile);
    setTimezone(profile.id, "America/New_York");

    const anchor = today(profile.id);
    // The exact window the sweep used to destroy: today and the three days behind it.
    const window = [3, 2, 1, 0].map((n) => shiftDateStr(anchor, -n));
    for (const d of window) addBodyMetric(profile.id, d, "health-connect", 80);
    addBodyMetric(profile.id, shiftDateStr(anchor, -10), "health-connect", 82);
    addBodyMetric(profile.id, window[1], null, 83); // manual
    addBodyMetric(profile.id, window[1], "withings", 84);

    await saveProfileSettings(fd({ timezone: "Asia/Tokyo" }));
    expect(getTimezone(profile.id)).toBe("Asia/Tokyo");

    expect(bodyMetricDates(profile.id, "health-connect")).toEqual(
      [...window, shiftDateStr(anchor, -10)].sort()
    );
    expect(bodyMetricDates(profile.id, null)).toEqual([window[1]]);
    expect(bodyMetricDates(profile.id, "withings")).toEqual([window[1]]);
  });

  it("the travel one-tap accept keeps them too", async () => {
    const login = createLogin();
    const profile = createProfile("Traveller", login.id);
    db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
      profile.id,
      login.id
    );
    actAs(login, profile);
    setTimezone(profile.id, "America/New_York");

    const anchor = today(profile.id);
    const window = [3, 2, 1, 0].map((n) => shiftDateStr(anchor, -n));
    for (const d of window) addBodyMetric(profile.id, d, "health-connect", 80);

    const result = await acceptTravelTimezone("Pacific/Honolulu");
    expect(result.ok).toBe(true);
    expect(getTimezone(profile.id)).toBe("Pacific/Honolulu");
    expect(bodyMetricDates(profile.id, "health-connect")).toEqual(window);
  });

  it("does nothing when the timezone is unchanged", async () => {
    const admin = createLogin({ role: "admin" });
    const profile = createProfile("Ada Lovelace");
    actAs(admin, profile);
    setTimezone(profile.id, "America/New_York");
    const recent = shiftDateStr(today(profile.id), -1);
    addBodyMetric(profile.id, recent, "health-connect", 80);

    await saveProfileSettings(fd({ timezone: "America/New_York" }));
    expect(bodyMetricDates(profile.id, "health-connect")).toEqual([recent]);
  });
});
