// DB INTEGRATION TIER (#2146): the quiet-stream detector against the real stores.
//
// THE MEASURED INCIDENT IS THE FIXTURE. A real Health Connect profile's `hr_minutes`
// end at 21:05 profile-local; the phone keeps pushing `ok=1` every 15–30 minutes with
// nothing landing on the stream while its own daily aggregates keep updating; the
// watch spends the night on the charger and the profile loses its only missing sleep
// night in eight weeks. Every existing detector called that healthy.
//
// ── What this tier is really pinning: the timestamp conventions ──────────────
//
// #2146 constraint 6. The predicate joins three stores, and the columns it joins have
// not all been on the same convention:
//
//   • `hr_minutes.ts`             — a canonical UTC instant ('…:00Z') since migration
//                                   164. It used to be a PROFILE-LOCAL wall clock, and
//                                   a reader still assuming that gets null, not a
//                                   wrong number, because zonedWallIsoToUtc refuses a
//                                   'Z'.
//   • `integration_sync_events.at`— a canonical UTC instant since migration 163, with
//                                   pre-163 rows still on SQLite's bare shape.
//   • `metric_samples.start/end`  — canonical UTC instants.
//
// So the profile here is deliberately NOT in UTC. Under `America/New_York` in July
// (UTC−4) a wall clock and its instant differ by four hours, which is exactly the
// margin a misread convention hides in: a UTC-profile fixture passes whether the
// reader converts or not. Every assertion below therefore states BOTH — the stored
// instant and the profile-local clock the copy prints — so reading either column as
// the other fails loudly.

import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { db } from "@/lib/db";
import { setTimezone } from "@/lib/settings";
import { setDisplayFormatPrefs } from "@/lib/settings/display";
import { utcMinute, shiftDateStr, zonedWallTimeToUtc } from "@/lib/date";
import {
  getQuietStreamAttention,
  getQuietStreamRows,
  getQuietStreams,
  latestStreamInstant,
  readStreamFrontier,
} from "@/lib/queries/continuous-streams";
import { observeStreamFrontiers } from "@/lib/stream-frontier-db";
import { quietStreamDedupeKey } from "@/lib/integrations/quiet-stream";
import { continuousStream } from "@/lib/integrations/continuous-streams";

/** The evidence bar the REGISTRY declares for this stream (#2560) — read, not restated. */
const EVIDENCE = continuousStream("health-connect", "heart-rate")!.stream
  .frozenEvidence.syncs;

const PROVIDER = "health-connect";
const TZ = "America/New_York";
// The morning after: 07:30 local on 2026-07-15, i.e. 11:30Z. The watch went quiet at
// 21:05 the evening before — 10h25m of silence, well past the declared 2.5 h.
const DAY = "2026-07-15";
const YESTERDAY = "2026-07-14";

let profileId: number;
let loginId: number;

function nowInstant(): Date {
  return zonedWallTimeToUtc(TZ, DAY, "07:30")!;
}

function connect(status = "connected"): void {
  db.prepare(
    `INSERT INTO integration_connections (profile_id, provider, status, config)
     VALUES (?, ?, ?, NULL)`
  ).run(profileId, PROVIDER, status);
}

/**
 * Heart-rate minutes, one row per minute ending at the profile-local `day` + `hhmm`.
 *
 * The stored value is the CANONICAL UTC MINUTE the wall clock denotes (utcMinute over
 * the settled instant), never the wall clock itself — the exact shape migration 164
 * gave the column and the ingest path writes.
 */
function stream(day: string, hhmm: string, minutes = 5): void {
  const end = zonedWallTimeToUtc(TZ, day, hhmm)!;
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
 * A recorded push at a profile-local wall clock, stored as a canonical instant — AND,
 * when it succeeded, the frontier observation the real ingest path writes at the end of
 * it (#2341).
 *
 * The two are one thing in production, and the fixture models it that way on purpose:
 * this feature has already been burned once by a fixture that wrote a shape ingest does
 * not write. A push that FAILED records no observation, because "a successful sync
 * landed without advancing the frontier" is the claim the row stores.
 */
function sync(day: string, hhmm: string, ok = true): void {
  const at = utcMinute(zonedWallTimeToUtc(TZ, day, hhmm)!);
  db.prepare(
    `INSERT INTO integration_sync_events (profile_id, provider, at, ok, inserted, error)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    profileId,
    PROVIDER,
    at,
    ok ? 1 : 0,
    // The off-wrist signature: the push SUCCEEDS and writes nothing to this stream,
    // because what it carries is phone-sourced daily aggregates.
    0,
    ok ? null : "push rejected"
  );
  if (ok) observeStreamFrontiers(profileId, PROVIDER, at);
}

/** The days behind today that make the stream "expected active" (the #2097 shape). */
function seedPriorDays(days = 3): void {
  for (let back = 1; back <= days; back++) {
    stream(shiftDateStr(DAY, -back), "20:00", 3);
  }
}

/**
 * The measured incident, whole.
 *
 * The first push DELIVERED the 21:05 minutes (this pipeline's own lag); every push
 * after it finds the frontier exactly where it was. There are four of those since
 * #2560 rather than two, because two is also what one pending watch → Health Connect
 * batch looks like — and a watch on a charger all night accumulates evidence without
 * bound, so the case this detector exists for is unaffected.
 */
function seedOffWristNight(): void {
  connect();
  seedPriorDays();
  stream(YESTERDAY, "21:05");
  sync(YESTERDAY, "21:20");
  sync(YESTERDAY, "21:48");
  sync(YESTERDAY, "22:15");
  sync(YESTERDAY, "23:04");
  sync(DAY, "07:12");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(nowInstant());
  db.exec("DELETE FROM integration_sync_events");
  db.exec("DELETE FROM integration_connections");
  db.exec("DELETE FROM hr_minutes");
  db.exec("DELETE FROM stream_frontiers");
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('QUIET-STREAM')").run()
      .lastInsertRowid
  );
  loginId = Number(
    db
      .prepare(
        `INSERT INTO logins (username, password_hash, role)
         VALUES (?, 'scrypt$2$1$1$00$00', 'member')`
      )
      .run(`quiet_stream_${profileId}`).lastInsertRowid
  );
  setTimezone(profileId, TZ);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("quiet-stream detection (#2146)", () => {
  it("reports the measured incident, naming when the stream went quiet", () => {
    seedOffWristNight();

    const rows = getQuietStreams(profileId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.sourceId).toBe(PROVIDER);
    expect(row.streamId).toBe("heart-rate");
    // BOTH halves of the conversion, stated. 21:05 in New York on 2026-07-14 is
    // 01:05Z on the 15th — a reader that took the stored instant for a wall clock, or
    // the wall clock for an instant, cannot satisfy both of these.
    expect(row.sinceAt).toBe("2026-07-15T01:05:00Z");
    expect(row.sinceLocalHhmm).toBe("21:05");
    // 21:05 → 07:30 local, across a date boundary the UTC stamps also cross.
    expect(row.quietForMin).toBe(10 * 60 + 25);
    expect(row.today).toBe(DAY);
  });

  it("stores nothing and keys on the profile-local day", () => {
    seedOffWristNight();
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM integration_sync_events")
      .get() as { n: number };
    const [row] = getQuietStreamRows(profileId, loginId);
    expect(row.key).toBe(
      quietStreamDedupeKey({
        sourceId: PROVIDER,
        streamId: "heart-rate",
        today: DAY,
      })
    );
    expect(row.key).toContain(DAY);
    // Read-time and stateless: the detection wrote no marker, no event, no row.
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM integration_sync_events")
          .get() as { n: number }
      ).n
    ).toBe(before.n);
  });

  it("renders the since-time in the LOGIN's clock convention", () => {
    seedOffWristNight();
    const [row] = getQuietStreamAttention(profileId, loginId);
    expect(row.kind).toBe("quiet-stream");
    expect(row.id).toBe(PROVIDER);
    // 24h is the default.
    expect(row.detail).toContain("since 21:05");
    expect(row.detail).toContain("10 hours ago");
    expect(row.detail).toContain("Is the watch on your wrist");

    setDisplayFormatPrefs(loginId, { timeFormat: "12h", dateFormat: "mdy" });
    // getDisplayFormatPrefs is cache()-wrapped per request; the DB tier has no request
    // scope, so this reads through.
    const [twelve] = getQuietStreamAttention(profileId, loginId);
    expect(twelve.detail).toContain("since 9:05 PM");
  });

  it("CLEARS when a backfill lands — no marker to un-set", () => {
    seedOffWristNight();
    expect(getQuietStreams(profileId)).toHaveLength(1);

    // The phone catches up and pushes the missing window. Nothing about the detector
    // is told; max(ts) simply moves, and the row is gone on the next read.
    stream(DAY, "07:10", 600);
    expect(getQuietStreams(profileId)).toEqual([]);
    expect(getQuietStreamAttention(profileId, loginId)).toEqual([]);
  });

  it("stays silent on a routine dip inside the declared tolerance", () => {
    connect();
    seedPriorDays();
    // The evening-charge cluster's shape, moved to this morning: 90 minutes, inside
    // the 2.5 h valley the tolerance sits in.
    stream(DAY, "06:00");
    sync(DAY, "07:12");
    expect(getQuietStreams(profileId)).toEqual([]);
  });

  it("stays silent on a CONNECTION outage — nothing landed to observe (constraint 1)", () => {
    connect();
    seedPriorDays();
    stream(YESTERDAY, "21:05");
    // The phone died with the watch. The push that delivered the 21:05 minutes is the
    // last successful one; everything after it failed, so nothing ever observed the
    // frontier standing still. This is #1685's case and it must not be reported twice.
    sync(YESTERDAY, "21:20");
    sync(YESTERDAY, "23:00", false);
    sync(DAY, "07:12", false);
    expect(getQuietStreams(profileId)).toEqual([]);
    // The discriminator, isolated: the one observation there is recorded an ADVANCE,
    // and no successful push has landed since to say otherwise.
    const frontier = readStreamFrontier(profileId, PROVIDER, "heart-rate")!;
    expect(frontier.frontierAt).toBe(
      latestStreamInstant(profileId, "hr_minutes", PROVIDER)
    );
    expect(frontier.syncsSinceAdvance).toBe(0);
  });

  it("stays silent while the frontier is still MOVING, at the same silence (#2341)", () => {
    // THE case no threshold on elapsed silence can reach. The watch is ON — it is the
    // PIPELINE that is an hour behind, which is this exporter's measured steady state
    // (30–61 min; #2263's census puts the push gap at p99 67 min). Each push carries
    // newer minutes than the last, so the frontier advances every time even though it
    // is always far older than the 2.5 h tolerance would need it to be.
    connect();
    seedPriorDays();
    // Rows through 03:00 local, pushed at 04:00 — and the reading is taken at 07:30,
    // so the stream looks 4.5 hours silent while the watch never stopped.
    stream(DAY, "01:30", 120);
    sync(DAY, "02:30");
    stream(DAY, "03:00", 90);
    sync(DAY, "04:00");
    expect(getQuietStreams(profileId)).toEqual([]);
    const frontier = readStreamFrontier(profileId, PROVIDER, "heart-rate")!;
    expect(frontier.syncsSinceAdvance).toBe(0);
  });

  it("needs the DECLARED number of quiet pushes, not fewer (#2341/#2560)", () => {
    connect();
    seedPriorDays();
    stream(YESTERDAY, "21:05");
    sync(YESTERDAY, "21:20");
    // Quiet pushes accumulate one at a time; none of them is evidence until the
    // stream's own declared bar is reached. The bar is a property of THIS source's
    // delivery chain — the watch batches into Health Connect independently of the
    // exporter, and single pushes have delivered 164–324 minutes of heart rate at once.
    const quietAt = ["21:48", "22:15", "23:04", "23:41", "23:52"];
    for (let k = 1; k < EVIDENCE; k++) {
      sync(YESTERDAY, quietAt[k - 1]);
      expect(
        readStreamFrontier(profileId, PROVIDER, "heart-rate")!.syncsSinceAdvance
      ).toBe(k);
      expect(getQuietStreams(profileId)).toEqual([]);
    }
    sync(DAY, "07:12");
    expect(
      readStreamFrontier(profileId, PROVIDER, "heart-rate")!.syncsSinceAdvance
    ).toBe(EVIDENCE);
    expect(getQuietStreams(profileId)).toHaveLength(1);
  });

  it("stays silent for a stream that was not delivering to begin with", () => {
    connect();
    // A single ancient row and nothing on the days behind today: this watch is in a
    // drawer, not on a charger. Without the expected-active gate the row would render
    // every morning forever, because the phone keeps syncing.
    stream("2026-06-01", "12:00");
    sync(DAY, "07:12");
    expect(getQuietStreams(profileId)).toEqual([]);
  });

  it("YIELDS to a provider already reported failing or stale (constraint 7)", () => {
    seedOffWristNight();
    expect(getQuietStreams(profileId)).toHaveLength(1);
    // A dead credential escalates the whole connection. One row names the cause, and
    // it is not this one.
    db.prepare(
      `UPDATE integration_connections SET status = 'needs_reauth'
        WHERE profile_id = ? AND provider = ?`
    ).run(profileId, PROVIDER);
    sync(DAY, "07:20", false);
    expect(getQuietStreams(profileId)).toEqual([]);
  });

  it("says nothing about a provider that is not connected", () => {
    connect("disconnected");
    seedPriorDays();
    stream(YESTERDAY, "21:05");
    sync(DAY, "07:12");
    expect(getQuietStreams(profileId)).toEqual([]);
  });

  it("is profile-scoped — another profile's quiet watch is not mine", () => {
    seedOffWristNight();
    const other = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('QUIET-OTHER')").run()
        .lastInsertRowid
    );
    setTimezone(other, TZ);
    db.prepare(
      `INSERT INTO integration_connections (profile_id, provider, status, config)
       VALUES (?, ?, 'connected', NULL)`
    ).run(other, PROVIDER);
    expect(getQuietStreams(other)).toEqual([]);
    expect(getQuietStreams(profileId)).toHaveLength(1);
  });

  it("ignores another SOURCE's rows on the same table", () => {
    seedOffWristNight();
    // The Fitbit Takeout archive is the app's other hr_minutes writer and declares no
    // continuous stream at all. Its rows must not heal — or cause — a Health Connect
    // gap, so both readers filter on `source`.
    db.prepare(
      `INSERT OR REPLACE INTO hr_minutes (profile_id, ts, bpm, n, source)
       VALUES (?, ?, 61, 60, 'fitbit-takeout')`
    ).run(profileId, utcMinute(zonedWallTimeToUtc(TZ, DAY, "07:20")!));
    expect(getQuietStreams(profileId)).toHaveLength(1);
  });

  it("stores the frontier as the CANONICAL instant, not a wall clock (#2341)", () => {
    // The convention this feature has already been burned by, now on a second column
    // family. `hr_minutes.ts` is a canonical UTC instant since migration 164; the
    // watermark copies it verbatim, so 21:05 in New York is stored as 01:05Z the next
    // day — and the row the user reads still says 21:05. A writer that stored the wall
    // clock, or a reader that took the instant for one, cannot satisfy both.
    seedOffWristNight();
    const frontier = readStreamFrontier(profileId, PROVIDER, "heart-rate")!;
    expect(frontier.frontierAt).toBe("2026-07-15T01:05:00Z");
    expect(frontier.advancedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
    );
    expect(frontier.observedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
    );
    // The advance was observed by the push that carried the rows, and the last look
    // was the morning push — two different questions, two different answers.
    expect(Date.parse(frontier.observedAt)).toBeGreaterThan(
      Date.parse(frontier.advancedAt)
    );
    expect(getQuietStreams(profileId)[0].sinceLocalHhmm).toBe("21:05");
  });
});
