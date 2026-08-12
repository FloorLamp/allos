// DB INTEGRATION TIER — the body_metrics stated instant (#2235, below migration 165).
//
// What is pinned here, per the issue's own test list:
//
//   • a TIMED submission round-trips date + instant (canonical utcInstant shape);
//   • an UNTIMED one stores NULL and reads back day-grain — never a midnight anchor;
//   • a SECOND submission of the same day UPDATES the stated time on the SAME row
//     (the manual find-then-write: a resubmission corrects the sitting, it does not
//     stack a second weigh-in — one row per day stays, decision 6);
//   • an EMPTY Time on a submission that writes a value CLEARS the column, while a
//     time-blind caller (undefined) leaves it alone;
//   • a stated time whose profile-local date disagrees with the row's `date` is
//     REFUSED — the reading lands, the statement is dropped, the row is never
//     re-dated, and an already-stored honest statement is never clobbered;
//   • two measures entered in one sitting land on ONE row sharing the one
//     occurred_at — through the form core and through the reading write core's
//     find-then-write, both pinned against this change;
//   • the #133 edit lock behaves for occurred_at exactly as for a value: a source
//     re-push cannot overwrite an edited row's stated time (constraint 1).
//
// The #2091/#1999 column-set pin (lib/__db_tests__/reading-series.test.ts) already
// names `occurred_at` — updated deliberately by the migration PR (#2246), its one
// legitimate edit path — so this file asserts behavior, not schema.
//
// All fixtures SYNTHETIC; dates sit in the past so the acceptance gate's future
// check (real clock — the db tier does not freeze time) can never fire.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import {
  insertBodyMetric,
  type BodyMetricWriteOutcome,
} from "@/lib/offline/writes";
import { recordReading } from "@/lib/reading-writes";
import {
  logFoodServingCore,
  updateFoodLogEventCore,
} from "@/lib/food-log-write";
import { getReadingSeries } from "@/lib/queries/readings";
import { getManualBodyMetricStatedAt } from "@/lib/queries";

let profileId: number;

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  // Deterministic acceptance-gate math: the stated instants below are on their
  // row's day in UTC, whatever zone the host happens to run in.
  db.prepare(
    "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', 'UTC')"
  ).run(id);
  return id;
}

function manualRows(date: string) {
  return db
    .prepare(
      `SELECT id, weight_kg, body_fat_pct, resting_hr, notes, occurred_at
         FROM body_metrics
        WHERE profile_id = ? AND date = ? AND source IS NULL ORDER BY id`
    )
    .all(profileId, date) as {
    id: number;
    weight_kg: number | null;
    body_fat_pct: number | null;
    resting_hr: number | null;
    notes: string | null;
    occurred_at: string | null;
  }[];
}

// Every body_metrics row this profile owns — the cheap "nothing else was written"
// check behind #2311's no-chase-me assertion.
function manualRowCount(): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM body_metrics WHERE profile_id = ?")
      .get(profileId) as { n: number }
  ).n;
}

function submit(
  date: string,
  over: Partial<Parameters<typeof insertBodyMetric>[1]> = {}
): BodyMetricWriteOutcome {
  return insertBodyMetric(profileId, {
    date,
    weight: null,
    weightUnit: "kg",
    bodyFatPct: null,
    restingHr: null,
    notes: null,
    ...over,
  });
}

beforeAll(() => {
  profileId = newProfile("BM-OCCURRED-AT");
});

describe("the manual submission core (insertBodyMetric)", () => {
  it("round-trips a timed submission: the day AND the canonical instant", () => {
    expect(
      submit("2026-04-01", {
        weight: "80",
        // Millisecond ISO in — the shape a client's toISOString() posts.
        occurredAt: "2026-04-01T07:12:00.000Z",
      })
      // An ACCEPTED statement reports nothing: `statedTimeRefused` is absent, not
      // merely falsy (#2311 — the outcome must not invent a notice out of silence).
    ).toEqual({ wrote: true });
    const rows = manualRows("2026-04-01");
    expect(rows).toHaveLength(1);
    // Normalized to lib/date.ts's utcInstant shape (second resolution, `Z`),
    // never stored in the caller's serialization (constraint 4).
    expect(rows[0].occurred_at).toBe("2026-04-01T07:12:00Z");
    expect(rows[0].weight_kg).toBeCloseTo(80, 6);
    // The seed read the form reopens with sees the same statement.
    expect(getManualBodyMetricStatedAt(profileId, "2026-04-01")).toBe(
      "2026-04-01T07:12:00Z"
    );
  });

  it("stores NULL for an untimed submission, which reads back day-grain", () => {
    // Nobody stated a time, so there is nothing to report either (`unstated` is
    // NOT `refused` — the distinction #2296 introduced and #2311 carries here).
    expect(submit("2026-04-02", { restingHr: "55" })).toEqual({ wrote: true });
    const rows = manualRows("2026-04-02");
    expect(rows).toHaveLength(1);
    // Honest absence — never a `${date}T00:00:00` anchor (decision 2; the
    // asymmetry with metric_samples is deliberate).
    expect(rows[0].occurred_at).toBeNull();
    const reading = getReadingSeries(profileId, "Resting Heart Rate").find(
      (r) => r.date === "2026-04-02" && r.store === "body_metrics"
    );
    expect(reading).toBeDefined();
    expect(reading!.measuredAt).toBeNull();
  });

  it("updates the stated time on the SAME row on a second submission", () => {
    submit("2026-04-03", {
      weight: "80",
      occurredAt: "2026-04-03T07:00:00Z",
    });
    const before = manualRows("2026-04-03");
    expect(before).toHaveLength(1);
    submit("2026-04-03", {
      weight: "80.4",
      occurredAt: "2026-04-03T21:30:00Z",
    });
    const after = manualRows("2026-04-03");
    // One row per day stays: the resubmission corrected the sitting, it did not
    // stack a second weigh-in (decision 6).
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].occurred_at).toBe("2026-04-03T21:30:00Z");
    expect(after[0].weight_kg).toBeCloseTo(80.4, 6);
  });

  it("clears the column on a submission whose Time was explicitly emptied", () => {
    submit("2026-04-04", {
      weight: "80",
      occurredAt: "2026-04-04T07:00:00Z",
    });
    submit("2026-04-04", { weight: "80.2", occurredAt: null });
    const rows = manualRows("2026-04-04");
    expect(rows).toHaveLength(1);
    expect(rows[0].occurred_at).toBeNull();
  });

  it("a time-blind caller (undefined) never destroys a stated time", () => {
    submit("2026-04-05", {
      weight: "80",
      occurredAt: "2026-04-05T07:00:00Z",
    });
    // Telegram / palette / a pre-#2235 queued intent: no occurredAt at all.
    submit("2026-04-05", { restingHr: "54" });
    const rows = manualRows("2026-04-05");
    expect(rows).toHaveLength(1);
    expect(rows[0].occurred_at).toBe("2026-04-05T07:00:00Z");
    expect(rows[0].resting_hr).toBe(54);
    expect(rows[0].weight_kg).toBeCloseTo(80, 6);
  });

  // #2311 — the refusal must be SAYABLE, not merely survivable. The gate has answered
  // a verdict since #2296; this core used to answer `boolean`, which could report that
  // the reading landed and nothing else, so a phone whose clock ran past the
  // five-minute tolerance kept its weigh-in and quietly lost the "when".
  it("REPORTS a refused statement while keeping the reading (#2311)", () => {
    const before = manualRowCount();
    const outcome = submit("2099-06-01", {
      weight: "77.5",
      // Beyond STATED_FUTURE_SKEW_MS by decades — the `future` rule, which the gate
      // checks first, so the reason is deterministic against the db tier's real clock.
      occurredAt: "2099-06-01T12:00:00Z",
    });
    // A NOTICE, not a validation failure: the write succeeded AND says what it lost.
    expect(outcome).toEqual({ wrote: true, statedTimeRefused: "future" });

    const rows = manualRows("2099-06-01");
    expect(rows).toHaveLength(1);
    expect(rows[0].weight_kg).toBeCloseTo(77.5, 6);
    // Honest absence, never a partially-kept instant and never a re-dated row.
    expect(rows[0].occurred_at).toBeNull();

    // And NOTHING is persisted to chase the user later (#2296's ruling, re-affirmed):
    // no second row, no edit flag, no marker — just the reading, on its own day.
    expect(manualRowCount()).toBe(before + 1);
    const stored = db
      .prepare(
        `SELECT source, edited FROM body_metrics
          WHERE profile_id = ? AND date = '2099-06-01'`
      )
      .all(profileId) as { source: string | null; edited: number | null }[];
    expect(stored).toEqual([{ source: null, edited: 0 }]);
  });

  it("REFUSES a stated time off the row's own date — the reading still lands", () => {
    // Fresh insert: statement dropped, row stays honestly untimed, never re-dated —
    // and the outcome names the rule that fired (#2311), which is the day rule here
    // and not the clock, so the surface never blames the wrong machine.
    expect(
      submit("2026-04-06", {
        weight: "79.5",
        occurredAt: "2026-04-07T01:00:00Z",
      })
    ).toEqual({ wrote: true, statedTimeRefused: "other-day" });
    const fresh = manualRows("2026-04-06");
    expect(fresh).toHaveLength(1);
    expect(fresh[0].occurred_at).toBeNull();
    expect(fresh[0].weight_kg).toBeCloseTo(79.5, 6);
    expect(manualRows("2026-04-07")).toHaveLength(0);

    // Update: a mismatched statement must not clobber the honest one already
    // stored (refused ⇒ no statement, not a clear).
    submit("2026-04-06", {
      weight: "79.6",
      occurredAt: "2026-04-06T08:30:00Z",
    });
    submit("2026-04-06", {
      weight: "79.7",
      occurredAt: "2026-04-05T08:30:00Z",
    });
    const after = manualRows("2026-04-06");
    expect(after[0].occurred_at).toBe("2026-04-06T08:30:00Z");
    expect(after[0].weight_kg).toBeCloseTo(79.7, 6);
  });

  it("lands two measures of one sitting on ONE row sharing the one occurred_at", () => {
    submit("2026-04-08", {
      weight: "80.1",
      bodyFatPct: "19.5",
      restingHr: "53",
      notes: "morning, fasted",
      occurredAt: "2026-04-08T06:45:00Z",
    });
    const rows = manualRows("2026-04-08");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      body_fat_pct: 19.5,
      resting_hr: 53,
      notes: "morning, fasted",
      occurred_at: "2026-04-08T06:45:00Z",
    });
  });

  it("a metric-scoped resubmission never blanks the sitting's note", () => {
    // The single-metric forms carry no notes field: their null note is absence,
    // not an instruction to clear the morning weigh-in's note.
    submit("2026-04-09", {
      weight: "80",
      notes: "post-run",
      occurredAt: "2026-04-09T18:00:00Z",
    });
    submit("2026-04-09", { bodyFatPct: "19.2" });
    const rows = manualRows("2026-04-09");
    expect(rows).toHaveLength(1);
    expect(rows[0].notes).toBe("post-run");
    expect(rows[0].occurred_at).toBe("2026-04-09T18:00:00Z");
  });

  it("finds only the MANUAL row: a source-owned day row is never touched", () => {
    db.prepare(
      `INSERT INTO body_metrics (profile_id, date, weight_kg, source, occurred_at)
       VALUES (?, '2026-04-10', 81, 'withings', NULL)`
    ).run(profileId);
    submit("2026-04-10", { weight: "80", occurredAt: "2026-04-10T07:05:00Z" });
    const manual = manualRows("2026-04-10");
    expect(manual).toHaveLength(1);
    expect(manual[0].occurred_at).toBe("2026-04-10T07:05:00Z");
    const synced = db
      .prepare(
        `SELECT weight_kg, occurred_at FROM body_metrics
          WHERE profile_id = ? AND date = '2026-04-10' AND source = 'withings'`
      )
      .get(profileId) as { weight_kg: number; occurred_at: string | null };
    expect(synced).toEqual({ weight_kg: 81, occurred_at: null });
    // And the form's seed read answers from the manual row, not the synced one.
    expect(getManualBodyMetricStatedAt(profileId, "2026-04-10")).toBe(
      "2026-04-10T07:05:00Z"
    );
  });
});

describe("the reading write core (recordReading) — find-then-write pinned", () => {
  it("shares one occurred_at across two measures recorded in one sitting", () => {
    const at = "2026-04-12T06:50:00Z";
    const a = recordReading(profileId, {
      name: "Body Fat Percentage",
      value: 19.1,
      unit: "%",
      date: "2026-04-12",
      source: "manual",
      occurredAt: at,
    });
    const b = recordReading(profileId, {
      name: "Resting Heart Rate",
      value: 52,
      unit: "bpm",
      date: "2026-04-12",
      source: "manual",
      occurredAt: at,
    });
    expect(a).toMatchObject({ ok: true, store: "body_metrics" });
    expect(b).toMatchObject({ ok: true, store: "body_metrics" });
    const rows = db
      .prepare(
        `SELECT id, body_fat_pct, resting_hr, occurred_at FROM body_metrics
          WHERE profile_id = ? AND date = '2026-04-12'`
      )
      .all(profileId) as Record<string, unknown>[];
    // The find-then-write: one row for the day and source, both measures on it,
    // ONE stated instant describing the sitting.
    expect(rows).toEqual([
      {
        id: rows[0].id,
        body_fat_pct: 19.1,
        resting_hr: 52,
        occurred_at: at,
      },
    ]);
    // And the unified series presents the instant (decision 7's mapping,
    // end-to-end through lib/queries/readings.ts).
    const reading = getReadingSeries(profileId, "Resting Heart Rate").find(
      (r) => r.date === "2026-04-12" && r.store === "body_metrics"
    );
    expect(reading!.measuredAt).toBe(at);
  });

  it("updates a stated time even when the value is unchanged, and clears on null", () => {
    const write = (occurredAt: string | null | undefined) =>
      recordReading(profileId, {
        name: "Resting Heart Rate",
        value: 51,
        unit: "bpm",
        date: "2026-04-13",
        source: "manual",
        occurredAt,
      });
    write("2026-04-13T07:00:00Z");
    // Same value, new statement — re-stating WHEN is a statement about the row.
    expect(write("2026-04-13T21:00:00Z")).toMatchObject({
      ok: true,
      disposition: "unchanged",
    });
    const at = () =>
      (
        db
          .prepare(
            `SELECT occurred_at FROM body_metrics
              WHERE profile_id = ? AND date = '2026-04-13' AND source = 'manual'`
          )
          .get(profileId) as { occurred_at: string | null }
      ).occurred_at;
    expect(at()).toBe("2026-04-13T21:00:00Z");
    // undefined leaves it; null clears it.
    write(undefined);
    expect(at()).toBe("2026-04-13T21:00:00Z");
    write(null);
    expect(at()).toBeNull();
  });

  it("#133: a source re-push cannot overwrite an edited row's stated time", () => {
    recordReading(profileId, {
      name: "Resting Heart Rate",
      value: 50,
      unit: "bpm",
      date: "2026-04-14",
      source: "oura",
      occurredAt: "2026-04-14T06:30:00Z",
    });
    // The user hand-corrects the row (the Review resolver's post-image).
    db.prepare(
      `UPDATE body_metrics SET resting_hr = 49, edited = 1
        WHERE profile_id = ? AND date = '2026-04-14' AND source = 'oura'`
    ).run(profileId);
    const outcome = recordReading(profileId, {
      name: "Resting Heart Rate",
      value: 55,
      unit: "bpm",
      date: "2026-04-14",
      source: "oura",
      occurredAt: "2026-04-14T23:00:00Z",
    });
    expect(outcome).toEqual({ ok: false, error: "edit-locked" });
    const row = db
      .prepare(
        `SELECT resting_hr, occurred_at FROM body_metrics
          WHERE profile_id = ? AND date = '2026-04-14' AND source = 'oura'`
      )
      .get(profileId) as Record<string, unknown>;
    // The lock holds the WHOLE re-push out — value and stated time alike.
    expect(row).toEqual({
      resting_hr: 49,
      occurred_at: "2026-04-14T06:30:00Z",
    });
  });

  it("a source updating its own UN-edited row updates its stated time too", () => {
    recordReading(profileId, {
      name: "Resting Heart Rate",
      value: 50,
      unit: "bpm",
      date: "2026-04-15",
      source: "oura",
      occurredAt: "2026-04-15T06:30:00Z",
    });
    recordReading(profileId, {
      name: "Resting Heart Rate",
      value: 51,
      unit: "bpm",
      date: "2026-04-15",
      source: "oura",
      occurredAt: "2026-04-15T06:45:00Z",
    });
    const row = db
      .prepare(
        `SELECT resting_hr, occurred_at, edited FROM body_metrics
          WHERE profile_id = ? AND date = '2026-04-15' AND source = 'oura'`
      )
      .get(profileId) as Record<string, unknown>;
    // Its own row: the update is not an edit, so no lock is minted by it.
    expect(row).toEqual({
      resting_hr: 51,
      occurred_at: "2026-04-15T06:45:00Z",
      edited: 0,
    });
  });
});

// #2311 / #2296 — ONE gate, TWO postures, and the difference is the CALLER's.
//
// This is the property both issues turn on, so it is asserted as one thing rather
// than inferred from two files: the identical refusal costs only the STATEMENT on a
// log path (the reading is the point; the minute is descriptive) and costs the WHOLE
// WRITE on a correction path (the statement IS the submission — a silent clear there
// would be the surface answering a question the user did not ask).
describe("what a refusal COSTS stays the caller's", () => {
  it("keeps the body-metric reading, refuses the food correction", () => {
    const day = "2026-05-10";
    const offDay = "2026-05-11";

    // LOG PATH: the reading lands, and the refusal comes back as something to say.
    expect(
      submit(day, { weight: "78.2", occurredAt: `${offDay}T08:00:00Z` })
    ).toEqual({ wrote: true, statedTimeRefused: "other-day" });
    const logged = manualRows(day);
    expect(logged).toHaveLength(1);
    expect(logged[0].weight_kg).toBeCloseTo(78.2, 6);
    expect(logged[0].occurred_at).toBeNull();

    // CORRECTION PATH: the same class of refusal, and nothing is written at all.
    logFoodServingCore(
      profileId,
      "berries",
      day,
      `${day}T09:00:00Z`,
      "Morning"
    );
    const eventId = (
      db
        .prepare(
          `SELECT id FROM food_log_events WHERE profile_id = ? AND date = ?
            ORDER BY id DESC LIMIT 1`
        )
        .get(profileId, day) as { id: number }
    ).id;
    expect(
      updateFoodLogEventCore(profileId, eventId, {
        eatenAt: new Date(`${offDay}T19:00:00Z`),
      })
    ).toEqual({ kind: "invalid-eaten-at", reason: "other-day" });
    const event = db
      .prepare(
        `SELECT occurred_at, time_source FROM food_log_events
          WHERE id = ? AND profile_id = ?`
      )
      .get(eventId, profileId) as {
      occurred_at: string | null;
      time_source: string | null;
    };
    // Never a silent clear: the row is exactly as the tap left it.
    expect(event).toEqual({ occurred_at: null, time_source: null });
  });
});
