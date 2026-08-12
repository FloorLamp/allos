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
//
// ── THE FIXTURE RULE THIS FEATURE HAS BEEN BURNED BY TWICE (#2341) ───────────
//
// A stream fixture MUST model a LAGGING pipeline: rows ending well before `now`, with
// pushes continuing past them. A fixture whose rows run up to `now` models a pipeline
// that does not exist — this exporter runs 30–61 minutes behind, measured — and that
// is what let the reminder first ship dead (#2146: the fixture wrote a retired column
// shape) and then ship WRONG (#2341: it fired at 40 minutes of "silence" that was
// entirely ingest lag, while the watch was recording).
//
// So `sync()` below does what a real push does: it records the event AND the frontier
// observation the ingest path writes at the end of a successful ingest. A fixture that
// wrote only the event would be describing a pipeline in which nobody ever looked.

import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { db } from "@/lib/db";
import { setTimezone, setProfileWearReminder } from "@/lib/settings";
import { shiftDateStr, utcMinute } from "@/lib/date";
import {
  bedtimeWearReminderState,
  buildWearReminder,
} from "@/lib/notifications/wear-reminder";
import { observeStreamFrontiers } from "@/lib/stream-frontier-db";
import { parseHealthConnectPayload } from "@/lib/integrations/health-connect";
import { ingestHealthConnectPayload } from "@/lib/integrations/health-connect-ingest";
import { readStreamFrontier } from "@/lib/queries/continuous-streams";
import { reminderStream } from "@/lib/integrations/continuous-streams";

/** The floor the REGISTRY declares (#2341) — this module owns no threshold. */
const FLOOR = reminderStream("bedtime-wear")!.stream.reminder.frontierFloorMin;

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

/**
 * A recorded push at a canonical UTC instant (`YYYY-MM-DDTHH:MM:SSZ`, migration 163),
 * with the frontier observation a successful ingest writes at the end of it (#2341).
 *
 * The two arrive together in production and they arrive together here. A FAILED push
 * records no observation: the stored claim is "a successful sync landed without
 * advancing the frontier", and a failed push is not one.
 */
function sync(hhmmss: string, ok = true): void {
  const at = `${DAY}T${hhmmss}Z`;
  db.prepare(
    `INSERT INTO integration_sync_events (profile_id, provider, at, ok, inserted, error)
     VALUES (?, ?, ?, ?, 0, ?)`
  ).run(profileId, PROVIDER, at, ok ? 1 : 0, ok ? null : "push rejected");
  if (ok) observeStreamFrontiers(profileId, PROVIDER, at);
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
  // nothing landing on the stream. The first of them DELIVERED the 21:05 minutes (the
  // pipeline's own lag), and the two after it find the frontier exactly where it was —
  // which is the evidence, and is what separates this from a connection outage.
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
  db.exec("DELETE FROM stream_frontiers");
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
    // Four of the five measured quiet evenings ended this way, unprompted. The push
    // that carries the resumed minutes records the ADVANCE in the same transaction, so
    // the evidence is gone at the moment the data says it should be — no marker to
    // clear, no sweep.
    stream("21:50");
    sync("22:00:30");
    expect(
      readStreamFrontier(profileId, PROVIDER, "heart-rate")!.syncsSinceAdvance
    ).toBe(0);
    expect(buildWearReminder(profileId)).toBeNull();
  });

  it("stays silent for a profile that does not wear a device to sleep", () => {
    connect();
    stream("21:05");
    // The whole off-wrist signature — the delivering push and two quiet ones after it.
    sync("21:20:00");
    sync("21:48:00");
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
    // The credential dying (#326) is what escalates a source that is still pushing:
    // since #2263 the OTHER escalation is a silence tolerance, and a source whose
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
    // Not one ok push since the stream went quiet, so nothing ever observed the
    // frontier standing still: this is a connection outage, which the staleness
    // detector already owns.
    setProfileWearReminder(profileId, true);
    expect(bedtimeWearReminderState(profileId).verdict).toEqual({
      send: false,
      skip: "no-recent-sync",
    });
    expect(buildWearReminder(profileId)).toBeNull();
  });

  it("holds inside the declared floor even when the frontier is frozen", () => {
    connect();
    seedSleepHistory();
    setProfileWearReminder(profileId, true);
    // A watch put down a few minutes before the slot: two pushes have already found
    // the frontier where it was, so the EVIDENCE is in — and the floor is what stops
    // the send anyway. Rows end one minute short of the declared floor.
    const inside = 22 * 60 - (FLOOR - 1);
    stream(
      `${String(Math.floor(inside / 60)).padStart(2, "0")}:${String(
        inside % 60
      ).padStart(2, "0")}`
    );
    sync("21:24:00");
    sync("21:42:00");
    sync("21:59:00");
    expect(
      readStreamFrontier(profileId, PROVIDER, "heart-rate")!.syncsSinceAdvance
    ).toBe(2);
    expect(bedtimeWearReminderState(profileId).verdict).toEqual({
      send: false,
      skip: "stream-live",
    });
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
    // 55 minutes, past the declared 40-minute floor.
    db.prepare(
      `INSERT INTO hr_minutes (profile_id, ts, bpm, n, source)
       VALUES (?, '2026-07-14T21:05:00Z', 62, 60, ?)`
    ).run(eastern, PROVIDER);
    // Three pushes: the first delivered those minutes (this pipeline's own lag), the
    // two after it found the frontier exactly where it was.
    for (const at of [
      "2026-07-14T21:20:00Z",
      "2026-07-14T21:40:00Z",
      "2026-07-14T21:55:00Z",
    ]) {
      db.prepare(
        `INSERT INTO integration_sync_events (profile_id, provider, at, ok, inserted)
         VALUES (?, ?, ?, 1, 0)`
      ).run(eastern, PROVIDER, at);
      observeStreamFrontiers(eastern, PROVIDER, at);
    }

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

// ── The frontier discriminator, end to end (#2341) ───────────────────────────
//
// The two nights the old predicate could not tell apart, against the real stores. They
// run the SAME pipeline at the SAME lag with the source healthy throughout; the only
// difference is whether the watch kept producing. The first of them is the night this
// send went out wrongly, and this fixture fails on the code that sent it.

describe("the frontier, not the clock (#2341)", () => {
  /** A push that lands at `hhmmss` carrying the stream up to `frontierHhmm`. */
  function lateDelivery(hhmmss: string, frontierHhmm: string): void {
    stream(frontierHhmm, 20);
    sync(hhmmss);
  }

  it("does NOT send for a worn watch behind a 40-minute ingest lag", () => {
    // 2026-08-08, reproduced. Heart-rate minutes ran continuously; the pushes carrying
    // them ran 30–61 minutes behind. At the 22:00 slot the frontier stood at 21:20 —
    // exactly 40 minutes old, exactly the declared floor, which is why the boundary
    // check sent — and the push carrying the next 46 minutes landed five minutes after
    // the message went out.
    connect();
    seedSleepHistory();
    setProfileWearReminder(profileId, true);
    lateDelivery("21:28:00", "20:46");
    lateDelivery("21:44:00", "21:03");
    lateDelivery("21:59:00", "21:20");

    const { verdict } = bedtimeWearReminderState(profileId);
    // The quantity the old predicate thresholded, reproduced exactly: 40 minutes, at
    // the floor — so a floor-only decision sends here, and did.
    expect(verdict).toEqual({ send: false, skip: "frontier-advanced" });
    expect(buildWearReminder(profileId)).toBeNull();
    expect(
      readStreamFrontier(profileId, PROVIDER, "heart-rate")!.syncsSinceAdvance
    ).toBe(0);
  });

  it("does NOT send at the SECOND attempt of the slot either", () => {
    // `slotAttempt` gives the slot two due attempts an hour apart. The lag does not
    // shrink in between, so an hour later the frontier is ~40 minutes old again.
    connect();
    seedSleepHistory();
    setProfileWearReminder(profileId, true);
    lateDelivery("21:28:00", "20:46");
    lateDelivery("21:59:00", "21:20");
    lateDelivery("22:31:00", "22:20");
    const at = new Date(`${DAY}T23:00:00.000Z`);
    expect(bedtimeWearReminderState(profileId, at).verdict).toEqual({
      send: false,
      skip: "frontier-advanced",
    });
  });

  it("SENDS for the watch removed at 21:05, at both attempts of the slot", () => {
    // The motivating incident, on the same lagging pipeline: three pushes land, none
    // of them carrying anything newer than 21:05.
    seedLostNightSignature();
    setProfileWearReminder(profileId, true);
    const first = bedtimeWearReminderState(profileId);
    expect(first.verdict).toEqual({ send: true, quietForMin: 55 });
    expect(first.lastSeenLocalHhmm).toBe("21:05");
    // An hour later, with two more quiet pushes, it is only more certain — the
    // evidence accumulates and the frontier only gets older.
    sync("22:20:00");
    sync("22:44:00");
    const at = new Date(`${DAY}T23:00:00.000Z`);
    expect(bedtimeWearReminderState(profileId, at).verdict).toEqual({
      send: true,
      quietForMin: 115,
    });
  });

  it("resolves the stored column — a permanently `no-stream` verdict is the bug this shipped with", () => {
    // #2161 shipped DEAD: migration 164 made `hr_minutes.ts` a canonical instant, the
    // reader still converted it with a helper that refuses a `Z`, every reading came
    // back null, and the verdict was permanently `no-stream` — while the DB test
    // stayed green because its fixture wrote the retired shape. This asserts the
    // failure mode itself, on rows written the way ingest writes them: whatever else
    // silences this send, it is never "nothing has ever arrived".
    seedLostNightSignature();
    setProfileWearReminder(profileId, true);
    for (const at of [
      new Date(`${DAY}T21:10:00.000Z`),
      new Date(`${DAY}T22:00:00.000Z`),
      new Date(`${DAY}T23:00:00.000Z`),
    ]) {
      const { verdict, lastSeenLocalHhmm } = bedtimeWearReminderState(
        profileId,
        at
      );
      expect(verdict.send ? null : verdict.skip).not.toBe("no-stream");
      expect(lastSeenLocalHhmm).toBe("21:05");
    }
  });

  it("keeps another provider's watermark out of this one's answer", () => {
    // The watermark is keyed on (profile, source, stream). The app's other
    // hr_minutes writer declares no continuous stream at all, so it can never write
    // one — but a row planted under its name must not be read as this stream's either.
    seedLostNightSignature();
    setProfileWearReminder(profileId, true);
    db.prepare(
      `INSERT INTO stream_frontiers
         (profile_id, provider, stream, frontier_at, advanced_at, observed_at,
          syncs_since_advance)
       VALUES (?, 'fitbit-takeout', 'heart-rate', ?, ?, ?, 0)`
    ).run(
      profileId,
      `${DAY}T21:05:00Z`,
      `${DAY}T22:00:00Z`,
      `${DAY}T22:00:00Z`
    );
    expect(buildWearReminder(profileId)).not.toBeNull();
  });
});

// ── Where the observation comes from (#2341) ─────────────────────────────────
//
// The predicate above reads a stored watermark, so the whole feature rests on the
// INGEST path writing it — including on the push that is the entire signal: the one
// that carries nothing for the stream at all, opens no upsert transaction of its own,
// and would be invisible to a write that piggybacked on the upsert.

describe("the ingest path records the frontier (#2341)", () => {
  /** Heart-rate samples at consecutive minutes from `startIso`, as the exporter sends. */
  function hrPayload(startIso: string, count: number) {
    const t0 = new Date(startIso).getTime();
    return {
      heart_rate: Array.from({ length: count }, (_, i) => ({
        time: new Date(t0 + i * 60_000).toISOString(),
        bpm: 60 + (i % 10),
      })),
    };
  }

  /** One push landing at `at`, ingested exactly as the route ingests it. */
  function push(payload: object, at: string, chunkSize = 1000): void {
    // The observation is stamped with the app's own clock (lib/clock's instantNow),
    // frozen by this file's fake timers and moved per push so each stamp is its own.
    vi.setSystemTime(new Date(`${DAY}T${at}:00.000Z`));
    ingestHealthConnectPayload(
      profileId,
      parseHealthConnectPayload(payload, "UTC"),
      PROVIDER,
      chunkSize
    );
  }

  beforeEach(() => {
    connect();
  });

  it("writes the watermark on a push that DELIVERED rows", () => {
    push(hrPayload(`${DAY}T21:00:00Z`, 6), "21:20");
    const frontier = readStreamFrontier(profileId, PROVIDER, "heart-rate")!;
    // The frontier is the newest MINUTE that landed, in the canonical shape the column
    // carries (migration 164) — not the payload's own stamp and not a wall clock.
    expect(frontier.frontierAt).toBe(`${DAY}T21:05:00Z`);
    expect(frontier.advancedAt).toBe(`${DAY}T21:20:00Z`);
    expect(frontier.syncsSinceAdvance).toBe(0);
  });

  it("counts a push that carried NOTHING for the stream — the case the whole thing turns on", () => {
    push(hrPayload(`${DAY}T21:00:00Z`, 6), "21:20");
    // The watch is on the charger now. The phone keeps pushing its own aggregates:
    // real payloads, zero heart-rate records, zero stream upserts, zero transactions
    // opened for the stream.
    push({ steps: [] }, "21:48");
    expect(
      readStreamFrontier(profileId, PROVIDER, "heart-rate")!.syncsSinceAdvance
    ).toBe(1);
    push({}, "22:00");
    const frontier = readStreamFrontier(profileId, PROVIDER, "heart-rate")!;
    expect(frontier.syncsSinceAdvance).toBe(2);
    // The frontier itself never moved, and its advance instant is still the push that
    // moved it.
    expect(frontier.frontierAt).toBe(`${DAY}T21:05:00Z`);
    expect(frontier.advancedAt).toBe(`${DAY}T21:20:00Z`);
    expect(frontier.observedAt).toBe(`${DAY}T22:00:00Z`);
  });

  it("stays consistent with the rows across a MULTI-CHUNK push", () => {
    // A batch is written in bounded per-chunk transactions, so "the transaction that
    // upserts the stream" is several. The observation reads the frontier inside its
    // own transaction, after every chunk committed, and therefore describes exactly
    // what is on disk however the batch was split.
    push(hrPayload(`${DAY}T20:00:00Z`, 90), "21:30", 7);
    const rows = db
      .prepare(
        `SELECT MAX(ts) AS ts FROM hr_minutes WHERE profile_id = ? AND source = ?`
      )
      .get(profileId, PROVIDER) as { ts: string };
    expect(
      readStreamFrontier(profileId, PROVIDER, "heart-rate")!.frontierAt
    ).toBe(rows.ts);
  });

  it("re-pushing the same rolling window is idempotent AND counts as a quiet push", () => {
    // Idempotence is unchanged: the rows dedupe on their natural key. What is new is
    // that the re-push is EVIDENCE — the exporter resending an identical window is
    // exactly what a device that stopped producing looks like.
    const window = hrPayload(`${DAY}T21:00:00Z`, 6);
    push(window, "21:20");
    push(window, "21:44");
    push(window, "22:00");
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM hr_minutes WHERE profile_id = ? AND source = ?`
          )
          .get(profileId, PROVIDER) as { n: number }
      ).n
    ).toBe(6);
    expect(
      readStreamFrontier(profileId, PROVIDER, "heart-rate")!.syncsSinceAdvance
    ).toBe(2);
  });

  it("writes NOTHING for a provider that declares no continuous stream", () => {
    // The Fitbit Takeout archive is the app's other hr_minutes writer and is exempt BY
    // CONSTRUCTION — it declares no stream, so there is nothing to observe and no
    // special case to maintain.
    vi.setSystemTime(new Date(`${DAY}T21:20:00.000Z`));
    expect(observeStreamFrontiers(profileId, "fitbit-takeout")).toEqual({});
    expect(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM stream_frontiers`).get() as {
          n: number;
        }
      ).n
    ).toBe(0);
  });
});
