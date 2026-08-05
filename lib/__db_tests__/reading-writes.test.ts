// DB INTEGRATION TIER — the reading write core (#2032, phase 2 of #1997).
//
// Three things are proven here, and they are the three the issue asks for:
//
//  1. PLACEMENT IS REAL. A reading submitted by IDENTITY lands in the store the policy
//     names, and reads back through `getReadingSeries` — so the write half and the read
//     half of the model agree about where a quantity lives.
//  2. NOTHING MOVED. The store-specific writers migrated onto the core produce the rows
//     they produced before, column for column, for today's inputs. The registry the
//     write path used to resolve a store from (`METRIC_READING_STORE`) is cross-checked
//     against the policy that replaced it.
//  3. THE CONTRACT IS ONE CONTRACT. Edit and delete route by the row's store handle
//     across all three stores, with typed refusals where a target names nothing — which
//     is what makes a folded clinical observation correctable on a stream metric's page.
//
// Plus the invariant that must survive all of it: an edit-locked imported row is not
// overwritten by a source re-push, and the upsert accounting is the shared one.
//
// All fixtures SYNTHETIC.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { emptyCounts } from "@/lib/integrations/sync-log";
import { METRIC_READING_STORE } from "@/lib/metric-readings";
import { JUDGED_METRIC_SLUGS, METRIC_KNOWLEDGE } from "@/lib/metric-judgment";
import {
  placeReading,
  readingTarget,
  type ReadingTarget,
} from "@/lib/reading-placement";
import {
  deleteReadingAt,
  recordReading,
  recordReadings,
  updateReadingAt,
} from "@/lib/reading-writes";
import { getReadingSeries } from "@/lib/queries/readings";
import { insertVitals } from "@/lib/offline/writes";
import { saveFitnessEntry } from "@/lib/fitness-assessment";
import { seedProfile, type SeededProfile } from "./fixtures";

let p: SeededProfile;
// A clinical ENCOUNTER, so a reading can carry the provenance that forces the
// observation store without carrying a document (which belongs to the import core).
let encounterId: number;

beforeAll(() => {
  p = seedProfile("READING-WRITES");
  encounterId = Number(
    db
      .prepare(
        `INSERT INTO encounters (profile_id, date, type, reason) VALUES (?, '2026-01-06', 'office', 'annual')`
      )
      .run(p.profileId).lastInsertRowid
  );
});

describe("the placement policy against the registry it replaces", () => {
  it("reproduces METRIC_READING_STORE for every judged metric", () => {
    // THE "nothing moved" cross-check. The registry the write path used to resolve a
    // store from, and the policy that now decides, answer identically — so a surface
    // moved onto the core cannot start writing somewhere new.
    for (const slug of JUDGED_METRIC_SLUGS) {
      const knowledge = METRIC_KNOWLEDGE[slug];
      if (knowledge.source !== "canonical") continue;
      expect(placeReading({ name: knowledge.canonical }).placed).toEqual(
        METRIC_READING_STORE[slug]
      );
    }
  });
});

describe("a reading submitted by identity lands where the policy says", () => {
  it("streams a plain resting heart rate into body_metrics", () => {
    const outcome = recordReading(p.profileId, {
      name: "Resting Heart Rate",
      value: 54,
      unit: "bpm",
      date: "2026-01-05",
      source: "manual",
    });
    expect(outcome).toMatchObject({
      ok: true,
      store: "body_metrics",
      disposition: "inserted",
    });
    const row = db
      .prepare(
        `SELECT resting_hr, weight_kg, body_fat_pct, source FROM body_metrics
          WHERE profile_id = ? AND date = '2026-01-05'`
      )
      .get(p.profileId) as Record<string, unknown>;
    expect(row).toEqual({
      resting_hr: 54,
      // The other measures of the wide row are untouched — a reading of one quantity
      // says nothing about the others.
      weight_kg: null,
      body_fat_pct: null,
      source: "manual",
    });
  });

  it("files the SAME identity as an observation when it carries provenance", () => {
    // Clause 2: a clinic-measured resting heart rate keeps its provenance, so it goes to
    // the observation store even though the identity has a registered stream.
    const outcome = recordReading(p.profileId, {
      name: "Resting Heart Rate",
      value: 61,
      unit: "bpm",
      date: "2026-01-06",
      category: "vitals",
      provenance: { encounterId, reportedRange: "60-100 bpm" },
    });
    expect(outcome).toMatchObject({ ok: true, store: "medical_records" });
    const row = db
      .prepare(
        `SELECT canonical_name, value_num, unit, encounter_id, reference_range
           FROM medical_records WHERE profile_id = ? AND date = '2026-01-06'`
      )
      .get(p.profileId) as Record<string, unknown>;
    expect(row).toEqual({
      canonical_name: "Resting Heart Rate",
      value_num: 61,
      unit: "bpm",
      encounter_id: encounterId,
      reference_range: "60-100 bpm",
    });
  });

  it("refuses a DOCUMENT-linked reading, which belongs to the import core", () => {
    // The import-footprint contract (#453/#422): a document_id-bearing row must be
    // written by persistDocumentImport or clear / reassign / the extracted counts cannot
    // see it. The core refuses rather than dropping the link.
    expect(
      recordReading(p.profileId, {
        name: "Oxygen Saturation",
        value: 96,
        unit: "%",
        date: "2026-01-06",
        provenance: { documentId: p.documentId },
      })
    ).toEqual({ ok: false, error: "document-import" });
  });

  it("brings both back as ONE series, keyed by identity", () => {
    // The write half and the read half agree: the stream row and the clinical record are
    // the same quantity, so the surface that asks for the quantity gets both.
    const series = getReadingSeries(p.profileId, "Resting Heart Rate").filter(
      (r) => r.date === "2026-01-05" || r.date === "2026-01-06"
    );
    expect(series.map((r) => [r.date, r.value, r.store])).toEqual([
      ["2026-01-05", 54, "body_metrics"],
      ["2026-01-06", 61, "medical_records"],
    ]);
  });

  it("refuses a quantity with no reading identity rather than guessing", () => {
    expect(recordReading(p.profileId, {
      name: "",
      value: 1,
      unit: "",
      date: "2026-01-07",
    })).toEqual({ ok: false, error: "unplaceable" });
    expect(recordReading(p.profileId, {
      name: "Resting Heart Rate",
      value: Number.NaN,
      unit: "bpm",
      date: "2026-01-07",
    })).toEqual({ ok: false, error: "invalid" });
  });

  it("folds a second measure of the same day onto one row", () => {
    recordReading(p.profileId, {
      name: "Body Fat Percentage",
      value: 21.5,
      unit: "%",
      date: "2026-01-05",
      source: "manual",
    });
    const rows = db
      .prepare(
        `SELECT resting_hr, body_fat_pct FROM body_metrics
          WHERE profile_id = ? AND date = '2026-01-05'`
      )
      .all(p.profileId);
    // ONE row for the day and source, carrying both measures — the shape a wide store
    // has to keep, and the reason the core writes one column rather than the triple.
    expect(rows).toEqual([{ resting_hr: 54, body_fat_pct: 21.5 }]);
  });
});

describe("the shared upsert accounting", () => {
  it("classifies insert / update / unchanged through the substrate", () => {
    const counts = emptyCounts();
    const one = {
      name: "Resting Heart Rate",
      value: 58,
      unit: "bpm",
      date: "2026-02-01",
      source: "oura",
    };
    recordReadings(p.profileId, [one], counts);
    recordReadings(p.profileId, [one], counts); // same value again → unchanged
    recordReadings(p.profileId, [{ ...one, value: 59 }], counts); // → updated
    expect(counts.inserted).toBe(1);
    expect(counts.unchanged).toBe(1);
    expect(counts.updated).toBe(1);
    expect(
      db
        .prepare(
          `SELECT resting_hr FROM body_metrics
            WHERE profile_id = ? AND date = '2026-02-01' AND source = 'oura'`
        )
        .get(p.profileId)
    ).toEqual({ resting_hr: 59 });
  });

  it("holds a source re-push out of an edit-locked row, and counts the lock", () => {
    // #133: the user hand-corrected this row, so the next rolling window must not
    // silently restore the wrong number.
    db.prepare(
      `UPDATE body_metrics SET edited = 1
        WHERE profile_id = ? AND date = '2026-02-01' AND source = 'oura'`
    ).run(p.profileId);
    const counts = emptyCounts();
    const outcomes = recordReadings(
      p.profileId,
      [
        {
          name: "Resting Heart Rate",
          value: 44,
          unit: "bpm",
          date: "2026-02-01",
          source: "oura",
        },
      ],
      counts
    );
    expect(outcomes[0]).toEqual({ ok: false, error: "edit-locked" });
    // Its OWN counter, parallel to `suppressed` — a lock is visible in Review rather
    // than hiding as an ordinary no-op (#659).
    expect(counts.edited).toBe(1);
    expect(counts.inserted + counts.updated + counts.unchanged).toBe(0);
    expect(
      db
        .prepare(
          `SELECT resting_hr FROM body_metrics
            WHERE profile_id = ? AND date = '2026-02-01' AND source = 'oura'`
        )
        .get(p.profileId)
    ).toEqual({ resting_hr: 59 });
  });

  it("still lets the USER correct their own locked row", () => {
    // The lock is about a SOURCE re-push. A person re-entering a value they previously
    // fixed is not a sync, and refusing there would strand them.
    const outcome = recordReading(p.profileId, {
      name: "Resting Heart Rate",
      value: 57,
      unit: "bpm",
      date: "2026-02-02",
      source: "manual",
    });
    expect(outcome).toMatchObject({ ok: true, disposition: "inserted" });
    db.prepare(
      `UPDATE body_metrics SET edited = 1
        WHERE profile_id = ? AND date = '2026-02-02' AND source = 'manual'`
    ).run(p.profileId);
    expect(
      recordReading(p.profileId, {
        name: "Resting Heart Rate",
        value: 56,
        unit: "bpm",
        date: "2026-02-02",
        source: "manual",
      })
    ).toMatchObject({ ok: true, disposition: "updated" });
  });
});

describe("the migrated writers produce the rows they produced before", () => {
  it("insertVitals writes the same medical_records row through the core", () => {
    expect(
      insertVitals(p.profileId, "2026-03-01", { spo2: "97", systolic: "", diastolic: "" })
    ).toBe(true);
    const row = db
      .prepare(
        `SELECT category, name, canonical_name, value, value_num, unit, source,
                external_id, notes, document_id, encounter_id, provider_id, flag
           FROM medical_records
          WHERE profile_id = ? AND date = '2026-03-01'`
      )
      .get(p.profileId) as Record<string, unknown>;
    expect(row).toEqual({
      category: "vitals",
      name: "Oxygen Saturation",
      canonical_name: "Oxygen Saturation",
      // The stored `value` is the stringified number, as it always was.
      value: "97",
      value_num: 97,
      unit: "%",
      source: "manual",
      // NULL so a same-window Health Connect push never matches this row.
      external_id: null,
      notes: null,
      document_id: null,
      encounter_id: null,
      provider_id: null,
      // Derived by the SAME reconcileFlags the record editor calls — 97% is in range.
      flag: null,
    });
  });

  it("a fitness `vital` test still writes its canonical observation", () => {
    expect(
      saveFitnessEntry(p.profileId, {
        date: "2026-03-02",
        testKey: "grip",
        value: 41,
      })
    ).toMatchObject({ ok: true });
    const row = db
      .prepare(
        `SELECT category, canonical_name, value, value_num, unit, source, external_id
           FROM medical_records
          WHERE profile_id = ? AND date = '2026-03-02' AND canonical_name = 'Grip Strength'`
      )
      .get(p.profileId);
    expect(row).toEqual({
      category: "vitals",
      canonical_name: "Grip Strength",
      value: "41",
      value_num: 41,
      unit: "kg",
      source: "manual",
      external_id: null,
    });
  });

  it("a fitness `body` test still folds onto one manual day row", () => {
    // The behaviour the old hand-written COALESCE upsert existed for: body fat and
    // resting HR entered in one session share the day's row, and neither blanks the
    // other.
    expect(
      saveFitnessEntry(p.profileId, {
        date: "2026-03-03",
        testKey: "bodyfat",
        value: 19,
      })
    ).toMatchObject({ ok: true });
    expect(
      saveFitnessEntry(p.profileId, {
        date: "2026-03-03",
        testKey: "restinghr",
        value: 52,
      })
    ).toMatchObject({ ok: true });
    expect(
      db
        .prepare(
          `SELECT weight_kg, body_fat_pct, resting_hr, source FROM body_metrics
            WHERE profile_id = ? AND date = '2026-03-03'`
        )
        .all(p.profileId)
    ).toEqual([
      { weight_kg: null, body_fat_pct: 19, resting_hr: 52, source: "manual" },
    ]);
  });
});

describe("one editability contract across the stores", () => {
  function seedObservation(canonical: string, date: string, value: number) {
    return Number(
      db
        .prepare(
          `INSERT INTO medical_records
             (profile_id, date, category, name, value, value_num, unit, canonical_name, source)
           VALUES (?, ?, 'vitals', ?, ?, ?, 'bpm', ?, 'manual')`
        )
        .run(p.profileId, date, canonical, String(value), value, canonical)
        .lastInsertRowid
    );
  }

  it("corrects an observation reached from a STREAM metric's surface", () => {
    // The residual #1999 recorded and #2032 closes: this row is listed on
    // /trends/metric/resting-hr, whose own store is body_metrics, and it is corrected in
    // place because the row — not the page — names the store.
    const id = seedObservation("Resting Heart Rate", "2026-04-01", 70);
    const folded = getReadingSeries(p.profileId, "Resting Heart Rate").find(
      (r) => r.rowId === id && r.store === "medical_records"
    );
    expect(folded).toBeDefined();
    const target = readingTarget(folded!);
    expect(target).toEqual({
      store: "medical_records",
      id,
      identity: "Resting Heart Rate",
    });
    expect(updateReadingAt(p.profileId, target!, 66)).toEqual({ ok: true });
    expect(
      db
        .prepare(
          `SELECT value, value_num FROM medical_records WHERE id = ? AND profile_id = ?`
        )
        .get(id, p.profileId)
    ).toEqual({ value: "66", value_num: 66 });
  });

  it("corrects a body_metrics row and a metric_samples row by the same call", () => {
    const bodyId = Number(
      db
        .prepare(
          `INSERT INTO body_metrics (profile_id, date, resting_hr, source) VALUES (?, '2026-04-02', 63, 'manual')`
        )
        .run(p.profileId).lastInsertRowid
    );
    expect(
      updateReadingAt(
        p.profileId,
        { store: "body_metrics", id: bodyId, column: "resting_hr" },
        62
      )
    ).toEqual({ ok: true });
    expect(
      db.prepare(`SELECT resting_hr FROM body_metrics WHERE id = ?`).get(bodyId)
    ).toEqual({ resting_hr: 62 });

    const sampleId = Number(
      db
        .prepare(
          `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
           VALUES (?, 'manual', 'hrv_ms', '2026-04-02', '2026-04-02T00:00:00', '2026-04-02T00:00:00', 40)`
        )
        .run(p.profileId).lastInsertRowid
    );
    expect(
      updateReadingAt(
        p.profileId,
        { store: "metric_samples", id: sampleId, metric: "hrv_ms" },
        44
      )
    ).toEqual({ ok: true });
    expect(
      db.prepare(`SELECT value, edited FROM metric_samples WHERE id = ?`).get(sampleId)
    ).toEqual({ value: 44, edited: 1 });
  });

  it("matches an observation target by IDENTITY, not by exact canonical string", () => {
    // The generalization: "which identity am I", not "which table am I". An A1c row is
    // reachable through any spelling that families with it.
    const id = Number(
      db
        .prepare(
          `INSERT INTO medical_records
             (profile_id, date, category, name, value, value_num, unit, canonical_name, source)
           VALUES (?, '2026-04-03', 'lab', 'Hemoglobin A1c', '5.4', 5.4, '%', 'Hemoglobin A1c', 'manual')`
        )
        .run(p.profileId).lastInsertRowid
    );
    expect(
      updateReadingAt(
        p.profileId,
        { store: "medical_records", id, identity: "family:hemoglobin-a1c" },
        5.6
      )
    ).toEqual({ ok: true });
  });

  it("refuses a target that names nothing, in every store", () => {
    const missing: ReadingTarget[] = [
      { store: "body_metrics", id: 999999, column: "resting_hr" },
      { store: "metric_samples", id: 999999, metric: "hrv_ms" },
      { store: "medical_records", id: 999999, identity: "Oxygen Saturation" },
    ];
    for (const target of missing) {
      expect(updateReadingAt(p.profileId, target, 10)).toEqual({
        ok: false,
        error: "not-found",
      });
      expect(deleteReadingAt(p.profileId, target)).toEqual({
        ok: false,
        undoId: null,
      });
    }
    expect(
      updateReadingAt(
        p.profileId,
        { store: "body_metrics", id: 1, column: "resting_hr" },
        Number.NaN
      )
    ).toEqual({ ok: false, error: "invalid" });
  });

  it("refuses an observation target whose identity is a different quantity", () => {
    // The row exists and belongs to this profile, but it is not a reading of the
    // identity the target claims — so the write misses rather than corrupting a
    // neighbouring analyte.
    const id = seedObservation("Respiratory Rate", "2026-04-04", 16);
    expect(
      updateReadingAt(
        p.profileId,
        { store: "medical_records", id, identity: "Oxygen Saturation" },
        95
      )
    ).toEqual({ ok: false, error: "not-found" });
  });

  it("never writes across profiles", () => {
    const other = seedProfile("READING-WRITES-B");
    const id = seedObservation("Body Temperature", "2026-04-05", 98.6);
    expect(
      updateReadingAt(
        other.profileId,
        { store: "medical_records", id, identity: "Body Temperature" },
        99
      )
    ).toEqual({ ok: false, error: "not-found" });
  });
});

describe("delete routes by the row too", () => {
  it("clears ONE measure off a shared day row, keeping the others", () => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO body_metrics (profile_id, date, weight_kg, resting_hr, source)
           VALUES (?, '2026-05-01', 80, 60, 'manual')`
        )
        .run(p.profileId).lastInsertRowid
    );
    expect(
      deleteReadingAt(p.profileId, {
        store: "body_metrics",
        id,
        column: "resting_hr",
      })
    ).toEqual({ ok: true, undoId: null });
    expect(
      db.prepare(`SELECT weight_kg, resting_hr FROM body_metrics WHERE id = ?`).get(id)
    ).toEqual({ weight_kg: 80, resting_hr: null });
  });

  it("captures an undoable delete for a folded clinical observation", () => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO medical_records
             (profile_id, date, category, name, value, value_num, unit, canonical_name, source)
           VALUES (?, '2026-05-02', 'vitals', 'Resting Heart Rate', '71', 71, 'bpm', 'Resting Heart Rate', 'manual')`
        )
        .run(p.profileId).lastInsertRowid
    );
    const outcome = deleteReadingAt(p.profileId, {
      store: "medical_records",
      id,
      identity: "Resting Heart Rate",
    });
    expect(outcome.ok).toBe(true);
    // Undoable, so the toast can restore it — the same capture the biomarker surfaces use.
    expect(outcome.undoId).toBeGreaterThan(0);
    expect(
      db.prepare(`SELECT id FROM medical_records WHERE id = ?`).get(id)
    ).toBeUndefined();
  });

  it("tombstones a deleted sample so a resync can't resurrect it", () => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
           VALUES (?, 'oura', 'hrv_ms', '2026-05-03', '2026-05-03T00:00:00', '2026-05-03T00:00:00', 38)`
        )
        .run(p.profileId).lastInsertRowid
    );
    expect(
      deleteReadingAt(p.profileId, {
        store: "metric_samples",
        id,
        metric: "hrv_ms",
      })
    ).toEqual({ ok: true, undoId: null });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM import_tombstones WHERE profile_id = ? AND target_table = 'metric_samples'`
        )
        .get(p.profileId)
    ).toEqual({ n: 1 });
  });
});
