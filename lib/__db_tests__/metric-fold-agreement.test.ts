// DB INTEGRATION TIER — the metric page's chart and its readings table answer
// "how many readings does this day have" ONCE (#2029).
//
// The reported disagreement: on a day where a clinic-measured value EQUALS the
// wearable's, the chart's fold dropped the observation (one plotted point) while
// the page's table concatenated it back in (two listed rows) — the same surface
// contradicting itself one scroll apart. The repair is a single decision
// (`foldObservations`, reached here through `bodyMetricSeriesFold`) whose second
// half IS the observation set the table lists.
//
// What this file proves, against real rows in both stores: the fold's two halves
// agree, and the day that carries a duplicate is counted once by BOTH consumers
// while a genuinely new clinic reading is counted once by both too.
//
// All fixtures SYNTHETIC.

import { describe, it, expect, beforeAll } from "vitest";
import { shiftDateStr } from "@/lib/date";
import { db } from "@/lib/db";
import { bodyMetricSeriesFold } from "@/lib/body-metric-series";
import { getMetricObservations } from "@/lib/queries/readings";
import { getMetricReadings } from "@/lib/metric-readings";
import { seedProfile, type SeededProfile } from "./fixtures";

let p: SeededProfile;
let d: (n: number) => string;

// The equal-valued pair: one wearable resting HR and one clinic reading of the
// SAME identity, on the SAME day, carrying the SAME number. This is the reported
// shape and the only one where the two consumers used to differ.
const DUPLICATED_BPM = 57;
// A clinic reading on a day the stream never covered — the completeness half
// (#1996), which must survive the fold and be counted by both consumers.
const CLINIC_ONLY_BPM = 73;

function addStreamRhr(date: string, bpm: number): void {
  db.prepare(
    `INSERT INTO body_metrics (profile_id, date, resting_hr, source)
     VALUES (?, ?, ?, 'oura')`
  ).run(p.profileId, date, bpm);
}

function addObservationRhr(date: string, bpm: number): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num,
        source, document_id)
     VALUES (?, ?, 'vitals', 'Pulse', ?, 'bpm', 'Resting Heart Rate', ?,
             NULL, ?)`
  ).run(p.profileId, date, String(bpm), bpm, p.documentId);
}

// The table's row count, composed exactly as /trends/metric/[kind] composes it:
// the metric's own store rows plus the observations the fold handed back.
function tableRowCount(observations: readonly unknown[]): number {
  return (
    getMetricReadings(p.profileId, "resting-hr").length + observations.length
  );
}

beforeAll(() => {
  p = seedProfile("FOLD-AGREE");
  d = (n: number) => shiftDateStr(p.todayStr, n);
  // Three streamed days, one row each, so a plotted point and a table row are the
  // same thing on the stream side and the counts below are a real signal.
  addStreamRhr(d(-5), 55);
  addStreamRhr(d(-3), DUPLICATED_BPM);
  addStreamRhr(d(-1), 56);
  // The clinic's copy of the −3d reading: same identity, same day, same number.
  addObservationRhr(d(-3), DUPLICATED_BPM);
  // …and one on a day the wearable did not report.
  addObservationRhr(d(-7), CLINIC_ONLY_BPM);
});

describe("the metric page's chart and readings table share one fold (#2029)", () => {
  it("drops the equal-valued clinic copy from BOTH halves", () => {
    // Both observations exist as rows; the fold is what decides which are readings
    // of a day the stream has not already answered for.
    expect(getMetricObservations(p.profileId, "resting-hr")).toHaveLength(2);

    const fold = bodyMetricSeriesFold(
      "resting-hr",
      p.profileId,
      "kg",
      p.todayStr
    );
    expect(fold.observations.map((r) => r.value)).toEqual([CLINIC_ONLY_BPM]);
    // The duplicated day is ONE point…
    expect(fold.points.filter((pt) => pt.date === d(-3))).toEqual([
      { date: d(-3), value: DUPLICATED_BPM },
    ]);
    // …and ONE row, because the table lists the fold's survivors rather than
    // re-reading every observation.
    expect(tableRowCount(fold.observations)).toBe(fold.points.length);
    expect(fold.points).toHaveLength(4);
  });

  it("counts the clinic-only day once on both sides", () => {
    const fold = bodyMetricSeriesFold(
      "resting-hr",
      p.profileId,
      "kg",
      p.todayStr
    );
    expect(fold.points.filter((pt) => pt.date === d(-7))).toEqual([
      { date: d(-7), value: CLINIC_ONLY_BPM },
    ]);
    // The stream never saw that day, so the table's row for it is the observation
    // the fold kept — not a second copy of a streamed one.
    expect(getMetricReadings(p.profileId, "resting-hr")).toHaveLength(3);
    expect(fold.observations).toHaveLength(1);
  });

  it("keeps the stream authoritative for its own day", () => {
    // A clinic reading that DISAGREES with the stream is a different reading of the
    // day, so it survives — and both consumers then show the day twice, together.
    addObservationRhr(d(-1), 64);
    const fold = bodyMetricSeriesFold(
      "resting-hr",
      p.profileId,
      "kg",
      p.todayStr
    );
    expect(fold.points.filter((pt) => pt.date === d(-1))).toEqual([
      { date: d(-1), value: 56 },
      { date: d(-1), value: 64 },
    ]);
    expect(tableRowCount(fold.observations)).toBe(fold.points.length);
  });
});
