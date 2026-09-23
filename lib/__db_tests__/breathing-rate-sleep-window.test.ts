// DB INTEGRATION TIER — one breathing rate per night, replaced in place (#5409).
//
// THE DEFECT, IN THE PAYLOADS THAT CAUSED IT. Fitbit computes ONE breathing rate per
// sleep log and writes it to Health Connect stamped at the log's CURRENT end; when it
// extends the log it re-publishes the same reading with a new stamp. The four pushes
// below are the shapes the owner read off the phone on 2026-09-05:
//
//   07:24  the previous night only        05:56 · 13.8  (provisional, no session yet)
//   08:27  02:52 → 07:41                  07:41 · 13.6
//   09:29  02:52 → 07:41, extended after  08:53 · 13.6
//   later  02:52 → 08:53                  08:53 · 13.6
//
// The parser keyed the observation on its STAMP, so each re-stamp was a new
// `medical_records` row and the day's record showed three "Respiratory Rate" lab
// results for one night. On `main` at 0d4f3a441, the first case below stores THREE rows
// and no sample; the fix stores ONE sample and no rows.
//
// WHAT EACH CASE IS FOR:
//   1. the four pushes in order         — the acceptance criterion AND the reproducer;
//                                          pushes 1 to 2 are the provisional case (the
//                                          reading arrives first, its session second)
//   2. the night's own record row        — where the reading is stated now
//   3. a wearable SPOT reading           — what the change deliberately does NOT claim
//   4. a clinical row on the same night  — the discrimination, from the other side
//   5. the migration over a fixture      — three stamps, one stamp, two Takeout days, a
//                                          spot reading and two clinical rows
//   6. the correction round              — the reachable defects PR #5880's
//                                          falsifying passes found, each constructed:
//                                          the #1404 lineage under BOTH foreign-key
//                                          postures, the #133 lock on both branches,
//                                          the origin-aware natural key, and the chart
//                                          that averaged two sources into a third number
//
// SYNTHETIC ONLY: fictional profiles, invented readings, no PHI.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { parseHealthConnectPayload } from "@/lib/integrations/health-connect";
import { ingestHealthConnectPayload } from "@/lib/integrations/health-connect-ingest";
import { getTimezone, setTimezone } from "@/lib/settings";
import { up as breathingRateMigration } from "@/lib/migrations/versions/20260911-breathing-rate-sleep-samples";
import { BREATHING_RATE_METRIC } from "@/lib/breathing-rate";
import { getMetricDailyTotals } from "@/lib/queries/metrics";
import { ALL_ROWS } from "@/lib/trends";
import { gatherHistoryLog } from "@/lib/history";
import { getLastNightSummary } from "@/lib/queries/sleep";
import { adoptWearableBreathingRates } from "@/lib/breathing-rate-db";
import { reportBreathingRateDeclines } from "@/lib/integrations/breathing-rate-report";
import { trackLabFollowUpCore } from "@/lib/followup-write";
import { deleteMetricReading } from "@/lib/metric-readings";
import { followUpItems } from "@/lib/followup-findings";
import { deleteAllDatasetRows } from "@/app/(app)/data/manage-actions";
import { actAs, createLogin } from "@/lib/__action_tests__/harness";

const ORIGIN = "com.fitbit.FitbitMobile";
const WAKE_DAY = "2026-09-05";
const BED = "2026-09-05T02:52:00Z";
const FIRST_WAKE = "2026-09-05T07:41:00Z";
const FINAL_WAKE = "2026-09-05T08:53:00Z";
const PROVISIONAL_STAMP = "2026-09-05T05:56:00Z";
// The night before, which the first push carries instead of this one.
const PRIOR_BED = "2026-09-04T01:10:00Z";
const PRIOR_WAKE = "2026-09-04T07:20:00Z";

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, "UTC");
  return id;
}

interface Push {
  stamp: string;
  sessions?: { start: string; end: string }[];
  breathing?: { time: string; rate: number }[];
}

function push(profileId: number, p: Push): void {
  ingestHealthConnectPayload(
    profileId,
    parseHealthConnectPayload(
      {
        timestamp: p.stamp,
        sleep: (p.sessions ?? []).map((s) => ({
          start_time: s.start,
          end_time: s.end,
          duration_seconds: (Date.parse(s.end) - Date.parse(s.start)) / 1000,
          metadata: { data_origin: ORIGIN },
        })),
        respiratory_rate: (p.breathing ?? []).map((b) => ({
          time: b.time,
          rate: b.rate,
          metadata: { data_origin: ORIGIN },
        })),
      },
      getTimezone(profileId)
    )
  );
}

function nightlyRows(profileId: number) {
  return db
    .prepare(
      `SELECT date, source, origin, started_at, ended_at, value, edited
         FROM metric_samples
        WHERE profile_id = ? AND metric = ?
        ORDER BY started_at`
    )
    .all(profileId, BREATHING_RATE_METRIC) as {
    date: string;
    source: string;
    origin: string | null;
    started_at: string;
    ended_at: string;
    value: number;
    edited: number | null;
  }[];
}

function respiratoryObservations(profileId: number) {
  return db
    .prepare(
      `SELECT id, date, source, occurred_at, value_num, unit, flag, notes, edited
         FROM medical_records
        WHERE profile_id = ? AND canonical_name = 'Respiratory Rate'
        ORDER BY id`
    )
    .all(profileId) as {
    id: number;
    date: string;
    source: string | null;
    occurred_at: string | null;
    value_num: number;
    unit: string | null;
    flag: string | null;
    notes: string | null;
    edited: number | null;
  }[];
}

/** A clinical reading, exactly as the measurements form and a document write one. */
function clinicalReading(
  profileId: number,
  opts: { date: string; value: number; source: string; occurredAt?: string }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, occurred_at, category, name, canonical_name,
            value, value_num, unit, source, flag, notes)
         VALUES (?, ?, ?, 'vitals', 'Respiratory Rate', 'Respiratory Rate',
                 ?, ?, 'breaths/min', ?, 'normal', 'counted at the visit')`
      )
      .run(
        profileId,
        opts.date,
        opts.occurredAt ?? null,
        String(opts.value),
        opts.value,
        opts.source
      ).lastInsertRowid
  );
}

describe("the four payload shapes, in order (#5409 acceptance)", () => {
  it("stores ONE nightly sample on the session, and no observation", () => {
    const profileId = newProfile("Four pushes");

    // 07:24 — the reading is published before Health Connect has the night. Nothing
    // here can call it a night's, so it lands exactly as it always did.
    push(profileId, {
      stamp: "2026-09-05T07:24:00Z",
      sessions: [{ start: PRIOR_BED, end: PRIOR_WAKE }],
      breathing: [{ time: PROVISIONAL_STAMP, rate: 13.8 }],
    });
    expect(respiratoryObservations(profileId)).toHaveLength(1);
    expect(nightlyRows(profileId)).toEqual([]);

    // 08:27 — the session lands, and the reading with it.
    push(profileId, {
      stamp: "2026-09-05T08:27:00Z",
      sessions: [{ start: BED, end: FIRST_WAKE }],
      breathing: [{ time: FIRST_WAKE, rate: 13.6 }],
    });
    expect(nightlyRows(profileId)).toEqual([
      {
        date: WAKE_DAY,
        source: "health-connect",
        origin: ORIGIN,
        started_at: BED,
        ended_at: FIRST_WAKE,
        value: 13.6,
        edited: 0,
      },
    ]);
    // The provisional row was ADOPTED into the night it turned out to belong to — and
    // the night kept the value published at its own end, not the earlier one.
    expect(respiratoryObservations(profileId)).toEqual([]);

    // 09:29 — Fitbit extends the log and re-publishes. REPLACE IN PLACE: the natural
    // key is the session start, so this is an update, not a second row.
    push(profileId, {
      stamp: "2026-09-05T09:29:00Z",
      sessions: [{ start: BED, end: FINAL_WAKE }],
      breathing: [{ time: FINAL_WAKE, rate: 13.6 }],
    });
    // Every later sync re-sends the same thing for 48 hours.
    push(profileId, {
      stamp: "2026-09-05T10:29:00Z",
      sessions: [{ start: BED, end: FINAL_WAKE }],
      breathing: [{ time: FINAL_WAKE, rate: 13.6 }],
    });

    expect(nightlyRows(profileId)).toEqual([
      {
        date: WAKE_DAY,
        source: "health-connect",
        origin: ORIGIN,
        started_at: BED,
        ended_at: FINAL_WAKE,
        value: 13.6,
        edited: 0,
      },
    ]);
    expect(respiratoryObservations(profileId)).toEqual([]);
  });

  it("states the reading on the night's own record row", () => {
    const profileId = newProfile("Night states it");
    push(profileId, {
      stamp: "2026-09-05T09:29:00Z",
      sessions: [{ start: BED, end: FINAL_WAKE }],
      breathing: [{ time: FINAL_WAKE, rate: 13.6 }],
    });
    const loginId = Number(
      db
        .prepare("INSERT INTO logins (username, password_hash) VALUES (?, 'x')")
        .run(`br_${Math.random().toString(36).slice(2, 8)}`).lastInsertRowid
    );
    const sleepRow = gatherHistoryLog(profileId, {
      loginId,
      kind: "sleep",
      day: WAKE_DAY,
      limit: 20,
    }).rows.find((r) => r.kind === "sleep");
    // Quantity, then context, then the source tail: the window, the duration, the
    // reading, the integration.
    expect(sleepRow?.detail).toContain("13.6 br/min");
    expect(sleepRow?.detail.indexOf("13.6 br/min")).toBeGreaterThan(
      sleepRow?.detail.indexOf("6h") ?? -1
    );
  });

  it("states the SAME number on the Sleep page hero, and nothing on a night without one", () => {
    // THE FOURTH SURFACE (#5409, owner ruling 2026-09-11: one cell, only when present).
    // What this pins is not that the hero has a number but that it has THE number the
    // record's Sleep row states for the same night — the hero reads the reading through
    // the same natural key (the main session's start) and the same source election, so
    // the two surfaces cannot disagree about one night (#221).
    const profileId = newProfile("Hero states it");
    push(profileId, {
      stamp: "2026-09-05T09:29:00Z",
      sessions: [{ start: BED, end: FINAL_WAKE }],
      breathing: [{ time: FINAL_WAKE, rate: 13.6 }],
    });
    const summary = getLastNightSummary(profileId);
    expect(summary?.wakeDay).toBe(WAKE_DAY);
    expect(summary?.breathingRateBpm).toBe(13.6);

    // ABSENT, NOT ZERO. A night recorded without the band has no reading, and the cell
    // is not rendered at all — `null` is what makes "only when present" fall out of the
    // field rather than needing a second gate on the surface.
    const bare = newProfile("Hero without one");
    push(bare, {
      stamp: "2026-09-05T09:29:00Z",
      sessions: [{ start: BED, end: FINAL_WAKE }],
    });
    const bareSummary = getLastNightSummary(bare);
    expect(bareSummary?.wakeDay).toBe(WAKE_DAY);
    expect(bareSummary?.breathingRateBpm).toBeNull();
  });

  it("leaves a wearable SPOT reading an observation", () => {
    // A stamped reading with no session around it is not a night's. The parser says so
    // by leaving it where it was, which is what keeps the provisional case above honest.
    const profileId = newProfile("Spot reading");
    push(profileId, {
      stamp: "2026-09-05T14:00:00Z",
      breathing: [{ time: "2026-09-05T13:30:00Z", rate: 18 }],
    });
    expect(nightlyRows(profileId)).toEqual([]);
    expect(respiratoryObservations(profileId)).toMatchObject([
      { source: "health-connect", value_num: 18 },
    ]);
  });
});

describe("a clinical respiratory rate is not touched", () => {
  it("survives the ingest of a wearable reading on the very same night", () => {
    const profileId = newProfile("Clinic and wearable");
    const clinicalId = clinicalReading(profileId, {
      date: WAKE_DAY,
      value: 16,
      source: "manual",
      occurredAt: "2026-09-05T05:00:00Z",
    });
    const documentId = clinicalReading(profileId, {
      date: WAKE_DAY,
      value: 22,
      source: "document:41",
      occurredAt: "2026-09-05T06:00:00Z",
    });
    const before = respiratoryObservations(profileId);

    // Both clinical stamps fall INSIDE the night below, so nothing but the source
    // separates them from the reading that moves. That is the point of the fixture.
    push(profileId, {
      stamp: "2026-09-05T09:29:00Z",
      sessions: [{ start: BED, end: FINAL_WAKE }],
      breathing: [{ time: FINAL_WAKE, rate: 13.6 }],
    });

    expect(nightlyRows(profileId)).toHaveLength(1);
    // Byte for byte: value, flag, note, instant, source, edit lock.
    expect(respiratoryObservations(profileId)).toEqual(before);
    expect(before.map((r) => r.id).sort()).toEqual(
      [clinicalId, documentId].sort()
    );
  });
});

/**
 * The store as it looked before #5409: stamp-keyed vitals, no nightly samples.
 * Returns the row id, which the correction-round cases below attach children to.
 */
function legacyWearableReading(
  profileId: number,
  opts: { date: string; value: number; stamp: string | null; source: string }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_records
         (profile_id, date, occurred_at, category, name, canonical_name,
          value, value_num, unit, source, external_id)
       VALUES (?, ?, ?, 'vitals', 'Respiratory Rate', 'Respiratory Rate',
               ?, ?, 'breaths/min', ?, ?)`
      )
      .run(
        profileId,
        opts.date,
        opts.stamp,
        String(opts.value),
        opts.value,
        opts.source,
        `${opts.source}:Respiratory Rate:${opts.stamp ?? opts.date}`
      ).lastInsertRowid
  );
}

function storedSession(
  profileId: number,
  opts: {
    source: string;
    origin: string | null;
    date: string;
    start: string;
    end: string;
  }
): void {
  db.prepare(
    `INSERT INTO metric_samples
         (profile_id, source, origin, metric, date, started_at, ended_at, value)
       VALUES (?, ?, ?, 'sleep_min', ?, ?, ?, ?)`
  ).run(
    profileId,
    opts.source,
    opts.origin,
    opts.date,
    opts.start,
    opts.end,
    Math.round((Date.parse(opts.end) - Date.parse(opts.start)) / 60000)
  );
}

/** Run the #5409 migration's `up` over the whole store, as the runner does. */
function runBreathingRateMigration(): void {
  breathingRateMigration(
    db as unknown as Parameters<typeof breathingRateMigration>[0]
  );
}

describe("the migration is the adoption run over history", () => {
  it("collapses a three-stamp night, keeps a one-stamp night, places a Takeout day, and leaves the clinic alone", () => {
    const profileId = newProfile("History");

    // A THREE-STAMP NIGHT — the defect itself.
    storedSession(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: WAKE_DAY,
      start: BED,
      end: FINAL_WAKE,
    });
    legacyWearableReading(profileId, {
      date: WAKE_DAY,
      value: 13.8,
      stamp: PROVISIONAL_STAMP,
      source: "health-connect",
    });
    legacyWearableReading(profileId, {
      date: WAKE_DAY,
      value: 13.7,
      stamp: FIRST_WAKE,
      source: "health-connect",
    });
    legacyWearableReading(profileId, {
      date: WAKE_DAY,
      value: 13.6,
      stamp: FINAL_WAKE,
      source: "health-connect",
    });

    // A ONE-STAMP NIGHT — nothing to collapse, and it must come through unchanged.
    storedSession(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: "2026-09-04",
      start: PRIOR_BED,
      end: PRIOR_WAKE,
    });
    legacyWearableReading(profileId, {
      date: "2026-09-04",
      value: 14.2,
      stamp: PRIOR_WAKE,
      source: "health-connect",
    });

    // A TAKEOUT DAY LABEL — no instant at all, and its own archive's session.
    storedSession(profileId, {
      source: "fitbit-takeout",
      origin: null,
      date: "2026-08-30",
      start: "2026-08-30T00:40:00Z",
      end: "2026-08-30T07:10:00Z",
    });
    legacyWearableReading(profileId, {
      date: "2026-08-30",
      value: 15.1,
      stamp: null,
      source: "fitbit-takeout",
    });

    // A TAKEOUT DAY WITH NO SESSION — it still leaves `medical_records`, on the day
    // window the Takeout parser itself writes.
    legacyWearableReading(profileId, {
      date: "2026-08-29",
      value: 15.4,
      stamp: null,
      source: "fitbit-takeout",
    });

    // A WEARABLE SPOT READING — stamped, and no session anywhere near it. It stays.
    legacyWearableReading(profileId, {
      date: "2026-08-28",
      value: 19,
      stamp: "2026-08-28T15:00:00Z",
      source: "health-connect",
    });

    // THE CLINICAL ROWS, one hand-typed and one from a document, both stamped inside
    // the three-stamp night so that only the SOURCE tells them apart.
    const manualId = clinicalReading(profileId, {
      date: WAKE_DAY,
      value: 16,
      source: "manual",
      occurredAt: "2026-09-05T04:00:00Z",
    });
    const documentId = clinicalReading(profileId, {
      date: WAKE_DAY,
      value: 22,
      source: "document:41",
      occurredAt: "2026-09-05T05:30:00Z",
    });
    const clinicalBefore = respiratoryObservations(profileId).filter((r) =>
      [manualId, documentId].includes(r.id)
    );
    expect(clinicalBefore).toHaveLength(2);

    breathingRateMigration(
      db as unknown as Parameters<typeof breathingRateMigration>[0]
    );

    expect(nightlyRows(profileId)).toEqual([
      {
        date: "2026-08-29",
        source: "fitbit-takeout",
        origin: null,
        started_at: "2026-08-29T00:00:00.000Z",
        ended_at: "2026-08-29T23:59:59.999Z",
        value: 15.4,
        edited: 0,
      },
      {
        date: "2026-08-30",
        source: "fitbit-takeout",
        origin: null,
        started_at: "2026-08-30T00:40:00Z",
        ended_at: "2026-08-30T07:10:00Z",
        value: 15.1,
        edited: 0,
      },
      {
        date: "2026-09-04",
        source: "health-connect",
        origin: ORIGIN,
        started_at: PRIOR_BED,
        ended_at: PRIOR_WAKE,
        value: 14.2,
        edited: 0,
      },
      {
        // THE LATEST STAMP SURVIVED, and the two provisional ones did not.
        date: WAKE_DAY,
        source: "health-connect",
        origin: ORIGIN,
        started_at: BED,
        ended_at: FINAL_WAKE,
        value: 13.6,
        edited: 0,
      },
    ]);

    const left = respiratoryObservations(profileId);
    expect(left.map((r) => [r.source, r.value_num])).toEqual([
      // The wearable SPOT reading, which is not a night's...
      ["health-connect", 19],
      // ...and the clinic's two, untouched.
      ["manual", 16],
      ["document:41", 22],
    ]);
    expect(left.filter((r) => [manualId, documentId].includes(r.id))).toEqual(
      clinicalBefore
    );
  });

  it("never adopts one source's reading into another source's session", () => {
    // THE SECOND GATE, ON ITS OWN. The source allowlist keeps a clinical row out of the
    // candidate set; this keeps a wearable row out of a window its own archive never
    // stated. Both have to hold, and a fixture where only one of them could fire proves
    // only that one: here the ONLY session on the day belongs to Health Connect and the
    // only reading to Takeout, so if the match ignored `source` the reading would land
    // on that window — and it must take the day label instead.
    const profileId = newProfile("Two sources");
    storedSession(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: WAKE_DAY,
      start: BED,
      end: FINAL_WAKE,
    });
    legacyWearableReading(profileId, {
      date: WAKE_DAY,
      value: 15.9,
      stamp: null,
      source: "fitbit-takeout",
    });

    breathingRateMigration(
      db as unknown as Parameters<typeof breathingRateMigration>[0]
    );

    expect(nightlyRows(profileId)).toEqual([
      {
        date: WAKE_DAY,
        source: "fitbit-takeout",
        origin: null,
        started_at: `${WAKE_DAY}T00:00:00.000Z`,
        ended_at: `${WAKE_DAY}T23:59:59.999Z`,
        value: 15.9,
        edited: 0,
      },
    ]);
  });

  it("leaves a key the next push UPDATES, not one it duplicates", () => {
    // THE SEAM BETWEEN THE TWO HALVES, and the one place they could disagree silently.
    // The migration writes the row with the SESSION's origin, because a
    // `medical_records` row carries none; the parser writes it with the RESPIRATORY
    // RECORD's own origin. The natural key includes `origin`, so if those two answers
    // could differ the next rolling-window push would insert a SECOND row for the night
    // instead of refreshing the first — the very defect this issue is about, re-created
    // one layer down. They cannot differ for a reading the parser claims (it only
    // claims a session of the same origin), and this is what proves it end to end.
    const profileId = newProfile("Migration then push");
    storedSession(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: WAKE_DAY,
      start: BED,
      end: FINAL_WAKE,
    });
    legacyWearableReading(profileId, {
      date: WAKE_DAY,
      value: 13.6,
      stamp: FINAL_WAKE,
      source: "health-connect",
    });
    breathingRateMigration(
      db as unknown as Parameters<typeof breathingRateMigration>[0]
    );
    expect(nightlyRows(profileId)).toHaveLength(1);

    // The exporter re-sends the last 48 hours, with a corrected value this time.
    push(profileId, {
      stamp: "2026-09-05T12:00:00Z",
      sessions: [{ start: BED, end: FINAL_WAKE }],
      breathing: [{ time: FINAL_WAKE, rate: 13.9 }],
    });
    expect(nightlyRows(profileId)).toEqual([
      {
        date: WAKE_DAY,
        source: "health-connect",
        origin: ORIGIN,
        started_at: BED,
        ended_at: FINAL_WAKE,
        value: 13.9,
        edited: 0,
      },
    ]);
    expect(respiratoryObservations(profileId)).toEqual([]);
  });

  it("moves nothing on a second run", () => {
    // Replay safety, which the DB tier exercises for every migration: after the first
    // pass the only wearable rows left are the spot readings it declines.
    const profileId = newProfile("Replay");
    storedSession(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: WAKE_DAY,
      start: BED,
      end: FINAL_WAKE,
    });
    legacyWearableReading(profileId, {
      date: WAKE_DAY,
      value: 13.6,
      stamp: FINAL_WAKE,
      source: "health-connect",
    });
    const run = () =>
      breathingRateMigration(
        db as unknown as Parameters<typeof breathingRateMigration>[0]
      );
    run();
    const after = nightlyRows(profileId);
    run();
    expect(nightlyRows(profileId)).toEqual(after);
    expect(after).toHaveLength(1);
  });
});

// ── THE CORRECTION ROUND (PR #5880's falsifying pass, owner ruling 2026-09-11) ──────
//
// Reachable defects, each constructed here rather than argued. The move stays; the
// DELETE is what these cases are about.
//
//   1. `medical_record_revisions` — the #1404 correction lineage the ingest itself
//      writes. Proven on BOTH postures: foreign keys OFF (the migration, where a bare
//      delete ORPHANS the child) and ON (runtime, where it DESTROYS it).
//   2. The #133 edit lock on the UPDATE path — a hand correction the adoption dropped
//      because only the insert branch consulted `edited`.
//   3. The lock on the INSERT path — the vendor's later re-stamp used to win the
//      election and then wear the lock, so a locked sample stated a value nobody typed.
//   4. `readSample` read four of the natural key's five columns, so a sample under a
//      DIFFERENT origin at the same start swallowed the adoption.
//   5. The chart averaged two SOURCES into a number neither device reported.

/** The correction lineage rows hanging off one reading, oldest first. */
function revisionsOf(recordId: number) {
  return db
    .prepare(
      `SELECT id, record_id, value_num FROM medical_record_revisions
        WHERE record_id = ? ORDER BY id`
    )
    .all(recordId) as {
    id: number;
    record_id: number;
    value_num: number | null;
  }[];
}

/** Revision rows for `recordId` whose parent is gone — the orphan the ratchet is for. */
function orphanedRevisions(recordId: number) {
  return db
    .prepare(
      `SELECT rev.id FROM medical_record_revisions rev
         LEFT JOIN medical_records mr ON mr.id = rev.record_id
        WHERE rev.record_id = ? AND mr.id IS NULL`
    )
    .all(recordId) as { id: number }[];
}

/** What `insertObservationRevision` writes when a re-send supersedes a stored value. */
function priorState(recordId: number, value: number): void {
  db.prepare(
    `INSERT INTO medical_record_revisions
       (record_id, date, value, value_num, unit, source)
     VALUES (?, '2026-09-05', ?, ?, 'breaths/min', 'health-connect')`
  ).run(recordId, String(value), value);
}

/** The record editor's own write: app/(app)/results/clinical-result-actions.ts. */
function handCorrect(recordId: number, value: number, note: string): void {
  db.prepare(
    `UPDATE medical_records
        SET value = ?, value_num = ?, notes = ?, edited = 1
      WHERE id = ?`
  ).run(String(value), value, note, recordId);
}

describe("a reading with a correction lineage is kept, not orphaned or cascaded", () => {
  it("survives the migration's posture — foreign keys OFF", () => {
    // THE ORPHAN, EXACTLY AS `runner.ts` WOULD PRODUCE IT. `medical_record_revisions`
    // cascades on `medical_records(id)`, and a disabled foreign-key subsystem fires no
    // action at all, so before the fix the reading went and the revision stayed behind
    // pointing at nothing — a dangling reference `PRAGMA foreign_key_check` reports.
    const profileId = newProfile("Lineage, keys off");
    storedSession(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: WAKE_DAY,
      start: BED,
      end: FINAL_WAKE,
    });
    const recordId = legacyWearableReading(profileId, {
      date: WAKE_DAY,
      value: 14.1,
      stamp: PROVISIONAL_STAMP,
      source: "health-connect",
    });
    priorState(recordId, 13.6);

    const fkWasOn = db.pragma("foreign_keys", { simple: true }) === 1;
    if (fkWasOn) db.pragma("foreign_keys = OFF");
    try {
      runBreathingRateMigration();
    } finally {
      if (fkWasOn) db.pragma("foreign_keys = ON");
    }

    expect(orphanedRevisions(recordId)).toEqual([]);
    expect(revisionsOf(recordId).map((r) => r.value_num)).toEqual([13.6]);
    // KEPT, not moved: the lineage cannot follow a reading into `metric_samples`, so
    // the reading stays where its lineage can still reach it.
    expect(
      respiratoryObservations(profileId).map((r) => [r.id, r.value_num])
    ).toEqual([[recordId, 14.1]]);
    expect(nightlyRows(profileId)).toEqual([]);
  });

  it("survives the live push path — foreign keys ON", () => {
    // THE SAME ROW, THROUGH THE SHIPPED INGEST AND NOTHING ELSE. Two pushes on ONE
    // stamp with a corrected rate is what `upsertVitals` -> `insertObservationRevision`
    // is for, and a rolling 48-hour Health Connect window re-sends that stamp routinely.
    // With keys ON the old delete did not orphan the revision, it destroyed it.
    const profileId = newProfile("Lineage, keys on");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    push(profileId, {
      stamp: "2026-09-05T07:24:00Z",
      breathing: [{ time: PROVISIONAL_STAMP, rate: 13.6 }],
    });
    push(profileId, {
      stamp: "2026-09-05T07:40:00Z",
      breathing: [{ time: PROVISIONAL_STAMP, rate: 14.1 }],
    });
    const observations = respiratoryObservations(profileId);
    expect(observations.map((r) => r.value_num)).toEqual([14.1]);
    const recordId = observations[0].id;
    // The ingest wrote the lineage itself — nothing in this test did.
    expect(revisionsOf(recordId).map((r) => r.value_num)).toEqual([13.6]);

    // The session lands, containing that stamp, and carries the night's own reading.
    push(profileId, {
      stamp: "2026-09-05T08:27:00Z",
      sessions: [{ start: BED, end: FIRST_WAKE }],
      breathing: [{ time: FIRST_WAKE, rate: 13.9 }],
    });

    expect(nightlyRows(profileId)).toMatchObject([{ value: 13.9 }]);
    expect(revisionsOf(recordId).map((r) => r.value_num)).toEqual([13.6]);
    expect(respiratoryObservations(profileId).map((r) => r.id)).toEqual([
      recordId,
    ]);
  });
});

describe("the #133 edit lock travels on BOTH branches", () => {
  it("keeps a hand correction the night already has a sample for", () => {
    // THE PATH THE FALSIFYING PASS WALKED, end to end through shipped code: a wearable
    // spot reading, corrected in the record editor (which sets `edited = 1`), then the
    // next push carries the session and the reading. The old update branch dropped
    // every candidate row with no `edited` check at all.
    const profileId = newProfile("Lock, update path");
    push(profileId, {
      stamp: "2026-09-05T07:24:00Z",
      breathing: [{ time: PROVISIONAL_STAMP, rate: 13.8 }],
    });
    const recordId = respiratoryObservations(profileId)[0].id;
    handCorrect(recordId, 17.2, "counted it myself");

    push(profileId, {
      stamp: "2026-09-05T08:27:00Z",
      sessions: [{ start: BED, end: FIRST_WAKE }],
      breathing: [{ time: FIRST_WAKE, rate: 14.1 }],
    });

    // The night states the reading the session published — this branch never overwrites.
    expect(nightlyRows(profileId)).toMatchObject([{ value: 14.1 }]);
    // And the correction is still a reading, with its value, its note and its lock.
    expect(respiratoryObservations(profileId)).toMatchObject([
      { id: recordId, value_num: 17.2, notes: "counted it myself", edited: 1 },
    ]);
  });

  it("adopts the hand-corrected value, not the vendor's later re-stamp", () => {
    // THE INSERT BRANCH. The lock used to be read off the NIGHT (`rows.some(...)`) while
    // the value was elected by stamp, so the vendor's 13.6 was written and then locked:
    // the typed number destroyed, and a value nobody edited wearing the lock that stops
    // the next push from correcting it.
    const profileId = newProfile("Lock, insert path");
    storedSession(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: WAKE_DAY,
      start: BED,
      end: FINAL_WAKE,
    });
    const correctedId = legacyWearableReading(profileId, {
      date: WAKE_DAY,
      value: 13.8,
      stamp: PROVISIONAL_STAMP,
      source: "health-connect",
    });
    handCorrect(correctedId, 17.2, "counted it myself");
    legacyWearableReading(profileId, {
      date: WAKE_DAY,
      value: 13.6,
      stamp: FINAL_WAKE,
      source: "health-connect",
    });

    runBreathingRateMigration();

    expect(nightlyRows(profileId)).toEqual([
      {
        date: WAKE_DAY,
        source: "health-connect",
        origin: ORIGIN,
        started_at: BED,
        ended_at: FINAL_WAKE,
        value: 17.2,
        edited: 1,
      },
    ]);
    // The locked row left `medical_records` because the night now STATES its number —
    // which is the only way a locked row may leave. The unlocked re-stamp went with it.
    expect(respiratoryObservations(profileId)).toEqual([]);
  });
});

describe("the adoption reads the whole natural key", () => {
  it("is not swallowed by a sample at the same start under another origin", () => {
    // `idx_metric_samples_natural` is (profile_id, metric, source, COALESCE(origin,''),
    // start_time). Reading four of those five answered "this night is taken" for a row
    // belonging to a DIFFERENT writing package: the adoption then inserted nothing and
    // deleted the observation anyway — a reading removed and not replaced.
    const profileId = newProfile("Origin-aware key");
    storedSession(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: WAKE_DAY,
      start: BED,
      end: FINAL_WAKE,
    });
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, origin, metric, date, started_at, ended_at, value)
       VALUES (?, 'health-connect', 'com.other.Tracker', ?, ?, ?, ?, 11.1)`
    ).run(profileId, BREATHING_RATE_METRIC, WAKE_DAY, BED, FINAL_WAKE);
    legacyWearableReading(profileId, {
      date: WAKE_DAY,
      value: 13.6,
      stamp: FINAL_WAKE,
      source: "health-connect",
    });

    runBreathingRateMigration();

    expect(
      nightlyRows(profileId)
        .map((r) => [r.origin, r.value])
        .sort()
    ).toEqual([
      [ORIGIN, 13.6],
      ["com.other.Tracker", 11.1],
    ]);
    expect(respiratoryObservations(profileId)).toEqual([]);
  });
});

describe("the body census states one number per night (#5409)", () => {
  function nightlySample(
    profileId: number,
    opts: {
      source: string;
      origin: string | null;
      date: string;
      start: string;
      end: string;
      value: number;
    }
  ): void {
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, origin, metric, date, started_at, ended_at, value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      profileId,
      opts.source,
      opts.origin,
      BREATHING_RATE_METRIC,
      opts.date,
      opts.start,
      opts.end,
      opts.value
    );
  }

  it("states the source rank's number, never an average of two sources", () => {
    // TWO SPELLINGS OF ONE NIGHT: a live Health Connect sync and a Fitbit Takeout
    // archive covering the same week. Averaged they charted 14.8 br/min while the sleep
    // row for that very night read 13.6 · Google Health Connect — a number neither
    // device reported. A real window beats a day label, which is the same rank
    // lib/history.ts already used.
    const profileId = newProfile("Two sources, one night");
    nightlySample(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: WAKE_DAY,
      start: BED,
      end: FINAL_WAKE,
      value: 13.6,
    });
    nightlySample(profileId, {
      source: "fitbit-takeout",
      origin: null,
      date: WAKE_DAY,
      start: `${WAKE_DAY}T00:00:00.000Z`,
      end: `${WAKE_DAY}T23:59:59.999Z`,
      value: 16,
    });

    expect(
      getMetricDailyTotals(profileId, BREATHING_RATE_METRIC, ALL_ROWS)
    ).toEqual([{ date: WAKE_DAY, value: 13.6 }]);
  });

  it("still averages ONE source's nap and night, which is what AVERAGED_METRICS is for", () => {
    // THE REAL 27.2, and the one the registration is registered for. Two sessions of
    // one source in one wake day are two rows on two session starts; the additive
    // default would chart their SUM. Two sources never reach that default together —
    // the SUM path elects one per day — which is what made the old comment false.
    const profileId = newProfile("One source, two sleeps");
    nightlySample(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: WAKE_DAY,
      start: BED,
      end: FIRST_WAKE,
      value: 13,
    });
    nightlySample(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: WAKE_DAY,
      start: "2026-09-05T14:00:00Z",
      end: "2026-09-05T15:30:00Z",
      value: 14,
    });

    expect(
      getMetricDailyTotals(profileId, BREATHING_RATE_METRIC, ALL_ROWS)
    ).toEqual([{ date: WAKE_DAY, value: 13.5 }]);
  });
});

// ---- THE FOLLOW-UP A PERSON TRACKED TRAVELS WITH THE READING (#5409, option 4) ----
//
// THE PATH, driven through production write cores rather than asserted: an ordinary
// night flags `low` against the curated clinical 12-20 band (`reconcileFlags` has no
// source filter), the results page offers "Track follow-up" on any out-of-range
// reading, one tap runs `trackLabFollowUpCore`, and the reading is now named by
// `care_plan_items.source_medical_record_id` — a NO ACTION link. Before this round the
// adoption then either orphaned it (migration posture, keys off) or raised
// SQLITE_CONSTRAINT_FOREIGNKEY inside the whole profile's push (runtime, keys on).
//
// THE FIXTURE IS THE REAL MIGRATED SCHEMA, deliberately. The DB tier's `db` has every
// migration applied, so `PRAGMA foreign_key_list` reads the REFERENCES clauses the app
// actually ships. A fixture that builds child tables by hand — the repo's own
// `childTablesDdl` exemplar emits bare `INTEGER` columns with no `REFERENCES` — reads
// zero inbound links, refuses nothing, and passes every "the row survived" assertion
// vacuously.

/** The care-plan row a tap on "Track follow-up" leaves behind. */
function followUpRow(carePlanItemId: number) {
  return db
    .prepare(
      `SELECT source_kind, source_medical_record_id, source_metric_sample_id,
              resolved_by_medical_record_id, resolved_by_metric_sample_id
         FROM care_plan_items WHERE id = ?`
    )
    .get(carePlanItemId) as {
    source_kind: string | null;
    source_medical_record_id: number | null;
    source_metric_sample_id: number | null;
    resolved_by_medical_record_id: number | null;
    resolved_by_metric_sample_id: number | null;
  };
}

/** Whatever `PRAGMA foreign_key_check` can see right now. */
function fkViolations() {
  return db.pragma("foreign_key_check") as unknown[];
}

function trackFollowUp(profileId: number, recordId: number): number {
  const outcome = trackLabFollowUpCore(profileId, recordId, 90, "2026-09-06");
  if (outcome.kind !== "created")
    throw new Error(`follow-up not created: ${outcome.kind}`);
  return outcome.carePlanItemId;
}

describe("a tracked follow-up is carried onto the night's sample", () => {
  it("moves the reference, in the migration's posture — foreign keys OFF", () => {
    const profileId = newProfile("Carry, keys off");
    storedSession(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: WAKE_DAY,
      start: BED,
      end: FINAL_WAKE,
    });
    const provisional = legacyWearableReading(profileId, {
      date: WAKE_DAY,
      value: 17.9,
      stamp: PROVISIONAL_STAMP,
      source: "health-connect",
    });
    const finalStamp = legacyWearableReading(profileId, {
      date: WAKE_DAY,
      value: 11.4,
      stamp: FINAL_WAKE,
      source: "health-connect",
    });
    // The tap lands on the reading the person was shown — the final one.
    const carePlanItemId = trackFollowUp(profileId, finalStamp);
    expect(followUpRow(carePlanItemId).source_medical_record_id).toBe(
      finalStamp
    );

    const before = fkViolations().length;
    const fkWasOn = db.pragma("foreign_keys", { simple: true }) === 1;
    if (fkWasOn) db.pragma("foreign_keys = OFF");
    try {
      runBreathingRateMigration();
    } finally {
      if (fkWasOn) db.pragma("foreign_keys = ON");
    }

    const nights = nightlyRows(profileId);
    expect(nights).toMatchObject([{ value: 11.4, date: WAKE_DAY }]);
    const sampleId = (
      db
        .prepare(
          `SELECT id FROM metric_samples
            WHERE profile_id = ? AND metric = ? ORDER BY id DESC LIMIT 1`
        )
        .get(profileId, BREATHING_RATE_METRIC) as { id: number }
    ).id;
    // CARRIED: the reference names the night's sample, the old link is cleared, and the
    // discriminator says which adapter reads it now.
    expect(followUpRow(carePlanItemId)).toEqual({
      source_kind: "breathing-rate",
      source_medical_record_id: null,
      source_metric_sample_id: sampleId,
      resolved_by_medical_record_id: null,
      resolved_by_metric_sample_id: null,
    });
    // Both observations left, and nothing dangles: this is the exact state the old
    // delete produced a `foreign_key_check` finding for.
    expect(respiratoryObservations(profileId)).toEqual([]);
    expect(fkViolations().length).toBe(before);
    expect(provisional).toBeGreaterThan(0);
  });

  it("moves it on the live push path, where the delete used to throw", () => {
    // RUNTIME POSTURE, keys ON, through the shipped ingest. The old bare
    // `DELETE FROM medical_records` raised SQLITE_CONSTRAINT_FOREIGNKEY here, and
    // because `remove()` runs inside one `writeTx`, ONE linked row failed the whole
    // profile's adoption — every later push failing identically.
    const profileId = newProfile("Carry, keys on");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    push(profileId, {
      stamp: "2026-09-05T07:24:00Z",
      breathing: [{ time: PROVISIONAL_STAMP, rate: 11.4 }],
    });
    const observation = respiratoryObservations(profileId)[0];
    const carePlanItemId = trackFollowUp(profileId, observation.id);

    // The session lands and contains that stamp: the reading is adopted into the night.
    push(profileId, {
      stamp: "2026-09-05T08:27:00Z",
      sessions: [{ start: BED, end: FIRST_WAKE }],
    });

    const nights = nightlyRows(profileId);
    expect(nights).toMatchObject([{ value: 11.4 }]);
    const carried = followUpRow(carePlanItemId);
    expect(carried.source_medical_record_id).toBeNull();
    expect(carried.source_kind).toBe("breathing-rate");
    expect(carried.source_metric_sample_id).not.toBeNull();
    expect(respiratoryObservations(profileId)).toEqual([]);
  });

  it("keeps rendering as a follow-up once carried, rather than degrading", () => {
    // THE POINT OF CARRYING. A freed link leaves a live "Recheck …" as an ordinary
    // care-plan item; a carried one stays the follow-up it was, on the metric page
    // where its reading now lives.
    const profileId = newProfile("Carry, still a follow-up");
    storedSession(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: WAKE_DAY,
      start: BED,
      end: FINAL_WAKE,
    });
    const recordId = legacyWearableReading(profileId, {
      date: WAKE_DAY,
      value: 11.4,
      stamp: FINAL_WAKE,
      source: "health-connect",
    });
    trackFollowUp(profileId, recordId);
    runBreathingRateMigration();

    const items = followUpItems(profileId, "2026-12-01");
    expect(items).toHaveLength(1);
    expect(items[0].title).toContain("Recheck breathing rate");
    expect(items[0].href).toBe("/trends/metric/breathing-rate");
  });
});

/**
 * A carried follow-up over its night's sample: the state every case below deletes out
 * from under. Built the way the carry cases above build it -- the stored session, the
 * legacy wearable reading, one tap on "Track follow-up", then the adoption.
 */
function carriedFollowUp(name: string): {
  profileId: number;
  carePlanItemId: number;
  sampleId: number;
} {
  const profileId = newProfile(name);
  storedSession(profileId, {
    source: "health-connect",
    origin: ORIGIN,
    date: WAKE_DAY,
    start: BED,
    end: FINAL_WAKE,
  });
  const recordId = legacyWearableReading(profileId, {
    date: WAKE_DAY,
    value: 11.4,
    stamp: FINAL_WAKE,
    source: "health-connect",
  });
  const carePlanItemId = trackFollowUp(profileId, recordId);
  runBreathingRateMigration();
  const carried = followUpRow(carePlanItemId);
  expect(carried.source_kind).toBe("breathing-rate");
  expect(carried.source_metric_sample_id).not.toBeNull();
  return {
    profileId,
    carePlanItemId,
    sampleId: carried.source_metric_sample_id as number,
  };
}

describe("deleting the carried sample frees the WHOLE link", () => {
  it("nulls the discriminator with the id on the ordinary delete path", () => {
    // THE HOUSE RULE, WHICH THE FOREIGN-KEY ACTION CANNOT KEEP ON ITS OWN. Every other
    // source kind frees `source_kind` together with its source id at a hand seam
    // (lib/followup-write.ts), and migration 184 exists to repair rows that did not.
    // So the ordinary delete -- the readings table's Delete on the breathing-rate
    // detail page, and the Data -> Manage bulk delete behind the same capture -- runs
    // the seam first, and `ON DELETE SET NULL` is left as the backstop for a path that
    // has none.
    const { profileId, carePlanItemId, sampleId } =
      carriedFollowUp("Delete, seam");

    const outcome = deleteMetricReading(profileId, "breathing-rate", sampleId);
    expect(outcome.ok).toBe(true);

    expect(followUpRow(carePlanItemId)).toEqual({
      source_kind: null,
      source_medical_record_id: null,
      source_metric_sample_id: null,
      resolved_by_medical_record_id: null,
      resolved_by_metric_sample_id: null,
    });
    // The item is still there -- a freed link degrades the follow-up to the plain
    // care-plan item it now is, it does not delete the person's planned care.
    expect(
      db
        .prepare("SELECT description FROM care_plan_items WHERE id = ?")
        .get(carePlanItemId)
    ).toBeTruthy();
    expect(followUpItems(profileId, "2026-12-01")).toEqual([]);
  });

  it("frees it on Data \u2192 Manage's Delete all, which takes no capture", async () => {
    // A PERSON-REACHABLE DELETE OF A SAMPLE THAT IS NOT A CAPTURE. Metric
    // samples are a deletable dataset (DELETE_POLICY in lib/export.ts), so Data \u2192
    // Manage offers "Delete all" beside the row checkboxes. The selected-rows delete
    // routes through captureDelete and inherits the seam; "Delete all" is deliberately
    // never undoable, so it wipes the table directly and reaches the row with no seam
    // ahead of it -- landing on exactly the state the positive control below shows.
    // Four `source_*` pairs older than this one are NO ACTION. Until #5966 the same
    // button THREW on the two of them a deletable dataset reaches; it now runs the
    // domain seam here too, so what the SET NULL pair buys this one is narrower than
    // it was: not that the wipe completes, but that a path with no seam at all leaves
    // a dangling discriminator instead of a rollback.
    const { profileId, carePlanItemId } = carriedFollowUp("Delete all, seam");
    const login = createLogin();
    db.prepare(
      "INSERT OR IGNORE INTO login_profiles (login_id, profile_id) VALUES (?, ?)"
    ).run(login.id, profileId);
    actAs(login, { id: profileId, name: "Delete all, seam" });

    const res = await deleteAllDatasetRows("metric_samples");
    expect(res.ok).toBe(true);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM metric_samples WHERE profile_id = ?"
        )
        .get(profileId)
    ).toEqual({ c: 0 });

    expect(followUpRow(carePlanItemId)).toEqual({
      source_kind: null,
      source_medical_record_id: null,
      source_metric_sample_id: null,
      resolved_by_medical_record_id: null,
      resolved_by_metric_sample_id: null,
    });
    // Same degradation the row delete gives: the planned care survives, the finding
    // linkage does not.
    expect(
      db
        .prepare("SELECT description FROM care_plan_items WHERE id = ?")
        .get(carePlanItemId)
    ).toBeTruthy();
    expect(followUpItems(profileId, "2026-12-01")).toEqual([]);
    expect(fkViolations().length).toBe(0);
  });

  it("positive control: the backstop alone leaves the discriminator standing", () => {
    // WHAT THE ASSERTION ABOVE IS OBSERVING. `ON DELETE SET NULL` can only null the
    // column it is declared on, so a delete that reaches the row without the seam ends
    // exactly here: `source_kind` naming an adapter over an all-null source. Without
    // this case the first one could pass over a schema that never wrote the
    // discriminator at all.
    const { profileId, carePlanItemId, sampleId } =
      carriedFollowUp("Delete, backstop");

    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.prepare(
      "DELETE FROM metric_samples WHERE id = ? AND profile_id = ?"
    ).run(sampleId, profileId);

    expect(followUpRow(carePlanItemId)).toEqual({
      source_kind: "breathing-rate",
      source_medical_record_id: null,
      source_metric_sample_id: null,
      resolved_by_medical_record_id: null,
      resolved_by_metric_sample_id: null,
    });
    // It dangles rather than throwing, which is the half the action does buy.
    expect(fkViolations().length).toBe(0);
  });
});

describe("a link it cannot carry declines the night, and names it", () => {
  it("leaves the night alone and reports which link held it", () => {
    // `intake_items.source_record_id` is a NO ACTION link into `medical_records`
    // with nowhere on a sample to carry it to. The rule is
    // not a list — `blockingInboundLinks` reads it out of the schema — so a link nobody
    // remembered holds its night just as loudly as one that was thought about.
    const profileId = newProfile("Decline, intake link");
    storedSession(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: WAKE_DAY,
      start: BED,
      end: FINAL_WAKE,
    });
    const recordId = legacyWearableReading(profileId, {
      date: WAKE_DAY,
      value: 12.9,
      stamp: FINAL_WAKE,
      source: "health-connect",
    });
    db.prepare(
      `INSERT INTO intake_items (profile_id, kind, name, source_record_id)
       VALUES (?, 'medication', 'Fictional tablet', ?)`
    ).run(profileId, recordId);

    const before = fkViolations().length;
    const result = adoptWearableBreathingRates(db, profileId);

    expect(result).toMatchObject({ adopted: 0, removed: 0, carried: 0 });
    expect(result.declined).toEqual([
      { held_by: "intake_items.source_record_id", nights: 1, rows: 1 },
    ]);
    expect(nightlyRows(profileId)).toEqual([]);
    expect(respiratoryObservations(profileId).map((r) => r.id)).toEqual([
      recordId,
    ]);
    expect(fkViolations().length).toBe(before);
  });
});

describe("the night is elected over every row it has", () => {
  it("never publishes the superseded provisional because a later row was filtered out", () => {
    // THE DEFECT THIS CLOSES, reproduced on the PR head unmodified: the candidate query
    // held a row with a #1404 correction lineage OUT of the set, and the set is a
    // RANKED election. Planting a revision on the FINAL re-stamp elected the superseded
    // provisional (17.9) and wrote it to the night, while the correct 11.4 stayed in
    // `medical_records` as the follow-up's source — the sleep hero, the record's Sleep
    // row and the chart all stating a number the vendor had already replaced.
    const profileId = newProfile("Election, lineage on the final stamp");
    storedSession(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: WAKE_DAY,
      start: BED,
      end: FINAL_WAKE,
    });
    const provisional = legacyWearableReading(profileId, {
      date: WAKE_DAY,
      value: 17.9,
      stamp: PROVISIONAL_STAMP,
      source: "health-connect",
    });
    const finalStamp = legacyWearableReading(profileId, {
      date: WAKE_DAY,
      value: 11.4,
      stamp: FINAL_WAKE,
      source: "health-connect",
    });
    priorState(finalStamp, 11.9);

    const result = adoptWearableBreathingRates(db, profileId);

    // The night declines WHOLE: nothing it states can be the superseded number, and
    // nothing is removed either, so the lineage keeps the row it hangs off.
    expect(nightlyRows(profileId).map((r) => r.value)).toEqual([]);
    expect(result).toMatchObject({ adopted: 0, removed: 0 });
    // `rows` is the rows the reason itself held (#6002); both rows still stay, below.
    expect(result.declined).toEqual([
      { held_by: "medical_record_revisions", nights: 1, rows: 1 },
    ]);
    expect(respiratoryObservations(profileId).map((r) => r.id)).toEqual([
      provisional,
      finalStamp,
    ]);
    expect(revisionsOf(finalStamp).map((r) => r.value_num)).toEqual([11.9]);
  });

  it("still collapses a neighbouring night that carries no lineage", () => {
    // The decline is the NIGHT's, not the profile's: a clean night beside a held one
    // is adopted in the same run.
    const profileId = newProfile("Election, one held night and one clean");
    storedSession(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: WAKE_DAY,
      start: BED,
      end: FINAL_WAKE,
    });
    const held = legacyWearableReading(profileId, {
      date: WAKE_DAY,
      value: 11.4,
      stamp: FINAL_WAKE,
      source: "health-connect",
    });
    priorState(held, 11.9);
    storedSession(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: "2026-09-04",
      start: PRIOR_BED,
      end: PRIOR_WAKE,
    });
    legacyWearableReading(profileId, {
      date: "2026-09-04",
      value: 14.2,
      stamp: PRIOR_WAKE,
      source: "health-connect",
    });

    const result = adoptWearableBreathingRates(db, profileId);

    expect(result).toMatchObject({ adopted: 1, removed: 1 });
    expect(nightlyRows(profileId).map((r) => r.value)).toEqual([14.2]);
    expect(respiratoryObservations(profileId).map((r) => r.id)).toEqual([held]);
  });
});

describe("the move is bounded, like every write into the stream store", () => {
  it("declines a night whose elected reading is a mistyped zero", () => {
    // THE PATH, through shipped code: the record editor takes a hand-typed value
    // VERBATIM (no bounds, app/(app)/results/clinical-result-actions.ts) and stamps
    // `edited = 1`, and a locked row is elected ahead of the vendor's own stamp. So a
    // "0" typed over a wearable reading is exactly the value that reaches the move —
    // and `formatBreathingRate(0)` returns a truthy "0 br/min", so the hero and the
    // chart would both state it. The 3–80 envelope is the same one the parsers apply.
    const profileId = newProfile("Bounds, mistyped zero");
    storedSession(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: WAKE_DAY,
      start: BED,
      end: FINAL_WAKE,
    });
    const recordId = legacyWearableReading(profileId, {
      date: WAKE_DAY,
      value: 13.6,
      stamp: FINAL_WAKE,
      source: "health-connect",
    });
    handCorrect(recordId, 0, "typed by hand");

    const result = adoptWearableBreathingRates(db, profileId);

    expect(nightlyRows(profileId)).toEqual([]);
    expect(result).toMatchObject({ adopted: 0, removed: 0 });
    expect(result.declined).toEqual([
      { held_by: "out-of-bounds value", nights: 1, rows: 1 },
    ]);
    // The person's own number is left exactly where they typed it.
    expect(
      respiratoryObservations(profileId).map((r) => [r.id, r.value_num])
    ).toEqual([[recordId, 0]]);
  });

  it("still adopts a hand correction inside the envelope, lock and all", () => {
    const profileId = newProfile("Bounds, plausible correction");
    storedSession(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: WAKE_DAY,
      start: BED,
      end: FINAL_WAKE,
    });
    const recordId = legacyWearableReading(profileId, {
      date: WAKE_DAY,
      value: 13.6,
      stamp: FINAL_WAKE,
      source: "health-connect",
    });
    handCorrect(recordId, 12.5, "the tracker read high");

    adoptWearableBreathingRates(db, profileId);

    expect(nightlyRows(profileId)).toMatchObject([{ value: 12.5, edited: 1 }]);
  });
});

describe("a decline is disclosed where the person can see it", () => {
  it("writes one sync event, says it again only when it changes", () => {
    // A REFUSAL NOBODY CAN SEE IS NOT A POSTURE. Under the refuse-by-default design
    // this round rejected, `PRAGMA foreign_key_check` came back clean, the runner's
    // boot warning fired on nothing and the runtime logged only on error — strictly
    // MORE silent than the dangling reference it replaced. Data → Review is where the
    // rest of "what this push did and did not do" already lives.
    const profileId = newProfile("Decline, disclosed");
    storedSession(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: WAKE_DAY,
      start: BED,
      end: FINAL_WAKE,
    });
    const recordId = legacyWearableReading(profileId, {
      date: WAKE_DAY,
      value: 12.9,
      stamp: FINAL_WAKE,
      source: "health-connect",
    });
    db.prepare(
      `INSERT INTO intake_items (profile_id, kind, name, source_record_id)
       VALUES (?, 'medication', 'Fictional tablet', ?)`
    ).run(profileId, recordId);
    const events = () =>
      db
        .prepare(
          `SELECT ok, skipped, details FROM integration_sync_events
            WHERE profile_id = ? ORDER BY id`
        )
        .all(profileId) as {
        ok: number;
        skipped: number | null;
        details: string | null;
      }[];

    const first = adoptWearableBreathingRates(db, profileId);
    reportBreathingRateDeclines(profileId, "health-connect", first);
    expect(events()).toEqual([
      {
        ok: 1, // nothing FAILED — the night is intact, and a red badge would be a lie
        skipped: 1,
        details:
          "breathing rate: 1 night(s) left in medical records — intake_items.source_record_id (1)",
      },
    ]);

    // The next push re-derives the same answer, because the decline is permanent by
    // construction. One row per sync forever would drown the log it is written in.
    reportBreathingRateDeclines(
      profileId,
      "health-connect",
      adoptWearableBreathingRates(db, profileId)
    );
    expect(events()).toHaveLength(1);

    // A SECOND held night is a different answer, and says so.
    storedSession(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: "2026-09-04",
      start: PRIOR_BED,
      end: PRIOR_WAKE,
    });
    const second = legacyWearableReading(profileId, {
      date: "2026-09-04",
      value: 13.1,
      stamp: PRIOR_WAKE,
      source: "health-connect",
    });
    db.prepare(
      `INSERT INTO intake_items (profile_id, kind, name, source_record_id)
       VALUES (?, 'medication', 'Second fictional tablet', ?)`
    ).run(profileId, second);
    reportBreathingRateDeclines(
      profileId,
      "health-connect",
      adoptWearableBreathingRates(db, profileId)
    );
    const after = events();
    expect(after).toHaveLength(2);
    expect(after[1].details).toContain("2 night(s)");
  });
});

// Fixture days relative to today (#6002, #6008): the adoption reads no clock, so the
// profile's timezone is what pins every wake day below.
const dayOffset = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe("the adoption keys a night on its origin too (#6002)", () => {
  it("adopts two origins that share a source and a start as two nights", () => {
    // Two packages recording a session from the same instant. A day-labelled row takes
    // the short one (its wake day's only session); a stamped row lands inside the long
    // one alone. Keyed without the origin, both became ONE target filed under
    // whichever origin came first, and the long session's reading was lost into it.
    const profileId = newProfile("Two origins, one start");
    const shortDay = dayOffset(-3);
    const longDay = dayOffset(-2);
    const start = `${shortDay}T22:00:00.000Z`;
    storedSession(profileId, {
      source: "health-connect",
      origin: "app.one",
      date: shortDay,
      start,
      end: `${shortDay}T23:30:00.000Z`,
    });
    storedSession(profileId, {
      source: "health-connect",
      origin: "app.two",
      date: longDay,
      start,
      end: `${longDay}T07:00:00.000Z`,
    });
    legacyWearableReading(profileId, {
      date: shortDay,
      value: 12.2,
      stamp: null,
      source: "health-connect",
    });
    legacyWearableReading(profileId, {
      date: longDay,
      value: 14.4,
      stamp: `${longDay}T06:00:00.000Z`,
      source: "health-connect",
    });

    const result = adoptWearableBreathingRates(db, profileId);

    expect(result).toMatchObject({ adopted: 2, removed: 2, declined: [] });
    expect(
      nightlyRows(profileId)
        .map((r) => [r.origin, r.date, r.value])
        .sort()
    ).toEqual([
      ["app.one", shortDay, 12.2],
      ["app.two", longDay, 14.4],
    ]);
  });
});

describe("a night held for two reasons reports each one (#6002)", () => {
  it("counts each reason's own rows", () => {
    const profileId = newProfile("Decline, two reasons");
    const day = dayOffset(-2);
    const bed = `${dayOffset(-3)}T23:00:00.000Z`;
    const wake = `${day}T07:00:00.000Z`;
    storedSession(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: day,
      start: bed,
      end: wake,
    });
    const stamps = ["03:00", "05:00", "07:00"].map(
      (t) => `${day}T${t}:00.000Z`
    );
    const [linkedA, linkedB, revised] = stamps.map((stamp) =>
      legacyWearableReading(profileId, {
        date: day,
        value: 13.5,
        stamp,
        source: "health-connect",
      })
    );
    for (const recordId of [linkedA, linkedB])
      db.prepare(
        `INSERT INTO intake_items (profile_id, kind, name, source_record_id)
         VALUES (?, 'medication', 'Fictional tablet', ?)`
      ).run(profileId, recordId);
    priorState(revised, 13.1);

    const result = adoptWearableBreathingRates(db, profileId);

    expect(result).toMatchObject({ adopted: 0, removed: 0 });
    expect(result.declined).toEqual([
      { held_by: "intake_items.source_record_id", nights: 1, rows: 2 },
      { held_by: "medical_record_revisions", nights: 1, rows: 1 },
    ]);
    expect(respiratoryObservations(profileId)).toHaveLength(3);
  });
});

describe("the adoption reads sessions by wake day, not the whole history (#6008)", () => {
  it("still finds a night filed two days after its stamp's UTC day", () => {
    // The far edge of the bound: a stamp at the START of a 23-hour session whose end
    // falls on the next local day again at UTC+14.
    const profileId = newProfile("Bounded sessions, far edge");
    setTimezone(profileId, "Pacific/Kiritimati");
    const stampDay = dayOffset(-5);
    const wakeDay = dayOffset(-3);
    const start = `${stampDay}T11:00:00.000Z`;
    const end = `${dayOffset(-4)}T10:00:00.000Z`;
    storedSession(profileId, {
      source: "health-connect",
      origin: ORIGIN,
      date: wakeDay,
      start,
      end,
    });
    legacyWearableReading(profileId, {
      date: stampDay,
      value: 13.3,
      stamp: start,
      source: "health-connect",
    });

    expect(adoptWearableBreathingRates(db, profileId)).toMatchObject({
      adopted: 1,
      removed: 1,
    });
    expect(
      nightlyRows(profileId).map((r) => [r.date, r.started_at, r.value])
    ).toEqual([[wakeDay, start, 13.3]]);
  });
});
