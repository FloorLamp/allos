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
import { DEFAULT_INTAKE_REMINDER_MINUTES } from "@/lib/notifications/schedule";
import { DIGEST_DEFAULT_MINUTE } from "@/lib/notifications/digest-schedule";

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
  // A 45-min afternoon nap on the latest wake-day, plus main-night stages. The
  // digest must keep the stages and ignore the later nap.
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

describe("getNotifySchedule — wake-seeded Morning time (#1117, minutes since #2121)", () => {
  it("seeds the Morning time from the typical wake minute when unset (auto)", () => {
    const sched = getNotifySchedule(wakeProfile);
    // Median wake 07:00 → 420 minutes, unrounded (the old wakeMinuteToHour
    // rounding is deleted at minute grain).
    expect(sched.supplementMinutes.Morning).toBe(7 * 60);
    expect(sched.morningAuto).toBe(true);
  });

  it("NEVER reseeds a stored manual Morning time (HH:MM or legacy integer)", () => {
    setProfileSetting(wakeProfile, "notify_supp_morning_hour", "09:15");
    let sched = getNotifySchedule(wakeProfile);
    expect(sched.supplementMinutes.Morning).toBe(9 * 60 + 15);
    expect(sched.morningAuto).toBe(false);
    // A pre-migration legacy integer hour still means HH:00 — no user's stored
    // reminder time may move through the format change (#2121 constraint).
    setProfileSetting(wakeProfile, "notify_supp_morning_hour", "9");
    sched = getNotifySchedule(wakeProfile);
    expect(sched.supplementMinutes.Morning).toBe(9 * 60);
    expect(sched.morningAuto).toBe(false);
    // restore auto for the other assertions
    setProfileSetting(wakeProfile, "notify_supp_morning_hour", "auto");
    expect(getNotifySchedule(wakeProfile).supplementMinutes.Morning).toBe(
      7 * 60
    );
    expect(getNotifySchedule(wakeProfile).morningAuto).toBe(true);
  });

  it("falls back to the hardcoded default without sleep data", () => {
    const sched = getNotifySchedule(emptyProfile);
    expect(sched.supplementMinutes.Morning).toBe(
      DEFAULT_INTAKE_REMINDER_MINUTES.Morning
    );
    expect(sched.morningAuto).toBe(true); // absent = auto, just no data to resolve
  });

  it("keeps the digest OFF when absent, and never reads the wake time for it", () => {
    // #2211 removed `auto` from the digest entirely: it has a mode and a concrete
    // time, and the wake minute is the MORNING INTAKE slot's answer alone. A
    // residual sentinel (an old tab posting during a deploy overlap) reads as the
    // declared pre-fill rather than as off — never as the wake time.
    expect(getNotifySchedule(wakeProfile).digestMinute).toBeNull(); // opt-in
    expect(getNotifySchedule(wakeProfile).digestMode).toBe("static");
    setProfileSetting(wakeProfile, "notify_digest_hour", "auto");
    expect(getNotifySchedule(wakeProfile).digestMinute).toBe(
      DIGEST_DEFAULT_MINUTE
    );
    setProfileSetting(wakeProfile, "notify_digest_hour", ""); // reset off
  });
});

describe("setNotifySchedule — no blind-write pollution (#1117)", () => {
  it("persists the 'auto' sentinel, not the resolved time, on an unchanged re-save", () => {
    // Read the resolved schedule (Morning auto → 07:00) and write it straight back.
    const sched = getNotifySchedule(wakeProfile);
    expect(sched.morningAuto).toBe(true);
    expect(sched.supplementMinutes.Morning).toBe(7 * 60);
    setNotifySchedule(wakeProfile, sched);
    // The stored value must be the sentinel, so the next read still resolves live.
    expect(getProfileSetting(wakeProfile, "notify_supp_morning_hour")).toBe(
      "auto"
    );
    expect(getNotifySchedule(wakeProfile).morningAuto).toBe(true);
  });

  it("persists a manual pick as HH:MM", () => {
    const sched = getNotifySchedule(wakeProfile);
    setNotifySchedule(wakeProfile, {
      ...sched,
      morningAuto: false,
      supplementMinutes: { ...sched.supplementMinutes, Morning: 10 * 60 + 30 },
    });
    expect(getProfileSetting(wakeProfile, "notify_supp_morning_hour")).toBe(
      "10:30"
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

  it("returns the as-of-wake main-session figures, stages, and SRI when opted in", () => {
    setProfileSleepDigest(wakeProfile, true);
    const s = gatherDigestSleep(wakeProfile);
    expect(s).not.toBeNull();
    // The source reports 7h asleep inside the 8h bedtime window; duration-facing
    // summaries use that reported value while timing still uses 23:00→07:00.
    expect(s!.lastNightMin).toBe(420);
    expect(s!.baselineMin).toBe(420);
    expect(s!.deepMin).toBe(65);
    expect(s!.remMin).toBe(95);
    expect(typeof s!.sri).toBe("number"); // 16 consecutive nights → SRI present
    setProfileSleepDigest(wakeProfile, false);
  });

  it("an afternoon nap cannot change the morning digest Sleep model", () => {
    const id = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('DigestNapFreeze')").run()
        .lastInsertRowid
    );
    setTimezone(id, "UTC");
    const td = today(id);
    upsertMetricSamples(
      id,
      [
        ...nights(td, 16, "07:00"),
        session(
          "sleep_deep_min",
          td,
          65,
          `${shiftDateStr(td, -1)}T23:00:00Z`,
          `${td}T07:00:00Z`
        ),
        session(
          "sleep_rem_min",
          td,
          95,
          `${shiftDateStr(td, -1)}T23:00:00Z`,
          `${td}T07:00:00Z`
        ),
      ],
      "health-connect"
    );
    setProfileSleepDigest(id, true);
    const morning = gatherDigestSleep(id);
    expect(morning).not.toBeNull();

    upsertMetricSamples(
      id,
      [
        session("sleep_min", td, 45, `${td}T13:00:00Z`, `${td}T13:45:00Z`),
        session(
          "sleep_light_min",
          td,
          45,
          `${td}T13:00:00Z`,
          `${td}T13:45:00Z`
        ),
      ],
      "health-connect"
    );

    // Prose reconciliation may notice the ledger write, but rebuilding yields the
    // identical body model, so Telegram performs no edit.
    expect(gatherDigestSleep(id)).toEqual(morning);
  });

  it("returns null when the newest night is stale (not last night)", () => {
    setProfileSleepDigest(staleProfile, true);
    expect(gatherDigestSleep(staleProfile)).toBeNull();
    setProfileSleepDigest(staleProfile, false);
  });

  // The gate once accepted yesterday's wake-day too — which is the night BEFORE
  // last night, and precisely what a morning digest sees before the tracker has
  // pushed. Printing it under "how'd I sleep" reports the wrong night.
  it("returns null when the newest night is the night before last", () => {
    const lagged = Number(
      db
        .prepare("INSERT INTO profiles (name) VALUES ('LaggedSleepDigest')")
        .run().lastInsertRowid
    );
    setTimezone(lagged, "UTC");
    upsertMetricSamples(
      lagged,
      nights(shiftDateStr(today(lagged), -1), 16, "07:00"),
      "health-connect"
    );
    setProfileSleepDigest(lagged, true);
    expect(gatherDigestSleep(lagged)).toBeNull();
  });

  it("returns null with no sleep data even when opted in", () => {
    setProfileSleepDigest(emptyProfile, true);
    expect(gatherDigestSleep(emptyProfile)).toBeNull();
    setProfileSleepDigest(emptyProfile, false);
  });
});
