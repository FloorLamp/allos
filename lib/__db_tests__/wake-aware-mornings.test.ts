// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issue #1117 — wake-aware mornings. Pins the read-resolution end to end against a
// real seeded fixture: (1) getNotifySchedule seeds the Morning hour from the
// profile's typical wake time when it's auto/absent, NEVER overwrites a stored
// manual hour, and falls to the hardcoded default without sleep data; (2)
// setNotifySchedule persists the "auto" sentinel (no blind-write pollution); (3)
// gatherDigestSleep composes the same main-session + SRI figures the rest trigger
// and Trends use, gated on the opt-in and on freshness.
//
// Runs via `npm run test:db` (vitest.db.config.ts). The `db` singleton is pointed
// at a throwaway per-file temp DB by lib/__db_tests__/setup.ts.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  upsertMetricSamples,
  type NormMetricSample,
} from "@/lib/integrations/normalize";
import {
  getNotifySchedule,
  setNotifySchedule,
  setTimezone,
  getProfileSetting,
  setProfileSetting,
  setProfileSleepDigest,
} from "@/lib/settings";
import { gatherDigestSleep } from "@/lib/notifications/digest-data";
import { DEFAULT_INTAKE_REMINDER_HOURS } from "@/lib/notifications/schedule";

const session = (
  metric: string,
  date: string,
  value: number,
  start: string,
  end: string
): NormMetricSample => ({
  metric,
  date,
  start_time: start,
  end_time: end,
  value,
});

// Build N consecutive overnight sessions in UTC (wall clock = stored instant),
// the newest waking on `newestWakeDay`, each waking at `wakeHhmm`.
function nights(
  newestWakeDay: string,
  n: number,
  wakeHhmm: string
): NormMetricSample[] {
  const out: NormMetricSample[] = [];
  for (let i = 0; i < n; i++) {
    const wakeDay = shiftDateStr(newestWakeDay, -i);
    const bedDay = shiftDateStr(wakeDay, -1);
    out.push(
      session(
        "sleep_min",
        wakeDay,
        7 * 60,
        `${bedDay}T23:00:00Z`,
        `${wakeDay}T${wakeHhmm}:00Z`
      )
    );
  }
  return out;
}

let wakeProfile: number; // 16 nights waking 07:00, ending today
let emptyProfile: number; // no sleep data at all
let staleProfile: number; // sleep data, but the newest night is weeks old

beforeAll(() => {
  const mk = (name: string) =>
    Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
        .lastInsertRowid
    );

  wakeProfile = mk("Wake1117");
  setTimezone(wakeProfile, "UTC");
  const td = today(wakeProfile); // profile-local (UTC) date, for the freshness gate
  upsertMetricSamples(wakeProfile, nights(td, 16, "07:00"), "health-connect");
  // A 45-min afternoon nap the latest wake-day + a stage breakdown for it.
  upsertMetricSamples(
    wakeProfile,
    [
      session("sleep_min", td, 45, `${td}T13:00:00Z`, `${td}T13:45:00Z`),
      session("sleep_deep_min", td, 65, `${td}T00:00:00Z`, `${td}T01:05:00Z`),
      session("sleep_rem_min", td, 95, `${td}T01:05:00Z`, `${td}T02:40:00Z`),
    ],
    "health-connect"
  );

  emptyProfile = mk("Empty1117");
  setTimezone(emptyProfile, "UTC");

  staleProfile = mk("Stale1117");
  setTimezone(staleProfile, "UTC");
  upsertMetricSamples(
    staleProfile,
    nights(shiftDateStr(td, -40), 16, "07:00"),
    "health-connect"
  );
});

describe("getNotifySchedule — wake-seeded Morning hour (#1117)", () => {
  it("seeds the Morning hour from the typical wake time when unset (auto)", () => {
    const sched = getNotifySchedule(wakeProfile);
    expect(sched.supplementHours.Morning).toBe(7); // median wake 07:00 → hour 7
    expect(sched.morningAuto).toBe(true);
  });

  it("NEVER reseeds a stored manual Morning hour", () => {
    setProfileSetting(wakeProfile, "notify_supp_morning_hour", "9");
    const sched = getNotifySchedule(wakeProfile);
    expect(sched.supplementHours.Morning).toBe(9);
    expect(sched.morningAuto).toBe(false);
    // restore auto for the other assertions
    setProfileSetting(wakeProfile, "notify_supp_morning_hour", "auto");
    expect(getNotifySchedule(wakeProfile).supplementHours.Morning).toBe(7);
    expect(getNotifySchedule(wakeProfile).morningAuto).toBe(true);
  });

  it("falls back to the hardcoded default without sleep data", () => {
    const sched = getNotifySchedule(emptyProfile);
    expect(sched.supplementHours.Morning).toBe(
      DEFAULT_INTAKE_REMINDER_HOURS.Morning
    );
    expect(sched.morningAuto).toBe(true); // absent = auto, just no data to resolve
  });

  it("keeps the digest OFF when absent, but resolves an explicit auto to wake", () => {
    expect(getNotifySchedule(wakeProfile).digestHour).toBeNull(); // opt-in
    expect(getNotifySchedule(wakeProfile).digestAuto).toBe(false);
    setProfileSetting(wakeProfile, "notify_digest_hour", "auto");
    const sched = getNotifySchedule(wakeProfile);
    expect(sched.digestHour).toBe(7);
    expect(sched.digestAuto).toBe(true);
    setProfileSetting(wakeProfile, "notify_digest_hour", ""); // reset off
  });
});

describe("setNotifySchedule — no blind-write pollution (#1117)", () => {
  it("persists the 'auto' sentinel, not the resolved hour, on an unchanged re-save", () => {
    // Read the resolved schedule (Morning auto → 7) and write it straight back.
    const sched = getNotifySchedule(wakeProfile);
    expect(sched.morningAuto).toBe(true);
    expect(sched.supplementHours.Morning).toBe(7);
    setNotifySchedule(wakeProfile, sched);
    // The stored value must be the sentinel, so the next read still resolves live.
    expect(getProfileSetting(wakeProfile, "notify_supp_morning_hour")).toBe(
      "auto"
    );
    expect(getNotifySchedule(wakeProfile).morningAuto).toBe(true);
  });

  it("persists a manual pick as a number", () => {
    const sched = getNotifySchedule(wakeProfile);
    setNotifySchedule(wakeProfile, {
      ...sched,
      morningAuto: false,
      supplementHours: { ...sched.supplementHours, Morning: 10 },
    });
    expect(getProfileSetting(wakeProfile, "notify_supp_morning_hour")).toBe(
      "10"
    );
    // restore auto
    setProfileSetting(wakeProfile, "notify_supp_morning_hour", "auto");
  });
});

describe("gatherDigestSleep — default-on + freshness (#1117/#1378)", () => {
  it("is ON by default (#1378) with fresh data; an explicit '0' opts out", () => {
    // #1378: absent key means on — a digest user with a fresh main night gets the
    // section without a second opt-in (wakeProfile has fresh sleep data).
    expect(gatherDigestSleep(wakeProfile)).not.toBeNull();
    // Explicit opt-out ("0") still silences it.
    setProfileSleepDigest(wakeProfile, false);
    expect(gatherDigestSleep(wakeProfile)).toBeNull();
  });

  it("returns the main-session figures, nap, stages, and SRI when opted in", () => {
    setProfileSleepDigest(wakeProfile, true);
    const s = gatherDigestSleep(wakeProfile);
    expect(s).not.toBeNull();
    // The source reports 7h asleep inside the 8h bedtime window; duration-facing
    // summaries use that reported value while timing still uses 23:00→07:00.
    expect(s!.lastNightMin).toBe(420);
    expect(s!.baselineMin).toBe(420);
    expect(s!.napMin).toBe(45); // the afternoon nap, on its own
    expect(s!.deepMin).toBe(65);
    expect(s!.remMin).toBe(95);
    expect(typeof s!.sri).toBe("number"); // 16 consecutive nights → SRI present
    setProfileSleepDigest(wakeProfile, false);
  });

  it("returns null when the newest night is stale (not today/yesterday)", () => {
    setProfileSleepDigest(staleProfile, true);
    expect(gatherDigestSleep(staleProfile)).toBeNull();
    setProfileSleepDigest(staleProfile, false);
  });

  it("returns null with no sleep data even when opted in", () => {
    setProfileSleepDigest(emptyProfile, true);
    expect(gatherDigestSleep(emptyProfile)).toBeNull();
    setProfileSleepDigest(emptyProfile, false);
  });
});
