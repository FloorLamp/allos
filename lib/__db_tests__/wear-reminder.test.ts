// DB INTEGRATION TIER (#2161): the opt-in bedtime wear reminder against the real
// stores — `hr_minutes`, `integration_sync_events`, the sleep rows that answer "does
// this profile wear a device to sleep", and the profile-tier consent flag that is the
// whole basis for the send existing.
//
// THE FIXTURE'S TIMESTAMPS WERE WRONG UNTIL #2146, and that is worth stating rather
// than quietly fixing. It wrote `hr_minutes.ts` as a profile-local bare wall clock and
// `integration_sync_events.at` as SQLite's bare UTC shape — the conventions those
// columns carried before migrations 164 and 163 converted BOTH to canonical `…Z`
// instants. Because the profile here is UTC, a bare local stamp and its instant read
// alike, so the fixture stayed green while the production reader (which converted with
// `zonedWallIsoToUtc`, a helper that REFUSES a stamp carrying `Z`) resolved null for
// every real row and the reminder could not fire at all. Both halves now write what
// ingest writes, and lib/__db_tests__/quiet-stream.test.ts pins the same readers under
// a NON-UTC profile, where the two conventions are four hours apart and cannot be
// confused for one another.
//
// The measured incident is the fixture: Health Connect heart-rate minutes stop at
// 21:05 profile-local, the phone keeps pushing ok syncs with nothing on the stream,
// and the profile's Bedtime slot lands at 22:00. That one night was the only missing
// sleep night in eight weeks. The self-corrected night — watch back on at 21:50 —
// is the fixture that must stay silent.

import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { db } from "@/lib/db";
import { setTimezone, setProfileWearReminder } from "@/lib/settings";
import { shiftDateStr, utcMinute } from "@/lib/date";
import { buildWearReminder } from "@/lib/notifications/wear-reminder";
import { WEAR_QUIET_TOLERANCE_MIN } from "@/lib/wear-reminder";

const PROVIDER = "health-connect";
// 2026-07-14, 22:00 in a UTC profile — the Bedtime slot tick.
const SLOT_INSTANT = "2026-07-14T22:00:00.000Z";
const DAY = "2026-07-14";

let profileId: number;

function connect(): void {
  db.prepare(
    `INSERT INTO integration_connections (profile_id, provider, status, config)
     VALUES (?, ?, 'connected', NULL)`
  ).run(profileId, PROVIDER);
}

/**
 * Heart-rate minutes ending at `endHhmm`, one row per minute — as CANONICAL UTC
 * minutes (`utcMinute`), the shape migration 164 gave the column and ingest writes.
 * The profile is UTC here, so the wall clock and the instant coincide by construction.
 */
function stream(endHhmm: string, minutes = 5): void {
  const [h, m] = endHhmm.split(":").map(Number);
  const end = new Date(
    `${DAY}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`
  );
  const insert = db.prepare(
    `INSERT OR REPLACE INTO hr_minutes (profile_id, ts, bpm, n, source)
     VALUES (?, ?, 62, 60, ?)`
  );
  for (let back = 0; back < minutes; back++) {
    insert.run(
      profileId,
      utcMinute(new Date(end.getTime() - back * 60_000)),
      PROVIDER
    );
  }
}

/** A recorded sync at a canonical UTC instant (`YYYY-MM-DDTHH:MM:SSZ`, migration 163). */
function sync(hhmmss: string, ok = true): void {
  db.prepare(
    `INSERT INTO integration_sync_events (profile_id, provider, at, ok, inserted, error)
     VALUES (?, ?, ?, ?, 0, ?)`
  ).run(
    profileId,
    PROVIDER,
    `${DAY}T${hhmmss}Z`,
    ok ? 1 : 0,
    ok ? null : "push rejected"
  );
}

/** The nights that make this profile "expected active" — #2097's synced wake days. */
function seedSleepHistory(nights = 3): void {
  const insert = db.prepare(
    `INSERT INTO metric_samples
       (profile_id, source, origin, metric, date, start_time, end_time, value)
     VALUES (?, ?, NULL, 'sleep_min', ?, ?, ?, 420)`
  );
  for (let back = 1; back <= nights; back++) {
    const date = shiftDateStr(DAY, -back);
    insert.run(
      profileId,
      PROVIDER,
      date,
      `${shiftDateStr(date, -1)}T23:00:00.000Z`,
      `${date}T06:00:00.000Z`
    );
  }
}

/** The measured incident, minus the consent — every fixture starts from here. */
function seedLostNightSignature(): void {
  connect();
  seedSleepHistory();
  stream("21:05");
  // The off-wrist signature: pushes CONTINUE, carrying phone-sourced aggregates, with
  // nothing landing on the stream. This is what separates it from a connection outage.
  sync("21:20:00");
  sync("21:48:00");
  sync("22:00:00");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(SLOT_INSTANT));
  db.exec("DELETE FROM integration_sync_events");
  db.exec("DELETE FROM integration_connections");
  db.exec("DELETE FROM hr_minutes");
  db.exec("DELETE FROM metric_samples");
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('WEAR-REMINDER')").run()
      .lastInsertRowid
  );
  setTimezone(profileId, "UTC");
});
afterEach(() => {
  vi.useRealTimers();
});

describe("bedtime wear reminder (#2161)", () => {
  it("sends once for the measured lost night, naming when the watch went quiet", () => {
    seedLostNightSignature();
    setProfileWearReminder(profileId, true);

    const msg = buildWearReminder(profileId);
    expect(msg).not.toBeNull();
    expect(msg!.kind).toBe("wear-reminder");
    expect(msg!.body).toContain("21:05");
    // No buttons: the message means what it says on every channel, including the ones
    // that strip actions (#1718).
    expect(msg!.actions).toBeUndefined();
  });

  it("sends NOTHING when the profile never opted in — off is today's behaviour", () => {
    // The identical fixture. The only difference is the user's own declaration, which
    // is exactly what the contact-consent rule requires it to be.
    seedLostNightSignature();
    expect(buildWearReminder(profileId)).toBeNull();

    // And an explicit off is the same as never having been asked.
    setProfileWearReminder(profileId, false);
    expect(buildWearReminder(profileId)).toBeNull();
  });

  it("stays silent on the self-corrected night — watch back on at 21:50", () => {
    seedLostNightSignature();
    setProfileWearReminder(profileId, true);
    // Four of the five measured quiet evenings ended this way, unprompted.
    stream("21:50");
    expect(buildWearReminder(profileId)).toBeNull();
  });

  it("stays silent for a profile that does not wear a device to sleep", () => {
    connect();
    stream("21:05");
    sync("22:00:00");
    setProfileWearReminder(profileId, true);
    // No synced sleep history, so the shared expected-active gate says no. Enabling
    // the setting does not conjure a device.
    expect(buildWearReminder(profileId)).toBeNull();

    seedSleepHistory();
    expect(buildWearReminder(profileId)).not.toBeNull();
  });

  it("yields when the provider needs attention — a reconnect item owns that contact", () => {
    seedLostNightSignature();
    setProfileWearReminder(profileId, true);
    expect(buildWearReminder(profileId)).not.toBeNull();
    // Read through the same attention model every other surface reads, not a second
    // rule. "Still on the charger?" would be false advice with the pipeline down, and
    // #1685's one-row rule forbids two contacts for one fault.
    //
    // The credential dying (#326) is what escalates a provider that is still pushing:
    // since #2263 the OTHER escalation is a silence tolerance, and a provider whose
    // pushes are landing has no silence to measure.
    db.prepare(
      `UPDATE integration_connections SET status = 'needs_reauth'
        WHERE profile_id = ? AND provider = ?`
    ).run(profileId, PROVIDER);
    sync("22:04:00", false);
    expect(buildWearReminder(profileId)).toBeNull();
  });

  // The #2263 behaviour change, pinned where the old rule lived: a run of failed
  // pushes with good ones beside them is NOT an outage, so it must not silence this
  // send. The pipeline is up; the watch is off the wrist; that is what to say.
  it("still sends through a run of failed pushes with successes beside them", () => {
    seedLostNightSignature();
    setProfileWearReminder(profileId, true);
    sync("22:01:00", false);
    sync("22:02:00", false);
    sync("22:03:00", false);
    expect(buildWearReminder(profileId)).not.toBeNull();
  });

  it("stays silent when the phone stopped pushing during the gap", () => {
    connect();
    seedSleepHistory();
    stream("21:05");
    // Not one ok sync since the stream went quiet: this is a connection outage, which
    // the staleness detector already owns.
    setProfileWearReminder(profileId, true);
    expect(buildWearReminder(profileId)).toBeNull();
  });

  it("holds inside the tolerance and fires past it", () => {
    connect();
    seedSleepHistory();
    setProfileWearReminder(profileId, true);
    sync("21:59:00");
    // One minute short of the declared tolerance.
    const inside = 22 * 60 - (WEAR_QUIET_TOLERANCE_MIN - 1);
    stream(
      `${String(Math.floor(inside / 60)).padStart(2, "0")}:${String(
        inside % 60
      ).padStart(2, "0")}`
    );
    expect(buildWearReminder(profileId)).toBeNull();
  });

  // THE REGRESSION #2146 found. `hr_minutes.ts` became a canonical UTC instant in
  // migration 164; this gather still converted it with `zonedWallIsoToUtc`, which
  // REFUSES a stamp carrying 'Z' and returned null — so `minutesSinceStream` was null
  // for every real row, the verdict was permanently `no-stream`, and the reminder
  // could not fire in production at all. The old fixture hid it by writing the retired
  // shape into a UTC profile, where the two read alike.
  //
  // A non-UTC profile is what makes the two conventions distinguishable: the stored
  // instant and the wall clock the copy prints are five hours apart here, and the
  // assertion states both.
  it("reads the stored INSTANT and prints the profile-local clock (#2146 constraint 6)", () => {
    const eastern = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('WEAR-TZ')").run()
        .lastInsertRowid
    );
    setTimezone(eastern, "America/New_York");
    setProfileWearReminder(eastern, true);
    db.prepare(
      `INSERT INTO integration_connections (profile_id, provider, status, config)
       VALUES (?, ?, 'connected', NULL)`
    ).run(eastern, PROVIDER);
    const insertNight = db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, origin, metric, date, start_time, end_time, value)
       VALUES (?, ?, NULL, 'sleep_min', ?, ?, ?, 420)`
    );
    for (let back = 1; back <= 3; back++) {
      const date = shiftDateStr(DAY, -back);
      insertNight.run(
        eastern,
        PROVIDER,
        date,
        `${shiftDateStr(date, -1)}T23:00:00.000Z`,
        `${date}T06:00:00.000Z`
      );
    }
    // 17:05 in New York on 2026-07-14 is 21:05Z — the frozen clock's own instant minus
    // 55 minutes, past the 40-minute tolerance.
    db.prepare(
      `INSERT INTO hr_minutes (profile_id, ts, bpm, n, source)
       VALUES (?, '2026-07-14T21:05:00Z', 62, 60, ?)`
    ).run(eastern, PROVIDER);
    db.prepare(
      `INSERT INTO integration_sync_events (profile_id, provider, at, ok, inserted)
       VALUES (?, ?, '2026-07-14T21:40:00Z', 1, 0)`
    ).run(eastern, PROVIDER);

    const msg = buildWearReminder(eastern);
    expect(msg).not.toBeNull();
    // The instant is 21:05Z; the person saw 17:05. Reading either as the other fails.
    expect(msg!.body).toContain("17:05");
    expect(msg!.body).not.toContain("21:05");
  });

  it("is profile-scoped — another profile's quiet watch is not mine", () => {
    seedLostNightSignature();
    setProfileWearReminder(profileId, true);
    const other = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('WEAR-OTHER')").run()
        .lastInsertRowid
    );
    setTimezone(other, "UTC");
    setProfileWearReminder(other, true);
    expect(buildWearReminder(other)).toBeNull();
  });
});
