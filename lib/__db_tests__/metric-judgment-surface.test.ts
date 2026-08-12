// DB INTEGRATION TIER — the #1996 harm, end to end.
//
// A CHILD profile whose resting heart rate arrives ONLY from a wearable — no
// imported observation anywhere — now gets an age-appropriate judgement. That is
// the whole reported defect: a daily trend charted against nothing while the very
// bands that interpret it (0–1 → 90–160, 1–3 → 80–150 …) sat in the canonical
// vocabulary, unreachable because the readings were in a different store.
//
// The second half is completeness: the metric surface's series includes both the
// stream rows and same-identity observations, with the folded ones marked.
//
// All fixtures SYNTHETIC.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setProfileBirthdate, setProfileSex } from "@/lib/settings";
import { getMetricJudgment } from "@/lib/queries/metric-judgment";
import { getMetricObservations } from "@/lib/queries/readings";
import { foldObservationPoints } from "@/lib/reading-model";
import { fullTrendMetricSeries } from "@/lib/trend-metric-series";
import { getMetricReadings } from "@/lib/metric-readings";
import { seedProfile, type SeededProfile } from "./fixtures";

let child: SeededProfile;
let adult: SeededProfile;
let d: (n: number) => string;

function addStreamRhr(profileId: number, date: string, bpm: number) {
  db.prepare(
    `INSERT INTO body_metrics (profile_id, date, resting_hr, source)
     VALUES (?, ?, ?, 'oura')`
  ).run(profileId, date, bpm);
}

beforeAll(() => {
  child = seedProfile("JUDGE-CHILD");
  adult = seedProfile("JUDGE-ADULT");
  d = (n: number) => shiftDateStr(child.todayStr, n);
  // A two-year-old: birthdate two years and a month back, so the age is 2 on
  // every reading date below.
  const todayStr = today(child.profileId);
  setProfileBirthdate(child.profileId, shiftDateStr(todayStr, -(365 * 2 + 30)));
  setProfileSex(child.profileId, "female");
  setProfileBirthdate(adult.profileId, shiftDateStr(todayStr, -(365 * 40)));
  // ONLY streamed readings — no imported "Resting Heart Rate" observation at all.
  for (let i = 5; i >= 1; i--) addStreamRhr(child.profileId, d(-i), 118 + i);
  for (let i = 5; i >= 1; i--) addStreamRhr(adult.profileId, d(-i), 55 + i);
});

describe("a child's streamed resting heart rate is judged", () => {
  it("resolves the age-appropriate band with NO imported observation", () => {
    // The stream is the only source of readings…
    const series = fullTrendMetricSeries(
      "resting-hr",
      child.profileId,
      "kg",
      child.todayStr
    );
    expect(series).toHaveLength(5);
    expect(getMetricObservations(child.profileId, "resting-hr")).toEqual([]);

    // …and the judgement still reaches it, through the reading's identity.
    const latest = series[series.length - 1];
    const judgment = getMetricJudgment(
      child.profileId,
      "resting-hr",
      latest.value,
      latest.date
    );
    expect(judgment).toMatchObject({
      canonical: "Resting Heart Rate",
      low: 80,
      high: 150,
      bandLabel: "age 1–3",
    });
    // 119 bpm is normal for a toddler; the adult band would have called it high.
    expect(judgment?.badge).not.toBe("high");
  });

  it("judges the same value differently for an adult", () => {
    const judgment = getMetricJudgment(
      adult.profileId,
      "resting-hr",
      119,
      d(-1)
    );
    expect(judgment).toMatchObject({ low: 50, high: 100, bandLabel: null });
    expect(judgment?.badge).toBe("high");
  });

  it("answers nothing for a metric the registry says has no band", () => {
    expect(getMetricJudgment(adult.profileId, "steps", 8000, d(-1))).toBeNull();
  });
});

describe("the metric surface's series folds in same-identity observations", () => {
  it("includes a clinic reading the stream never saw, marked", () => {
    // One imported observation of the SAME quantity, in the other store.
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, unit, canonical_name, value_num,
          source, document_id)
       VALUES (?, ?, 'vitals', 'Pulse', '128', 'bpm', 'Resting Heart Rate', 128,
               NULL, ?)`
    ).run(child.profileId, d(-3), child.documentId);

    const observations = getMetricObservations(child.profileId, "resting-hr");
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ value: 128, source: "lab" });
    expect(observations[0].provenance?.documentId).toBe(child.documentId);

    // The SHARED series folds it in, so the tile, the Body chart and the detail
    // page all see it — five streamed days plus the clinic reading.
    const series = fullTrendMetricSeries(
      "resting-hr",
      child.profileId,
      "kg",
      child.todayStr
    );
    expect(series).toHaveLength(6);
    // The stream's own value for that day is untouched — the fold adds, never
    // rewrites.
    expect(series.filter((p) => p.date === d(-3)).map((p) => p.value)).toEqual([
      121, 128,
    ]);
    // Folding the same observations again is a no-op: an observation already in
    // the series is the same (date, value) and collapses.
    expect(foldObservationPoints(series, observations)).toHaveLength(6);
    // …and the row is still the metric store's own row set, so the readings table
    // can tell the two apart (the folded one is read-only there).
    expect(getMetricReadings(child.profileId, "resting-hr")).toHaveLength(5);
  });

  it("does not fold for a metric whose readings ARE observations", () => {
    // SpO2 stores as `medical_records`; folding would list every reading twice.
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, unit, canonical_name, value_num)
       VALUES (?, ?, 'vitals', 'Oxygen Saturation', '97', '%', 'Oxygen Saturation', 97)`
    ).run(adult.profileId, d(-1));
    expect(getMetricObservations(adult.profileId, "spo2")).toEqual([]);
    expect(
      fullTrendMetricSeries("spo2", adult.profileId, "kg", adult.todayStr)
    ).toHaveLength(1);
  });
});
