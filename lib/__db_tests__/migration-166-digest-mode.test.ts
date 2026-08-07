// DB INTEGRATION TIER — migration 166 (#2211): the morning digest gets a MODE, and
// the `auto` sentinel leaves `notify_digest_hour`.
//
// THE CONSTRAINT UNDER TEST is the issue's own: the mode is NEW, so no user's digest
// may move without a tap and none may turn ON. Four properties pin it:
//   1. A stored "HH:MM" becomes Static at exactly that minute, byte-for-byte.
//   2. A stored "auto" resolves ONCE, here, to a concrete "HH:MM" — the arrival p90
//      plus one, the live resolution's own rule — and becomes Static at it.
//   3. "" stays off and gets NO mode row; an ABSENT key stays absent, so a profile
//      that never had a digest does not acquire one (or a mode).
//   4. Replay is a no-op: the converted "HH:MM" never matches `auto` again, and the
//      mode write is an idempotent upsert.
//
// The migration is driven directly (up() on the already-migrated test DB): its only
// effect is a data UPDATE/INSERT over profile_settings, so the direct call is the
// same statement the runner would execute inside its transaction. Synthetic data
// only; no PHI.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { up } from "@/lib/migrations/versions/166-digest-mode";
import {
  getNotifySchedule,
  setProfileSetting,
  setTimezone,
} from "@/lib/settings";
import { DIGEST_MODE_KEY } from "@/lib/settings/notifications";
import { DIGEST_DEFAULT_MINUTE } from "@/lib/notifications/digest-schedule";
import { utcInstant, zonedWallTimeToUtc } from "@/lib/date";

const TZ = "UTC";
const PROVIDER = "health-connect";
// The #2214 fixture's arrival clock times; its p90 is 07:40, so `auto` resolved to
// 07:41 — the first minute strictly after the arrivals.
const ARRIVALS = [
  { date: "2026-07-24", arrival: 6 * 60 + 2 },
  { date: "2026-07-25", arrival: 6 * 60 + 6 },
  { date: "2026-07-26", arrival: 6 * 60 + 14 },
  { date: "2026-07-27", arrival: 6 * 60 + 26 },
  { date: "2026-07-28", arrival: 6 * 60 + 47 },
  { date: "2026-07-29", arrival: 6 * 60 + 50 },
  { date: "2026-07-30", arrival: 7 * 60 + 4 },
  { date: "2026-07-31", arrival: 7 * 60 + 11 },
  { date: "2026-08-01", arrival: 7 * 60 + 26 },
  { date: "2026-08-02", arrival: 7 * 60 + 26 },
  { date: "2026-08-03", arrival: 7 * 60 + 30 },
  { date: "2026-08-04", arrival: 7 * 60 + 42 },
  { date: "2026-08-05", arrival: 7 * 60 + 48 },
];

let seq = 0;

function newProfile(): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`Mig166_${++seq}`)
      .lastInsertRowid
  );
  setTimezone(id, TZ);
  return id;
}

function stored(profileId: number, key: string): string | undefined {
  return (
    db
      .prepare(
        "SELECT value FROM profile_settings WHERE profile_id = ? AND key = ?"
      )
      .get(profileId, key) as { value: string } | undefined
  )?.value;
}

/** A synced overnight session whose provenance row landed at `arrivalMinute`. */
function night(profileId: number, date: string, arrivalMinute: number): void {
  const clock = `${String(Math.floor(arrivalMinute / 60)).padStart(2, "0")}:${String(arrivalMinute % 60).padStart(2, "0")}`;
  // The helper builds the clock itself, so it always resolves (#2245).
  const arrivedAt = zonedWallTimeToUtc(TZ, date, clock)!;
  const end = new Date(arrivedAt.getTime() - 60 * 60_000);
  const start = new Date(end.getTime() - 420 * 60_000);
  const sampleId = Number(
    db
      .prepare(
        `INSERT INTO metric_samples
           (profile_id, source, origin, metric, date, start_time, end_time, value)
         VALUES (?, ?, NULL, 'sleep_min', ?, ?, ?, 420)`
      )
      .run(profileId, PROVIDER, date, utcInstant(start), utcInstant(end))
      .lastInsertRowid
  );
  const eventId = Number(
    db
      .prepare(
        `INSERT INTO integration_sync_events (profile_id, provider, at, ok, inserted)
         VALUES (?, ?, ?, 1, 1)`
      )
      .run(profileId, PROVIDER, utcInstant(arrivedAt)).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO integration_sync_rows
       (event_id, target_table, target_id, disposition, created_at)
     VALUES (?, 'metric_samples', ?, 'inserted', ?)`
  ).run(eventId, sampleId, utcInstant(arrivedAt));
}

beforeEach(() => {
  db.exec("DELETE FROM integration_sync_rows");
  db.exec("DELETE FROM integration_sync_events");
  db.exec("DELETE FROM metric_samples");
});

describe("migration 166 — every digest becomes Static, and none moves or turns on", () => {
  it("carries a typed time over unchanged", () => {
    const p = newProfile();
    setProfileSetting(p, "notify_digest_hour", "06:45");
    up(db);
    expect(stored(p, "notify_digest_hour")).toBe("06:45");
    expect(stored(p, DIGEST_MODE_KEY)).toBe("static");
    const sched = getNotifySchedule(p);
    expect(sched.digestMinute).toBe(6 * 60 + 45);
    expect(sched.digestMode).toBe("static");
  });

  it("resolves `auto` ONCE, to the arrival-derived minute it was already sending at", () => {
    const p = newProfile();
    for (const n of ARRIVALS) night(p, n.date, n.arrival);
    setProfileSetting(p, "notify_digest_hour", "auto");
    up(db);
    // p90 07:40, and the live resolution's "strictly after" +1.
    expect(stored(p, "notify_digest_hour")).toBe("07:41");
    expect(getNotifySchedule(p).digestMinute).toBe(7 * 60 + 41);
    expect(getNotifySchedule(p).digestMode).toBe("static");
  });

  it("gives `auto` the declared pre-fill when the arrival sample cannot answer", () => {
    // The wake-time fallback is deliberately NOT reproduced: it is the measured
    // defect (#2214) and it drifts on its own, so there is no stable value to freeze.
    // 07:00 is the same number the picker pre-fills, and #2217 corrects it with a tap.
    const p = newProfile();
    setProfileSetting(p, "notify_digest_hour", "auto");
    up(db);
    expect(stored(p, "notify_digest_hour")).toBe("07:00");
    expect(getNotifySchedule(p).digestMinute).toBe(DIGEST_DEFAULT_MINUTE);
  });

  it("leaves an explicitly OFF digest off, with no mode row", () => {
    const p = newProfile();
    setProfileSetting(p, "notify_digest_hour", "");
    up(db);
    expect(stored(p, "notify_digest_hour")).toBe("");
    expect(stored(p, DIGEST_MODE_KEY)).toBeUndefined();
    expect(getNotifySchedule(p).digestMinute).toBeNull();
  });

  it("never turns an ABSENT digest on", () => {
    // The digest is opt-in and absent has always meant off. Writing a mode here would
    // be inventing configuration nobody asked for.
    const p = newProfile();
    up(db);
    expect(stored(p, "notify_digest_hour")).toBeUndefined();
    expect(stored(p, DIGEST_MODE_KEY)).toBeUndefined();
    expect(getNotifySchedule(p).digestMinute).toBeNull();
    // And it still reads as Static, so nothing can wait for it by accident.
    expect(getNotifySchedule(p).digestMode).toBe("static");
  });

  it("never writes Dynamic — that needs a tap", () => {
    const ps = [newProfile(), newProfile(), newProfile()];
    setProfileSetting(ps[0], "notify_digest_hour", "07:30");
    setProfileSetting(ps[1], "notify_digest_hour", "auto");
    setProfileSetting(ps[2], "notify_digest_hour", "");
    up(db);
    const dynamic = db
      .prepare(
        `SELECT COUNT(*) AS n FROM profile_settings WHERE key = ? AND value = 'dynamic'`
      )
      .get(DIGEST_MODE_KEY) as { n: number };
    expect(dynamic.n).toBe(0);
  });

  it("replays as a no-op", () => {
    const p = newProfile();
    for (const n of ARRIVALS) night(p, n.date, n.arrival);
    setProfileSetting(p, "notify_digest_hour", "auto");
    up(db);
    const after = {
      hour: stored(p, "notify_digest_hour"),
      mode: stored(p, DIGEST_MODE_KEY),
    };
    up(db);
    up(db);
    expect({
      hour: stored(p, "notify_digest_hour"),
      mode: stored(p, DIGEST_MODE_KEY),
    }).toEqual(after);
  });

  it("does not overwrite a mode a user has since chosen", () => {
    // Replay safety with teeth: someone who taps Dynamic after the migration ran must
    // not be reset to Static by a re-run. The mode is user-owned, and only a tap
    // writes it (#2211 constraint 3).
    const p = newProfile();
    setProfileSetting(p, "notify_digest_hour", "07:00");
    up(db);
    setProfileSetting(p, DIGEST_MODE_KEY, "dynamic");
    up(db);
    expect(stored(p, DIGEST_MODE_KEY)).toBe("dynamic");
    expect(getNotifySchedule(p).digestMode).toBe("dynamic");
  });
});
