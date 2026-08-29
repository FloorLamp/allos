// DB INTEGRATION TIER — the offline-replay half of #1851, and the sleep-source
// election it walked into.
//
// The measurements form learned to state a bed/wake WINDOW, which made a manual
// `sleep_min` row look, for the first time, like a session: `ended_at >
// started_at`. Two things follow that only this tier can see.
//
//   1. THE ELECTION. `readSleepSessions` picks ONE source per profile and filters
//      every row to it, and manual rows had never been eligible because the
//      windowless ones fail its `ended_at > started_at` filter. One typed night
//      re-elected the whole profile: 30 Oura overnights plus one replayed window
//      returned ONE session, and the SRI went to null. The device history
//      surviving a replayed manual night is the guard.
//   2. THE REPLAY. Three payload fields, three `applyIntent` branches and a
//      destructive DELETE ship on this path; nothing else in the change reaches
//      them.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { applyIntent, insertVitals } from "@/lib/offline/writes";
import { buildIntent, type VitalsPayload } from "@/lib/offline/queue";
import { getSleepRegularity, getSleepSessions } from "@/lib/queries";
import { getDailySleepSessionsSince } from "@/lib/queries/metrics";
import { shiftDateStr } from "@/lib/date";

function newProfile(name: string, tz = "UTC"): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  db.prepare(
    "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', ?)"
  ).run(id, tz);
  return id;
}

function setTimezone(profileId: number, tz: string): void {
  db.prepare(
    "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', ?) ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value"
  ).run(profileId, tz);
}

// A wearable's own night: a real window, filed on the wake day, like the Health
// Connect and Oura parsers write it.
function seedDeviceNight(
  profileId: number,
  source: string,
  wakeDay: string
): void {
  db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, started_at, ended_at, value)
     VALUES (?, ?, 'sleep_min', ?, ?, ?, 465)`
  ).run(
    profileId,
    source,
    wakeDay,
    `${shiftDateStr(wakeDay, -1)}T23:00:00Z`,
    `${wakeDay}T06:45:00Z`
  );
}

function sleepRows(profileId: number) {
  return db
    .prepare(
      `SELECT date, started_at, ended_at, value, source FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min' ORDER BY id`
    )
    .all(profileId) as {
    date: string;
    started_at: string;
    ended_at: string;
    value: number;
    source: string;
  }[];
}

const NIGHTS = Array.from({ length: 30 }, (_, i) =>
  shiftDateStr("2026-05-01", i)
);
const LAST = NIGHTS[NIGHTS.length - 1];

// The queue's payload carries every vitals field, so spell the unfilled ones
// rather than leaning on a cast: an intent this tier builds must be the shape the
// browser actually enqueues.
function vitalsPayload(fields: Partial<VitalsPayload>): VitalsPayload {
  return {
    systolic: null,
    diastolic: null,
    glucose: null,
    glucoseUnit: null,
    spo2: null,
    temperature: null,
    tempUnit: null,
    sleepHours: null,
    hrv: null,
    ...fields,
  };
}

function windowIntent(profileId: number, date: string) {
  return buildIntent(
    "vitals",
    date,
    vitalsPayload({ bedTime: "23:15", wakeTime: "07:05" }),
    profileId
  );
}

describe("a replayed manual window and the sleep-source election (#1851)", () => {
  it("leaves a wearable's history the elected stream", () => {
    const p = newProfile("sleep-election-two-source");
    for (const night of NIGHTS) seedDeviceNight(p, "oura", night);
    const before = getSleepRegularity(p);
    expect(getSleepSessions(p)).toHaveLength(30);
    expect(before?.nights).toBe(28);

    // The person types the last night as well — offline, so it arrives as a
    // replay. Its wake clock (07:05) is LATER than the ring's sleep offset
    // (06:45), which is the ordinary case and is exactly what used to win it the
    // election: people type when they got up.
    expect(applyIntent(p, windowIntent(p, LAST))).toEqual({ status: "done" });

    const after = getSleepSessions(p);
    expect(after).toHaveLength(30);
    expect(new Set(after.map((s) => s.source))).toEqual(new Set(["oura"]));
    expect(getSleepRegularity(p)?.nights).toBe(before?.nights);
    // THE CONVERSE, in the same test, because "the device history survives" is an
    // assertion about what is ABSENT and would pass just as well on a tree where
    // the typed night had been thrown away. It is written, and the Sleep log's own
    // reader — which resolves PER OVERLAPPING WINDOW rather than electing one
    // stream, and is untouched here — still shows the person their own night.
    expect(sleepRows(p).filter((r) => r.source === "manual")).toHaveLength(1);
    const logged = getDailySleepSessionsSince(p, LAST);
    expect(logged.map((r) => r.source)).toContain("manual");
  });

  it("still gives a profile with no device its own SRI from typed windows alone", () => {
    const p = newProfile("sleep-election-manual-only");
    for (const night of NIGHTS) {
      expect(applyIntent(p, windowIntent(p, night))).toEqual({
        status: "done",
      });
    }
    const sessions = getSleepSessions(p);
    expect(sessions).toHaveLength(30);
    expect(new Set(sessions.map((s) => s.source))).toEqual(new Set(["manual"]));
    // Identical clocks every night — a perfectly reproducible schedule.
    expect(getSleepRegularity(p)?.sri).toBe(100);
  });

  it("honours an explicit primary-source choice of Manual over the device", () => {
    const p = newProfile("sleep-election-chosen-manual");
    for (const night of NIGHTS) seedDeviceNight(p, "oura", night);
    for (const night of NIGHTS) applyIntent(p, windowIntent(p, night));
    db.prepare(
      "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'metric_source_priority', ?)"
    ).run(p, JSON.stringify({ sleep_min: "manual" }));

    const sessions = getSleepSessions(p);
    expect(new Set(sessions.map((s) => s.source))).toEqual(new Set(["manual"]));
  });
});

describe("applyIntent — the #1851 vitals payload fields", () => {
  it("replays a window, a counted rate and the sitting's date exactly once", () => {
    const p = newProfile("replay-1851-fields");
    const intent = buildIntent(
      "vitals",
      "2026-05-04",
      vitalsPayload({
        bedTime: "23:15",
        wakeTime: "07:05",
        respiratoryRate: "22",
      }),
      p
    );

    expect(applyIntent(p, intent)).toEqual({ status: "done" });
    expect(sleepRows(p)).toEqual([
      {
        date: "2026-05-04",
        started_at: "2026-05-03T23:15:00Z",
        ended_at: "2026-05-04T07:05:00Z",
        value: 470,
        source: "manual",
      },
    ]);
    const rate = db
      .prepare(
        "SELECT value_num, unit, source FROM medical_records WHERE profile_id = ? AND canonical_name = 'Respiratory Rate'"
      )
      .all(p) as { value_num: number; unit: string; source: string }[];
    expect(rate).toEqual([
      { value_num: 22, unit: "breaths/min", source: "manual" },
    ]);

    // A racing second flush of the SAME intent is a no-op on the key ledger, and
    // the destructive DELETE inside the sleep upsert does not run twice into an
    // empty day.
    expect(applyIntent(p, intent)).toEqual({ status: "duplicate" });
    expect(sleepRows(p)).toHaveLength(1);
  });

  it("converges on ONE row when a duration and a window replay in either order", () => {
    for (const [label, order] of [
      ["duration first", ["hours", "window"]],
      ["window first", ["window", "hours"]],
    ] as const) {
      const p = newProfile(`replay-1851-converge-${label}`);
      for (const step of order) {
        const payload = vitalsPayload(
          step === "hours"
            ? { sleepHours: "7" }
            : { bedTime: "22:30", wakeTime: "06:30" }
        );
        expect(
          applyIntent(p, buildIntent("vitals", "2026-05-04", payload, p))
        ).toEqual({ status: "done" });
      }
      const rows = sleepRows(p);
      expect(rows, label).toHaveLength(1);
      // Whichever arrived last, the WINDOW survives: a duration-only correction
      // states no clocks and must not discard the ones already on the row.
      expect(rows[0].started_at, label).toBe("2026-05-03T22:30:00Z");
      expect(rows[0].value, label).toBe(order[1] === "hours" ? 420 : 480);
    }
  });

  it("resolves the stated clocks in the profile's zone AT WRITE TIME", () => {
    const p = newProfile("replay-1851-zone", "Pacific/Auckland");
    const intent = windowIntent(p, "2026-05-04");
    // The person flies home before the queue flushes. The intent carries CLOCKS,
    // not instants — an offline device has no server to ask — so the zone that
    // interprets them is the one the profile holds when the write lands.
    setTimezone(p, "America/New_York");
    expect(applyIntent(p, intent)).toEqual({ status: "done" });
    expect(sleepRows(p)[0]).toMatchObject({
      started_at: "2026-05-04T03:15:00Z",
      ended_at: "2026-05-04T11:05:00Z",
    });
  });

  it("keeps an out-of-envelope window out of the store, and the reading in", () => {
    // Antarctica/Troll shifts TWO hours, which is what broke the old "23 h leaves
    // exactly the headroom" argument: on 2026-10-25 this pair's nominal 1380
    // minutes resolve to 1500 ELAPSED, outside `sleep_min`'s 0–1440 ingest
    // envelope. The window is refused; the night is still recorded, as the
    // duration the validator did bound. (Its March counterpart, 2026-03-29,
    // resolves to 1260 and is stored as a window — the check is on the value, not
    // on the calendar.)
    const p = newProfile("replay-1851-troll", "Antarctica/Troll");
    expect(
      insertVitals(
        p,
        "2026-10-25",
        { bedTime: "12:00", wakeTime: "11:00" },
        "page"
      ).wrote
    ).toBe(true);
    const rows = sleepRows(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(1380);
    expect(rows[0].started_at).toBe(rows[0].ended_at);
  });
});
