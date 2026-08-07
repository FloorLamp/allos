// DB INTEGRATION TIER (#2161): the opt-in bedtime wear reminder against the real
// stores — `hr_minutes` (profile-local bare timestamps), `integration_sync_events`
// (UTC bare), the sleep rows that answer "does this profile wear a device to sleep",
// and the profile-tier consent flag that is the whole basis for the send existing.
//
// The measured incident is the fixture: Health Connect heart-rate minutes stop at
// 21:05 profile-local, the phone keeps pushing ok syncs with nothing on the stream,
// and the profile's Bedtime slot lands at 22:00. That one night was the only missing
// sleep night in eight weeks. The self-corrected night — watch back on at 21:50 —
// is the fixture that must stay silent.

import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { db } from "@/lib/db";
import { setTimezone, setProfileWearReminder } from "@/lib/settings";
import { shiftDateStr } from "@/lib/date";
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

/** Heart-rate minutes, profile-local bare, one row per minute up to and including `endHhmm`. */
function stream(endHhmm: string, minutes = 5): void {
  const [h, m] = endHhmm.split(":").map(Number);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO hr_minutes (profile_id, ts, bpm, n, source)
     VALUES (?, ?, 62, 60, ?)`
  );
  for (let back = 0; back < minutes; back++) {
    const total = h * 60 + m - back;
    const ts = `${DAY}T${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
      total % 60
    ).padStart(2, "0")}`;
    insert.run(profileId, ts, PROVIDER);
  }
}

/** A recorded sync at a UTC-bare instant. */
function sync(atUtcSql: string, ok = true): void {
  db.prepare(
    `INSERT INTO integration_sync_events (profile_id, provider, at, ok, inserted, error)
     VALUES (?, ?, ?, ?, 0, ?)`
  ).run(profileId, PROVIDER, atUtcSql, ok ? 1 : 0, ok ? null : "push rejected");
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
  sync("2026-07-14 21:20:00");
  sync("2026-07-14 21:48:00");
  sync("2026-07-14 22:00:00");
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
    sync("2026-07-14 22:00:00");
    setProfileWearReminder(profileId, true);
    // No synced sleep history, so the shared expected-active gate says no. Enabling
    // the setting does not conjure a device.
    expect(buildWearReminder(profileId)).toBeNull();

    seedSleepHistory();
    expect(buildWearReminder(profileId)).not.toBeNull();
  });

  it("yields when the provider is failing — a reconnect item owns that contact", () => {
    seedLostNightSignature();
    setProfileWearReminder(profileId, true);
    expect(buildWearReminder(profileId)).not.toBeNull();
    // Three consecutive failures — the shared FAILING_CONSECUTIVE_RUNS escalation
    // (#1880), read through the same attention model every other surface reads, not a
    // second rule. "Still on the charger?" would be false advice with the pipeline
    // down, and #1685's one-row rule forbids two contacts for one fault.
    sync("2026-07-14 22:01:00", false);
    sync("2026-07-14 22:02:00", false);
    sync("2026-07-14 22:03:00", false);
    expect(buildWearReminder(profileId)).toBeNull();
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
    sync("2026-07-14 21:59:00");
    // One minute short of the declared tolerance.
    const inside = 22 * 60 - (WEAR_QUIET_TOLERANCE_MIN - 1);
    stream(
      `${String(Math.floor(inside / 60)).padStart(2, "0")}:${String(
        inside % 60
      ).padStart(2, "0")}`
    );
    expect(buildWearReminder(profileId)).toBeNull();
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
