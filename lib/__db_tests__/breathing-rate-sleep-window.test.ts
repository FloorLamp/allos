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
//
// SYNTHETIC ONLY: fictional profiles, invented readings, no PHI.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { parseHealthConnectPayload } from "@/lib/integrations/health-connect";
import { ingestHealthConnectPayload } from "@/lib/integrations/health-connect-ingest";
import { getTimezone, setTimezone } from "@/lib/settings";
import { up as breathingRateMigration } from "@/lib/migrations/versions/20260911-breathing-rate-sleep-samples";
import { BREATHING_RATE_METRIC } from "@/lib/breathing-rate";
import { gatherHistoryLog } from "@/lib/history";

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

describe("the migration is the adoption run over history", () => {
  /** The store as it looked before #5409: stamp-keyed vitals, no nightly samples. */
  function legacyWearableReading(
    profileId: number,
    opts: { date: string; value: number; stamp: string | null; source: string }
  ): void {
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, occurred_at, category, name, canonical_name,
          value, value_num, unit, source, external_id)
       VALUES (?, ?, ?, 'vitals', 'Respiratory Rate', 'Respiratory Rate',
               ?, ?, 'breaths/min', ?, ?)`
    ).run(
      profileId,
      opts.date,
      opts.stamp,
      String(opts.value),
      opts.value,
      opts.source,
      `${opts.source}:Respiratory Rate:${opts.stamp ?? opts.date}`
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
