// SERVER-ACTION TIER — the metric detail page's readings table (issue #1488,
// absorbing #1397).
//
// #1397's defect was structural: Trends' quick-adds were upsert-only, and there was
// not even a production `DELETE FROM metric_samples`, so a mis-typed manual HRV or
// mood value was a TRUE dead end. These tests drive the real Server Actions and prove
// the four properties that make the fix a fix rather than a form:
//
//   1. an edit corrects the row it names, in the store that metric lives in;
//   2. an edited IMPORTED row survives the next re-sync (the #133 lock — the whole
//      reason migration 115 gave metric_samples an `edited` column);
//   3. a deleted imported sample is not resurrected by the next re-sync (the
//      #507/#508 re-import tombstone);
//   4. every path is profile-scoped — another profile's reading id is a no-op, never
//      a cross-profile write;
//   5. and, since #2032, a row that lives in a DIFFERENT store from the page's own —
//      a folded same-identity clinical observation — is corrected and deleted here too,
//      because the submission names the ROW rather than the metric slug.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  deleteMetricReading,
  updateMetricReading,
} from "@/app/(app)/trends/reading-actions";
import { upsertMetricSamples } from "@/lib/integrations/normalize";
import { upsertMoodLog } from "@/lib/offline/writes";
import { getMetricReadings } from "@/lib/metric-readings";
import { getMoodOnDate } from "@/lib/queries";
import { HRV_METRIC, SKIN_TEMP_DELTA_METRIC } from "@/lib/vitals-input";
import { metricReadingTarget } from "@/lib/metric-readings";
import { readingTargetToken } from "@/lib/reading-placement";
import { getReadingSeries } from "@/lib/queries/readings";
import { isBodyMetricSlug } from "@/lib/trends-body-metrics";
import { seedActor, createProfile, fd } from "./harness";

// The submission the readings table posts for a row (#2032): `kind` is the PAGE, and
// `target` is the physical ROW — `store:id:measure`, produced from the row rather than
// re-derived from the slug by the action. These tests go through the same two-field
// vocabulary the table does, so a metric's own row is addressed exactly as the page
// addresses it. (A `kind` the registry doesn't know has no target either; the deliberate
// junk below stands in for a hand-crafted submission.)
function target(kind: string, id: number): string {
  const t = isBodyMetricSlug(kind) ? metricReadingTarget(kind, id) : null;
  return t ? readingTargetToken(t) : `metric_samples:${id}:not-a-metric`;
}

const SRC = "health-connect";
const DATE = "2026-05-05";
const START = `${DATE}T07:00:00Z`;
const END = `${DATE}T07:01:00Z`;

function sample(value: number) {
  return [
    {
      metric: HRV_METRIC,
      date: DATE,
      start_time: START,
      end_time: END,
      value,
    },
  ];
}

function hrvRows(profileId: number) {
  return getMetricReadings(profileId, "hrv");
}

describe("updateMetricReading", () => {
  it("maps skin-temperature variation to its metric-samples readings", () => {
    const { profile } = seedActor();
    upsertMetricSamples(
      profile.id,
      [
        {
          metric: SKIN_TEMP_DELTA_METRIC,
          date: DATE,
          start_time: START,
          end_time: END,
          value: -0.3,
        },
      ],
      SRC
    );

    expect(getMetricReadings(profile.id, "skin-temp")).toMatchObject([
      { value: -0.3, source: SRC },
    ]);
  });

  it("corrects a metric_samples reading and locks it against the next re-sync", async () => {
    const { profile } = seedActor();
    upsertMetricSamples(profile.id, sample(42), SRC);
    const [row] = hrvRows(profile.id);
    expect(row.value).toBe(42);
    expect(row.edited).toBe(false);

    const res = await updateMetricReading(
      fd({ kind: "hrv", target: target("hrv", row.id), value: 58 })
    );
    expect(res).toEqual({ ok: true });
    expect(hrvRows(profile.id)[0]).toMatchObject({ value: 58, edited: true });

    // The provider re-pushes its rolling window with the ORIGINAL value. Before
    // migration 115 this silently restored 42 — the exact #133 failure.
    const counts = upsertMetricSamples(profile.id, sample(42), SRC);
    expect(counts).toMatchObject({ edited: 1, updated: 0 });
    expect(hrvRows(profile.id)[0].value).toBe(58);
  });

  it("corrects a body_metrics reading in the login's weight unit", async () => {
    const { profile } = seedActor({ weightUnit: "lb" });
    const id = Number(
      db
        .prepare(
          `INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, ?)`
        )
        .run(profile.id, DATE, 80).lastInsertRowid
    );

    // 176 lb is submitted; kilograms are what land in the column (the ONE unit
    // boundary, converted in the action).
    const res = await updateMetricReading(
      fd({ kind: "weight", target: target("weight", id), value: 176 })
    );
    expect(res).toEqual({ ok: true });
    const kg = (
      db.prepare(`SELECT weight_kg FROM body_metrics WHERE id = ?`).get(id) as {
        weight_kg: number;
      }
    ).weight_kg;
    expect(kg).toBeCloseTo(79.83, 1);
  });

  it("refuses an off-scale mood valence and a non-numeric value", async () => {
    const { profile } = seedActor();
    upsertMoodLog(profile.id, DATE, { valence: 3 });
    const [row] = getMetricReadings(profile.id, "mood");

    expect(
      await updateMetricReading(fd({ kind: "mood", target: target("mood", row.id), value: 9 }))
    ).toMatchObject({ ok: false });
    expect(
      await updateMetricReading(fd({ kind: "mood", target: target("mood", row.id), value: "abc" }))
    ).toMatchObject({ ok: false });
    expect(getMetricReadings(profile.id, "mood")[0].value).toBe(3);
  });

  it("never writes another profile's reading", async () => {
    const { profile } = seedActor();
    const other = createProfile("Other");
    upsertMetricSamples(other.id, sample(42), SRC);
    const [foreign] = hrvRows(other.id);

    const res = await updateMetricReading(
      fd({ kind: "hrv", target: target("hrv", foreign.id), value: 99 })
    );
    expect(res.ok).toBe(false);
    expect(hrvRows(other.id)[0].value).toBe(42);
    expect(hrvRows(profile.id)).toEqual([]);
  });

  it("corrects an energy rating without disturbing the day's other ratings (#1408)", async () => {
    const { profile } = seedActor();
    upsertMoodLog(profile.id, DATE, { valence: 4, energy: 2, anxiety: 5 });
    const [row] = getMetricReadings(profile.id, "energy");

    expect(
      await updateMetricReading(fd({ kind: "energy", target: target("energy", row.id), value: 5 }))
    ).toEqual({ ok: true });
    expect(getMetricReadings(profile.id, "energy")[0].value).toBe(5);
    expect(getMetricReadings(profile.id, "mood")[0].value).toBe(4);
  });

  it("submits Calm on the display axis and stores it as anxiety (#1313/#1408)", async () => {
    const { profile } = seedActor();
    upsertMoodLog(profile.id, DATE, { valence: 4, anxiety: 5 });
    const [row] = getMetricReadings(profile.id, "calm");
    // The table shows the relabelled slot (stored 5 = most anxious → shown 1); the
    // core still reads the raw column, so the two must not be confused.
    expect(row.value).toBe(5);

    // "4" means fairly calm on the axis the user sees → stored anxiety 2.
    expect(
      await updateMetricReading(fd({ kind: "calm", target: target("calm", row.id), value: 4 }))
    ).toEqual({ ok: true });
    expect(getMoodOnDate(profile.id, DATE)?.anxiety).toBe(2);
    // An off-scale display slot converts to an off-scale stored value and is refused
    // rather than wrapping around into a plausible-looking rating.
    expect(
      await updateMetricReading(fd({ kind: "calm", target: target("calm", row.id), value: 9 }))
    ).toMatchObject({ ok: false });
    expect(getMoodOnDate(profile.id, DATE)?.anxiety).toBe(2);
  });

  it("rejects an unknown metric kind rather than guessing a store", async () => {
    seedActor();
    expect(
      await updateMetricReading(fd({ kind: "not-a-metric", target: target("not-a-metric", 1), value: 5 }))
    ).toMatchObject({ ok: false });
  });

  it("corrects a FOLDED clinical observation on a stream metric's page (#2032)", async () => {
    // The residual #1999 recorded and phase 2 closes. This row is a `medical_records`
    // observation of the same identity, listed on /trends/metric/resting-hr — a page
    // whose own store is `body_metrics`. Before the write core routed by row, the action
    // resolved the store from `kind` and this edit could only be refused, which is why
    // the row was rendered read-only.
    const { profile } = seedActor();
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, value_num, unit, canonical_name, source)
       VALUES (?, ?, 'vitals', 'Resting Heart Rate', '70', 70, 'bpm', 'Resting Heart Rate', 'manual')`
    ).run(profile.id, DATE);
    const folded = getReadingSeries(profile.id, "Resting Heart Rate").find(
      (r) => r.store === "medical_records"
    );
    expect(folded).toBeDefined();

    const res = await updateMetricReading(
      fd({
        kind: "resting-hr",
        target: readingTargetToken({
          store: "medical_records",
          id: folded!.rowId,
          identity: folded!.identity,
        }),
        value: 64,
      })
    );
    expect(res).toEqual({ ok: true });
    expect(
      db
        .prepare(`SELECT value_num FROM medical_records WHERE id = ?`)
        .get(folded!.rowId)
    ).toEqual({ value_num: 64 });
  });
});

describe("deleteMetricReading", () => {
  it("deletes a sample and the next re-sync does not resurrect it", async () => {
    const { profile } = seedActor();
    upsertMetricSamples(profile.id, sample(42), SRC);
    const [row] = hrvRows(profile.id);

    await deleteMetricReading(fd({ kind: "hrv", target: target("hrv", row.id)}));
    expect(hrvRows(profile.id)).toEqual([]);

    // Without the tombstone the rolling window would simply re-insert it.
    const counts = upsertMetricSamples(profile.id, sample(42), SRC);
    expect(counts).toMatchObject({ suppressed: 1 });
    expect(hrvRows(profile.id)).toEqual([]);
  });

  it("clears ONE measure off a shared body_metrics row, keeping the others", async () => {
    const { profile } = seedActor();
    const id = Number(
      db
        .prepare(
          `INSERT INTO body_metrics (profile_id, date, weight_kg, body_fat_pct)
           VALUES (?, ?, ?, ?)`
        )
        .run(profile.id, DATE, 80, 21).lastInsertRowid
    );

    await deleteMetricReading(fd({ kind: "body-fat", target: target("body-fat", id) }));
    const row = db
      .prepare(`SELECT weight_kg, body_fat_pct FROM body_metrics WHERE id = ?`)
      .get(id) as { weight_kg: number | null; body_fat_pct: number | null };
    // The day's weigh-in must not go with the body-fat correction.
    expect(row).toEqual({ weight_kg: 80, body_fat_pct: null });
  });

  it("deletes a FOLDED clinical observation from a stream metric's page (#2032)", async () => {
    const { profile } = seedActor();
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, value_num, unit, canonical_name, source)
       VALUES (?, ?, 'vitals', 'Resting Heart Rate', '72', 72, 'bpm', 'Resting Heart Rate', 'manual')`
    ).run(profile.id, DATE);
    const folded = getReadingSeries(profile.id, "Resting Heart Rate").find(
      (r) => r.store === "medical_records"
    );
    const res = await deleteMetricReading(
      fd({
        kind: "resting-hr",
        target: readingTargetToken({
          store: "medical_records",
          id: folded!.rowId,
          identity: folded!.identity,
        }),
      })
    );
    // Undoable, because the clinical record's own delete capture is what ran.
    expect(res.undoId).toBeGreaterThan(0);
    expect(
      getReadingSeries(profile.id, "Resting Heart Rate").map((r) => r.rowId)
    ).not.toContain(folded!.rowId);
  });

  it("deletes a mood check-in (a mis-tapped past day is recoverable)", async () => {
    const { profile } = seedActor();
    upsertMoodLog(profile.id, DATE, { valence: 1 });
    const [row] = getMetricReadings(profile.id, "mood");

    await deleteMetricReading(fd({ kind: "mood", target: target("mood", row.id)}));
    expect(getMetricReadings(profile.id, "mood")).toEqual([]);
  });

  it("clears ONE rating off a shared check-in row, keeping the day (#1408)", async () => {
    const { profile } = seedActor();
    upsertMoodLog(profile.id, DATE, {
      valence: 4,
      energy: 2,
      anxiety: 5,
      note: "long day",
    });
    const [row] = getMetricReadings(profile.id, "energy");

    // The body_metrics rule one store down: removing a mis-tapped energy must not
    // take that day's mood, note and Calm with it.
    await deleteMetricReading(fd({ kind: "energy", target: target("energy", row.id)}));
    expect(getMetricReadings(profile.id, "energy")).toEqual([]);
    expect(getMoodOnDate(profile.id, DATE)).toMatchObject({
      valence: 4,
      energy: null,
      anxiety: 5,
      notes: "long day",
    });
  });

  it("never deletes another profile's reading", async () => {
    seedActor();
    const other = createProfile("Other");
    upsertMetricSamples(other.id, sample(42), SRC);
    const [foreign] = hrvRows(other.id);

    const res = await deleteMetricReading(fd({ kind: "hrv", target: target("hrv", foreign.id)}));
    expect(res).toEqual({ undoId: null });
    expect(hrvRows(other.id)).toHaveLength(1);
  });
});
