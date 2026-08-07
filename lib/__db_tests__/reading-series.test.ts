// DB INTEGRATION TIER — the unified reading series (#1997 phase 1).
//
// One identity, rows in TWO stores, one series: a wearable resting HR from
// `body_metrics` and a clinic-measured "Resting Heart Rate" from `medical_records`
// come back together, deduped, with provenance preserved on the observation and
// ABSENT on the stream row.
//
// It also pins the migration-free guarantee this phase promised: the model is a
// read layer, so the three stores' columns are exactly what they were.
//
// All fixtures SYNTHETIC.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  getObservationReadings,
  getReadingSeries,
  getStreamReadings,
} from "@/lib/queries/readings";
import {
  STREAM_READING_SOURCES,
  readingIdentity,
  type StreamReadingSource,
} from "@/lib/reading-model";
import { seedProfile, type SeededProfile } from "./fixtures";

let p: SeededProfile;
let other: SeededProfile;
let spellings: SeededProfile;
let d: (n: number) => string;
const IDENTITY = readingIdentity("Resting Heart Rate");
const RHR = STREAM_READING_SOURCES.find(
  (s) => s.canonical === "Resting Heart Rate"
)!;

function addStreamRhr(
  profileId: number,
  date: string,
  bpm: number,
  source: string | null
) {
  db.prepare(
    `INSERT INTO body_metrics (profile_id, date, resting_hr, source)
     VALUES (?, ?, ?, ?)`
  ).run(profileId, date, bpm, source);
}

function addObservedRhr(
  profileId: number,
  date: string,
  bpm: number,
  opts: { documentId?: number; source?: string } = {}
) {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num,
        reference_range, flag, source, document_id)
     VALUES (?, ?, 'vitals', 'Pulse', ?, 'bpm', 'Resting Heart Rate', ?,
             '60-100', NULL, ?, ?)`
  ).run(
    profileId,
    date,
    String(bpm),
    bpm,
    opts.source ?? null,
    opts.documentId ?? null
  );
}

beforeAll(() => {
  p = seedProfile("READING-SERIES");
  other = seedProfile("READING-SERIES-OTHER");
  d = (n: number) => shiftDateStr(p.todayStr, n);
  // The wearable stream: four daily readings.
  for (let i = 4; i >= 1; i--) addStreamRhr(p.profileId, d(-i), 55 + i, "oura");
  // A clinic-measured reading from a document — same identity, different store,
  // and on a day the stream also covers, so the series must keep BOTH.
  addObservedRhr(p.profileId, d(-2), 71, { documentId: p.documentId });
  // The same manual reading recorded in both stores — one physical measurement
  // presented twice, which the series must collapse.
  addStreamRhr(p.profileId, d(-6), 62, "manual");
  addObservedRhr(p.profileId, d(-6), 62, { source: "manual" });
  // Another profile's readings, to prove the scoping.
  addStreamRhr(other.profileId, d(-1), 99, "oura");
  addObservedRhr(other.profileId, d(-2), 98, { documentId: other.documentId });

  // #2005, on its OWN profile so the counts above stay the counts above. One
  // manually-entered reading, recorded in both stores exactly as the two write paths
  // actually spell it: `body_metrics` leaves `source` NULL, `medical_records` writes
  // the literal 'manual'. Two spellings, one provenance, one reading.
  spellings = seedProfile("READING-SERIES-SPELLINGS");
  addStreamRhr(spellings.profileId, d(-3), 64, null);
  addObservedRhr(spellings.profileId, d(-3), 64, { source: "manual" });
  // …and two DEVICES agreeing on a day: also one reading of that day for a series.
  addStreamRhr(spellings.profileId, d(-5), 52, "oura");
  addStreamRhr(spellings.profileId, d(-5), 52, "withings");
});

describe("a series for one identity spans both stores", () => {
  it("includes stream rows and same-identity observations, oldest first", () => {
    const series = getReadingSeries(p.profileId, IDENTITY);
    expect(series.map((r) => r.value)).toEqual([62, 59, 58, 71, 57, 56]);
    expect(series.every((r) => r.identity === IDENTITY)).toBe(true);
    const stores = new Set(series.map((r) => r.store));
    expect([...stores].sort()).toEqual(["body_metrics", "medical_records"]);
  });

  it("preserves provenance on the observation and leaves it absent on the stream", () => {
    const series = getReadingSeries(p.profileId, IDENTITY);
    const clinic = series.find((r) => r.date === d(-2) && r.value === 71)!;
    expect(clinic.store).toBe("medical_records");
    expect(clinic.source).toBe("lab");
    expect(clinic.provenance).toEqual({
      documentId: p.documentId,
      reportedName: "Pulse",
      reportedRange: "60-100",
    });
    for (const r of series.filter((x) => x.store === "body_metrics")) {
      expect(r.provenance).toBeUndefined();
      expect(r.source).toBe("wearable");
    }
  });

  it("dedupes one reading presented from two stores by (date, source)", () => {
    const series = getReadingSeries(p.profileId, IDENTITY);
    const onDay = series.filter((r) => r.date === d(-6));
    expect(onDay).toHaveLength(1);
    // The survivor is the one carrying provenance, so folding never costs a link.
    expect(onDay[0].store).toBe("medical_records");
    expect(onDay[0].source).toBe("manual");
  });

  it("keeps a clinic reading beside the wearable one on a shared day", () => {
    const onDay = getReadingSeries(p.profileId, IDENTITY).filter(
      (r) => r.date === d(-2)
    );
    expect(onDay.map((r) => r.value).sort((a, b) => a - b)).toEqual([57, 71]);
  });

  it("returns only the asked-for profile's readings", () => {
    const mine = getReadingSeries(p.profileId, IDENTITY);
    expect(mine.map((r) => r.value)).not.toContain(99);
    expect(mine.map((r) => r.value)).not.toContain(98);
    expect(
      getReadingSeries(other.profileId, IDENTITY).map((r) => r.value)
    ).toEqual([98, 99]);
  });

  it("answers an identity with no stream store from observations alone", () => {
    const series = getReadingSeries(p.profileId, readingIdentity("Glucose"));
    expect(series.length).toBeGreaterThan(0);
    expect(series.every((r) => r.store === "medical_records")).toBe(true);
    expect(series.every((r) => r.value === p.glucoseValueNum)).toBe(true);
  });

  it("reads a metric_samples stream in the same shape", () => {
    // The tall store's mapping is exercised through a descriptor rather than a
    // registry entry — no metric_samples key carries curated clinical knowledge
    // yet, and inventing one would be a mapping nobody curated.
    const src: StreamReadingSource = {
      store: "metric_samples",
      key: "hrv_ms",
      canonical: "Heart Rate Variability",
      unit: "ms",
    };
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'health-connect', 'hrv_ms', ?, ?, ?, 44)`
    ).run(p.profileId, d(-3), `${d(-3)}T03:00:00Z`, `${d(-3)}T03:05:00Z`);
    const readings = getStreamReadings(p.profileId, src);
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({
      store: "metric_samples",
      value: 44,
      unit: "ms",
      measuredAt: `${d(-3)}T03:00:00Z`,
      source: "wearable",
    });
    expect(readings[0].provenance).toBeUndefined();
  });

  it("presents the stream half on its own for the same identity", () => {
    const stream = getStreamReadings(p.profileId, RHR);
    expect(stream.every((r) => r.store === "body_metrics")).toBe(true);
    const observations = getObservationReadings(p.profileId, IDENTITY);
    expect(observations.every((r) => r.store === "medical_records")).toBe(true);
    // Together they are the whole series (before the cross-store collapse).
    expect(stream.length + observations.length).toBe(
      getReadingSeries(p.profileId, IDENTITY).length + 1
    );
  });
});

// #2005 — the collapse asks the model's OWN provenance question, not the raw column.
describe("one provenance, however the store spells it", () => {
  it("collapses a NULL-source stream row into a 'manual' observation", () => {
    const onDay = getReadingSeries(spellings.profileId, IDENTITY).filter(
      (r) => r.date === d(-3)
    );
    // Two physical rows, one in each store, both classified `manual` — one reading.
    expect(
      getStreamReadings(spellings.profileId, RHR).filter(
        (r) => r.date === d(-3)
      )
    ).toHaveLength(1);
    expect(
      getObservationReadings(spellings.profileId, IDENTITY).filter(
        (r) => r.date === d(-3)
      )
    ).toHaveLength(1);
    expect(onDay).toHaveLength(1);
    expect(onDay[0].source).toBe("manual");
    // The survivor is still the one carrying the most.
    expect(onDay[0].store).toBe("medical_records");
  });

  it("collapses two devices reporting the same value on one day", () => {
    const onDay = getReadingSeries(spellings.profileId, IDENTITY).filter(
      (r) => r.date === d(-5)
    );
    expect(onDay).toHaveLength(1);
    expect(onDay[0].source).toBe("wearable");
    // Both rows are still readable as themselves — the collapse is a SERIES
    // decision, not a claim that one of the devices did not report.
    expect(
      getStreamReadings(spellings.profileId, RHR)
        .filter((r) => r.date === d(-5))
        .map((r) => r.sourceKey)
        .sort()
    ).toEqual(["oura", "withings"]);
  });

  it("answers the canonical NAME exactly as it answers the identity", () => {
    const byName = getReadingSeries(spellings.profileId, "Resting Heart Rate");
    expect(byName).toEqual(getReadingSeries(spellings.profileId, IDENTITY));
    // Load-bearing: the STREAM half must be in there. Resolving the argument is
    // what keeps a name from returning observations only.
    expect(byName.some((r) => r.store === "body_metrics")).toBe(true);
  });
});

describe("the migration-free guarantee", () => {
  // Phase 1 is a READ model. Nothing about the three stores moved, so their
  // columns are exactly what they were — the pin that makes "no schema change"
  // a build failure rather than a claim in a PR body.
  //
  // EDITED ONCE, DELIBERATELY, by #2237 (#2205 phase 2 wave 1): migration 165 adds a
  // nullable `occurred_at` to body_metrics and medical_records. That is a real schema
  // change and this pin's one legitimate edit path — it is the announcement, not an
  // obstacle. `metric_samples` is untouched: it already had `start_time`.
  const columns = (table: string) =>
    (db.pragma(`table_info(${table})`) as { name: string }[])
      .map((c) => c.name)
      .sort();

  it("leaves body_metrics as the wide per-day store", () => {
    expect(columns("body_metrics")).toEqual([
      "body_fat_pct",
      "date",
      "edited",
      "id",
      "notes",
      "occurred_at",
      "profile_id",
      "resting_hr",
      "source",
      "weight_kg",
    ]);
  });

  it("leaves metric_samples as the tall metric/value store", () => {
    expect(columns("metric_samples")).toEqual([
      "activity_external_id",
      "date",
      "edited",
      "end_time",
      "id",
      "metric",
      "origin",
      "profile_id",
      "source",
      "start_time",
      "value",
    ]);
  });

  it("leaves medical_records unrestructured — it is the clinical record", () => {
    // The highest-stakes table in the app (#1808's FK map, tombstones, undo,
    // export, the passport). Phase 1 reads from it and restructures nothing; the
    // only column it has gained since is migration 165's additive `occurred_at`.
    expect(columns("medical_records")).toEqual([
      "canonical_name",
      "category",
      "created_at",
      "date",
      "document_id",
      "edited",
      "encounter_id",
      "external_id",
      "fasting",
      "flag",
      "id",
      "loinc",
      "name",
      "notes",
      "occurred_at",
      "ordering_provider_id",
      "panel",
      "profile_id",
      "provider_id",
      "reference_range",
      "result_status",
      "source",
      "specimen",
      "unit",
      "value",
      "value_num",
    ]);
  });
});
