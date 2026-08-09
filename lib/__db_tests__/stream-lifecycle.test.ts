// DB INTEGRATION TIER (#2162): the continuous-stream on/offboarding lifecycle against
// the real stores.
//
// THE END-TO-END CLAIMS THIS TIER EXISTS FOR, in the issue's own words:
//
//   • seed the FIRST heart-rate rows → the onboarding offer surfaces, keyed on
//     (provider, stream), with the setting still off;
//   • seed a fourteen-day lapse → the #2161 reminder had ALREADY stopped at the shared
//     expected-active gate days earlier (the offboarding prompt is transparency over a
//     gate that closed, not the thing that closes it), the prompt appears once, and
//     Keep leaves the setting exactly as it was;
//   • resumed data reopens the gate with no prompt of any kind.
//
// Deliberately NOT in UTC. Under `America/New_York` a wall clock and its instant
// differ by hours, which is the margin a misread timestamp convention hides in
// (#2096/#2146 constraint 6): a UTC-profile fixture passes whether the reader converts
// or not. `hr_minutes.ts` is a canonical UTC instant since migration 164, so every row
// below is minted through `zonedWallTimeToUtc` + `utcMinute` exactly as ingest does,
// and the profile-local DAY the lifecycle keys on is asserted separately.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { db, today } from "@/lib/db";
import { setTimezone, setProfileWearReminder } from "@/lib/settings";
import { getProfileWearReminder } from "@/lib/settings/notifications";
import { shiftDateStr, utcMinute, zonedWallTimeToUtc } from "@/lib/date";
import { dismissFinding } from "@/lib/queries";
import { buildWearReminder } from "@/lib/notifications/wear-reminder";
import {
  getStreamLifecycles,
  getStreamLifecycleOffers,
  wearReminderPausedNote,
} from "@/lib/queries/stream-lifecycle";
import {
  STREAM_OFFBOARD_PREFIX,
  STREAM_ONBOARD_PREFIX,
  streamOffboardKey,
  streamOnboardKey,
} from "@/lib/integrations/stream-lifecycle";

const PROVIDER = "health-connect";
const TZ = "America/New_York";
/** 08:00 local on 2026-07-15 — a morning, so "today" is unambiguous either side. */
const DAY = "2026-07-15";

let profileId: number;

function nowInstant(): Date {
  return zonedWallTimeToUtc(TZ, DAY, "08:00")!;
}

function connect(status = "connected"): void {
  db.prepare(
    `INSERT INTO integration_connections (profile_id, provider, status, config)
     VALUES (?, ?, ?, NULL)`
  ).run(profileId, PROVIDER, status);
}

/** Heart-rate minutes ending at the profile-local `day` + `hhmm`, canonical UTC. */
function stream(day: string, hhmm = "20:00", minutes = 5): void {
  const end = zonedWallTimeToUtc(TZ, day, hhmm)!;
  const insert = db.prepare(
    `INSERT OR REPLACE INTO hr_minutes (profile_id, ts, bpm, n, source)
     VALUES (?, ?, 62, 60, ?)`
  );
  for (let back = 0; back < minutes; back++)
    insert.run(
      profileId,
      utcMinute(new Date(end.getTime() - back * 60_000)),
      PROVIDER
    );
}

/** A successful push, so the connection reads healthy throughout. */
function sync(day: string, hhmm: string): void {
  db.prepare(
    `INSERT INTO integration_sync_events (profile_id, provider, at, ok, inserted)
     VALUES (?, ?, ?, 1, 0)`
  ).run(profileId, PROVIDER, utcMinute(zonedWallTimeToUtc(TZ, day, hhmm)!));
}

/** Deliver on each local day from `fromBack` days ago through `toBack`, inclusive. */
function deliverDays(fromBack: number, toBack: number): void {
  for (let back = fromBack; back >= toBack; back--)
    stream(shiftDateStr(DAY, -back));
}

function offerKeys(): string[] {
  return getStreamLifecycleOffers(profileId).map((o) => o.key);
}

function stateOf(): string | undefined {
  return getStreamLifecycles(profileId)[0]?.state;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(nowInstant());
  db.exec("DELETE FROM integration_sync_events");
  db.exec("DELETE FROM integration_connections");
  db.exec("DELETE FROM hr_minutes");
  db.exec("DELETE FROM upcoming_dismissals");
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('STREAM-LIFECYCLE')").run()
      .lastInsertRowid
  );
  setTimezone(profileId, TZ);
});
afterEach(() => vi.useRealTimers());

describe("onboarding — the first rows ever from a stream", () => {
  it("a connected provider that has never delivered is absent and offers nothing", () => {
    connect();
    expect(stateOf()).toBe("absent");
    expect(getStreamLifecycleOffers(profileId)).toEqual([]);
  });

  it("first rows surface the offer, keyed on (provider, stream), setting still off", () => {
    connect();
    stream(DAY, "07:40", 30);
    sync(DAY, "07:45");

    const life = getStreamLifecycles(profileId)[0];
    expect(life.state).toBe("appeared");
    // The PROFILE-LOCAL day, not the UTC one: 07:40 in New York is 11:40Z, and both
    // land on the 15th here, but the first/last day must come from localDayOf.
    expect(life.firstDay).toBe(DAY);
    expect(life.lastDay).toBe(today(profileId));
    expect(life.quietDays).toBe(0);

    const offers = getStreamLifecycleOffers(profileId);
    expect(offers).toHaveLength(1);
    const [offer] = offers;
    expect(offer.kind).toBe("onboard");
    // The registered dedupe-key prefix, and the exact key the actions guard on.
    expect(offer.key.startsWith(STREAM_ONBOARD_PREFIX)).toBe(true);
    expect(offer.key).toBe(streamOnboardKey(PROVIDER, "heart-rate"));
    expect(offer.title).toContain("Health Connect");
    expect(offer.body).toContain("Off unless you turn it on");
    expect(offer.href).toBe("/integrations/health-connect");
    // The offer is a QUESTION: nothing has been enabled by rendering it.
    expect(getProfileWearReminder(profileId)).toBe(false);
    expect(buildWearReminder(profileId)).toBeNull();
  });

  it("the offer is one-shot — a dismissal on the bus silences it for good", () => {
    connect();
    stream(DAY, "07:40", 30);
    const key = streamOnboardKey(PROVIDER, "heart-rate");
    expect(offerKeys()).toEqual([key]);

    dismissFinding(profileId, key);
    expect(getStreamLifecycleOffers(profileId)).toEqual([]);
    // Still appeared — the state is unchanged, only the offer is silenced. That
    // separation is what makes the dismissal side-state rather than a state edit.
    expect(stateOf()).toBe("appeared");
  });

  it("an already-enabled setting is never re-offered (constraint 6)", () => {
    connect();
    setProfileWearReminder(profileId, true);
    stream(DAY, "07:40", 30);
    expect(getStreamLifecycleOffers(profileId)).toEqual([]);
  });

  it("a stream from a DISCONNECTED provider has no lifecycle at all", () => {
    connect("disconnected");
    stream(DAY, "07:40", 30);
    expect(getStreamLifecycles(profileId)).toEqual([]);
    expect(getStreamLifecycleOffers(profileId)).toEqual([]);
  });

  it("a long-established stream is active and offers nothing", () => {
    connect();
    deliverDays(60, 0);
    expect(stateOf()).toBe("active");
    expect(getStreamLifecycleOffers(profileId)).toEqual([]);
  });
});

describe("offboarding — transparency over a gate that already closed", () => {
  /** Worn for two months, then nothing for `quietDays` days. Pushes continue. */
  function seedLapse(quietDays: number): void {
    connect();
    deliverDays(75, quietDays);
    sync(DAY, "07:12");
    setProfileWearReminder(profileId, true);
  }

  it("the reminder stops itself DAYS before the prompt exists", () => {
    // Three days of silence: the shared 2-of-3 expected-active gate has closed, so
    // #2161 sends nothing — and this is `lapsed`, which offers nothing. The prompt
    // never races the gate, which is the whole sizing argument for the horizon.
    seedLapse(3);
    expect(stateOf()).toBe("lapsed");
    expect(buildWearReminder(profileId)).toBeNull();
    expect(getStreamLifecycleOffers(profileId)).toEqual([]);
    // But the Settings row stops pretending it will fire tonight.
    const note = wearReminderPausedNote(profileId);
    expect(note).toContain("Paused");
    expect(note).toContain("heart-rate");
    expect(note).toContain("for 3 days");
  });

  it("past the horizon the prompt appears once, anchored on the lapse episode", () => {
    seedLapse(14);
    expect(stateOf()).toBe("ended");
    expect(buildWearReminder(profileId)).toBeNull();

    const offers = getStreamLifecycleOffers(profileId);
    expect(offers).toHaveLength(1);
    const [offer] = offers;
    expect(offer.kind).toBe("offboard");
    expect(offer.key.startsWith(STREAM_OFFBOARD_PREFIX)).toBe(true);
    expect(offer.key).toBe(
      streamOffboardKey(PROVIDER, "heart-rate", shiftDateStr(DAY, -14))
    );
    expect(offer.title).toContain("paused themselves");
    expect(offer.body).toContain("in 14 days");
    expect(offer.body).toContain("nothing here has changed your setting");
    // The lapse itself wrote nothing: the setting is exactly as the user left it.
    expect(getProfileWearReminder(profileId)).toBe(true);
  });

  it("KEEP dismisses the episode and preserves the setting", () => {
    seedLapse(20);
    const [offer] = getStreamLifecycleOffers(profileId);
    // What the Keep tap does: one dismissal, no setting write.
    dismissFinding(profileId, offer.key);

    expect(getStreamLifecycleOffers(profileId)).toEqual([]);
    expect(getProfileWearReminder(profileId)).toBe(true);
    // Still ended, still quiet, still no send — the prompt was an announcement.
    expect(stateOf()).toBe("ended");
    expect(buildWearReminder(profileId)).toBeNull();
  });

  it("a NEW lapse after a real resume is a NEW episode, un-silenced", () => {
    seedLapse(20);
    const [first] = getStreamLifecycleOffers(profileId);
    dismissFinding(profileId, first.key);
    expect(getStreamLifecycleOffers(profileId)).toEqual([]);

    // The watch comes back for a week, then stops again. The episode anchor moved, so
    // the earlier dismissal cannot silence this one.
    deliverDays(17, 15);
    const second = getStreamLifecycleOffers(profileId);
    expect(second).toHaveLength(1);
    expect(second[0].key).not.toBe(first.key);
    expect(second[0].key).toBe(
      streamOffboardKey(PROVIDER, "heart-rate", shiftDateStr(DAY, -15))
    );
  });

  it("resumed data reopens the gate with NO prompt and NO ceremony", () => {
    seedLapse(20);
    expect(getStreamLifecycleOffers(profileId)).toHaveLength(1);

    // One batch arrives today. Nothing is told; the derived state simply moves.
    stream(DAY, "07:30", 30);
    expect(stateOf()).toBe("active");
    expect(getStreamLifecycleOffers(profileId)).toEqual([]);
    // The setting was never touched, so the reminder is live again by itself — and
    // the Settings row stops claiming a pause.
    expect(getProfileWearReminder(profileId)).toBe(true);
    expect(wearReminderPausedNote(profileId)).toBeNull();
  });

  it("no prompt for a profile that never turned the reminder on", () => {
    connect();
    deliverDays(75, 20);
    expect(stateOf()).toBe("ended");
    // Nothing paused itself, so there is nothing to explain or keep.
    expect(getStreamLifecycleOffers(profileId)).toEqual([]);
    expect(wearReminderPausedNote(profileId)).toBeNull();
  });
});

describe("the lifecycle writes nothing", () => {
  it("gathering twice leaves the stores byte-identical (read-time, stateless)", () => {
    connect();
    deliverDays(75, 20);
    setProfileWearReminder(profileId, true);

    const counts = () =>
      ["hr_minutes", "integration_sync_events", "upcoming_dismissals"].map(
        (t) =>
          (
            db
              .prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE profile_id = ?`)
              .get(profileId) as { n: number }
          ).n
      );
    const before = counts();
    getStreamLifecycleOffers(profileId);
    getStreamLifecycles(profileId);
    wearReminderPausedNote(profileId);
    expect(counts()).toEqual(before);
    // And the user-owned consent is untouched by every one of those reads.
    expect(getProfileWearReminder(profileId)).toBe(true);
  });

  it("is profile-scoped: another profile's rows produce no offer here", () => {
    connect();
    stream(DAY, "07:40", 30);
    const other = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('OTHER')").run()
        .lastInsertRowid
    );
    setTimezone(other, TZ);
    expect(getStreamLifecycles(other)).toEqual([]);
    expect(getStreamLifecycleOffers(other)).toEqual([]);
  });
});
