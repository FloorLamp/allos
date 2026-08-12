// DB INTEGRATION TIER — the respiratory domain's round-trip (issue #1850).
//
// The issue's whole subject is the STORE decision, so the load-bearing assertions
// are about WHERE the readings land and whether they reach the surface that renders
// them. If a future change quietly mints a parallel `peak_flow` table, these fail.
//
// Three things are covered end to end:
//
//  1. THE HOME HALF. A blow typed into the combined measurements quick-add lands in
//     `metric_samples` under the registered stream key, keeps its clock time, and a
//     SECOND blow the same day is a second reading rather than a correction of the
//     first — the property that made the tall store the right one.
//  2. THE CLINIC HALF. A spirometry document lands FEV1 / FVC / the ratio as
//     `medical_records` observations flagged against the one curated cutoff, and a
//     PEF printed on that same report stays an observation (provenance beats the
//     stream) yet still FOLDS onto the metric page's chart.
//  3. THE VERDICT. The zone is computed from the profile's declared personal best,
//     and with none declared there is no verdict at all.
//
// All fixtures SYNTHETIC (a throwaway per-file DB via setup.ts). No AI, no network.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { insertVitals } from "@/lib/offline/writes";
import {
  applyImportFollowups,
  persistDocumentImport,
} from "@/lib/import-persist";
import type { PersistInput } from "@/lib/import-shape";
import {
  getPeakFlowPersonalBest,
  setPeakFlowPersonalBest,
} from "@/lib/settings";
import {
  peakFlowZone,
  suggestedPersonalBest,
  PEAK_FLOW_CANONICAL,
  PEAK_FLOW_METRIC,
  PEAK_FLOW_SLUG,
} from "@/lib/peak-flow";
import { getMetricReadings } from "@/lib/metric-readings";
import { trendMetricSeriesFold } from "@/lib/trend-metric-series";
import { getMetricJudgment } from "@/lib/queries/metric-judgment";
import { readingDetailHref } from "@/lib/hrefs";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// The two-step the real pipeline runs: persist the rows, then apply the follow-ups
// (which is where the canonical-flag reconcile lives). Splitting them here would
// under-test the flag half, which is exactly the half the ratio's cutoff exercises.
function importSpirometry(
  profileId: number,
  docId: number,
  input: PersistInput
): void {
  const outcome = persistDocumentImport(profileId, docId, input);
  applyImportFollowups(profileId, {
    demographics: input.demographics,
    records: input.records,
    canonicalNames: input.canonicalNamesToRegister,
    insertedRecordIds: outcome.insertedRecordIds,
  });
}

function makeDocument(profileId: number, filename: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, ?, '', 'processing', 'report')`
      )
      .run(profileId, filename).lastInsertRowid
  );
}

function peakFlowRows(profileId: number) {
  return db
    .prepare(
      `SELECT date, start_time, value, source, metric FROM metric_samples
        WHERE profile_id = ? AND metric = ? ORDER BY start_time`
    )
    .all(profileId, PEAK_FLOW_METRIC) as {
    date: string;
    start_time: string;
    value: number;
    source: string;
    metric: string;
  }[];
}

describe("the home half — a blow through the measurements quick-add", () => {
  it("lands in metric_samples under the registered stream key, not a new table", () => {
    const profileId = makeProfile("peak-flow-quick-add");
    expect(
      insertVitals(profileId, "2026-04-02", { peakFlow: "540" }).wrote
    ).toBe(true);

    const rows = peakFlowRows(profileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2026-04-02",
      value: 540,
      source: "manual",
      metric: PEAK_FLOW_METRIC,
    });
    // …and NOWHERE else: the reading is one row in one store.
    const observations = db
      .prepare(
        `SELECT COUNT(*) AS c FROM medical_records
          WHERE profile_id = ? AND canonical_name = ?`
      )
      .get(profileId, PEAK_FLOW_CANONICAL) as { c: number };
    expect(observations.c).toBe(0);
  });

  it("keeps a morning and an evening blow as TWO readings on one flare day", () => {
    const profileId = makeProfile("peak-flow-twice-daily");
    insertVitals(profileId, "2026-04-03", {
      peakFlow: "520",
      peakFlowTime: "07:30",
    });
    insertVitals(profileId, "2026-04-03", {
      peakFlow: "430",
      peakFlowTime: "20:00",
    });

    const rows = peakFlowRows(profileId);
    expect(rows.map((r) => r.value)).toEqual([520, 430]);
    expect(rows.map((r) => r.start_time)).toEqual([
      "2026-04-03T07:30:00",
      "2026-04-03T20:00:00",
    ]);
  });

  it("CORRECTS the day when no time is stated (the untimed re-entry)", () => {
    const profileId = makeProfile("peak-flow-untimed");
    insertVitals(profileId, "2026-04-04", { peakFlow: "500" });
    insertVitals(profileId, "2026-04-04", { peakFlow: "515" });

    const rows = peakFlowRows(profileId);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(515);
  });

  it("refuses an implausible blow through the shared pure bounds", () => {
    const profileId = makeProfile("peak-flow-bounds");
    // The core runs the same `peakFlowRangeError` the client form pre-validates
    // with, so a crafted or replayed request can never store a 5000.
    expect(
      insertVitals(profileId, "2026-04-05", { peakFlow: "5000" }).wrote
    ).toBe(false);
    expect(peakFlowRows(profileId)).toHaveLength(0);
  });

  it("reaches the metric page's readings table and its chart", () => {
    const profileId = makeProfile("peak-flow-surface");
    insertVitals(profileId, "2026-04-06", {
      peakFlow: "600",
      peakFlowTime: "07:00",
    });
    insertVitals(profileId, "2026-04-07", {
      peakFlow: "450",
      peakFlowTime: "07:00",
    });

    const readings = getMetricReadings(profileId, PEAK_FLOW_SLUG);
    expect(readings).toHaveLength(2);
    // Newest first, each carrying the id the row actions edit and delete by.
    expect(readings[0].value).toBe(450);
    for (const r of readings) expect(r.id).toBeGreaterThan(0);

    const { points } = trendMetricSeriesFold(
      PEAK_FLOW_SLUG,
      profileId,
      "kg",
      "2026-04-08"
    );
    expect(points.map((p) => p.value)).toEqual([600, 450]);
  });

  it("routes a reading of this identity to the metric surface, not the lab page", () => {
    expect(readingDetailHref(PEAK_FLOW_CANONICAL)).toBe(
      "/trends/metric/peak-flow"
    );
  });
});

describe("the clinic half — a spirometry report through the document pipeline", () => {
  const DATE = "2026-02-10";
  // The two absolute volumes' canonical entries (#2335 gave them their long form).
  const FEV1 = "Forced Expiratory Volume in 1 Second (FEV1)";
  const FVC = "Forced Vital Capacity (FVC)";

  // The printed name is what a PFT report prints (the bare abbreviation); `canonical`
  // is what the pipeline's snap has already made of it by the time a PersistInput
  // exists — since #2335 the "Long Name (ABBR)" entry, which is also the entry the
  // flag reconcile then judges the reading against.
  function spirometryInput(): PersistInput {
    const row = (
      name: string,
      canonical: string,
      value: number,
      unit: string,
      externalId: string
    ) => ({
      category: "vitals" as const,
      name,
      canonical,
      value: String(value),
      value_num: value,
      unit,
      date: DATE,
      reference_range: null,
      flag: null,
      panel: "Pulmonary function",
      notes: null,
      source: null,
      external_id: externalId,
      loinc: null,
      provider: null,
    });
    return {
      records: [
        row("FEV1", FEV1, 2.9, "L", "pft:fev1"),
        row("FVC", FVC, 4.4, "L", "pft:fvc"),
        row("FEV1/FVC Ratio", "FEV1/FVC Ratio", 66, "%", "pft:ratio"),
        // A PEF printed on the same report — a reading of the STREAM identity that
        // nonetheless carries a document.
        row(PEAK_FLOW_CANONICAL, PEAK_FLOW_CANONICAL, 505, "L/min", "pft:pef"),
      ],
      immunizations: [],
      allergies: [],
      conditions: [],
      encounters: [],
      procedures: [],
      familyHistory: [],
      carePlanItems: [],
      careGoals: [],
      appointments: [],
      bodyMetrics: [],
      heights: [],
      headCircs: [],
      demographics: null,
      meta: {
        docType: "report",
        source: "ai",
        documentDate: DATE,
        patientName: "Test Patient",
        raw: null,
        model: null,
        importReport: null,
      },
      canonicalNamesToRegister: [],
      providers: [],
    };
  }

  it("lands the trio as flagged observations, and the ratio is the one with a band", () => {
    const profileId = makeProfile("spirometry-import");
    const docId = makeDocument(profileId, "pft-report.pdf");
    importSpirometry(profileId, docId, spirometryInput());

    const rows = db
      .prepare(
        `SELECT canonical_name, category, value_num, unit, flag, document_id
           FROM medical_records WHERE profile_id = ? ORDER BY canonical_name`
      )
      .all(profileId) as {
      canonical_name: string;
      category: string;
      value_num: number;
      unit: string;
      flag: string | null;
      document_id: number | null;
    }[];
    const byName = new Map(rows.map((r) => [r.canonical_name, r]));

    expect(byName.get(FEV1)).toMatchObject({
      category: "vitals",
      value_num: 2.9,
      unit: "L",
      document_id: docId,
      // No population band exists for an absolute volume, so the reconcile derives
      // no flag — the honest answer, not an oversight.
      flag: null,
    });
    expect(byName.get(FVC)?.flag).toBeNull();
    // The one universal cutoff: 66% is below the 70% obstruction criterion.
    expect(byName.get("FEV1/FVC Ratio")).toMatchObject({
      value_num: 66,
      flag: "low",
    });
  });

  it("keeps the report's PEF an observation (provenance beats the stream)", () => {
    const profileId = makeProfile("spirometry-pef");
    const docId = makeDocument(profileId, "pft-with-pef.pdf");
    importSpirometry(profileId, docId, spirometryInput());

    // It did NOT go to the stream store — the document link has nowhere to live
    // there, and losing it is the one placement error a later correction cannot undo.
    expect(peakFlowRows(profileId)).toHaveLength(0);
    const observation = db
      .prepare(
        `SELECT value_num, document_id FROM medical_records
          WHERE profile_id = ? AND canonical_name = ?`
      )
      .get(profileId, PEAK_FLOW_CANONICAL) as {
      value_num: number;
      document_id: number;
    };
    expect(observation).toMatchObject({ value_num: 505, document_id: docId });
  });

  it("FOLDS that clinic reading onto the metric page's chart", () => {
    // The completeness half (#1996/#2029): a reading of the identity is never
    // stranded off the page the identity routes to, whichever store holds it.
    const profileId = makeProfile("spirometry-fold");
    const docId = makeDocument(profileId, "pft-fold.pdf");
    importSpirometry(profileId, docId, spirometryInput());
    insertVitals(profileId, "2026-02-12", { peakFlow: "590" });

    const { points, observations } = trendMetricSeriesFold(
      PEAK_FLOW_SLUG,
      profileId,
      "kg",
      "2026-02-13"
    );
    expect(points.map((p) => p.value)).toEqual([505, 590]);
    expect(observations.map((o) => o.value)).toEqual([505]);
  });
});

describe("the verdict — computed from the declared personal best", () => {
  it("has NO verdict until a personal best is declared", () => {
    const profileId = makeProfile("peak-flow-no-best");
    insertVitals(profileId, "2026-05-01", { peakFlow: "430" });

    expect(getPeakFlowPersonalBest(profileId)).toBeNull();
    expect(peakFlowZone(430, getPeakFlowPersonalBest(profileId))).toBeNull();
    // And the canonical judgement lookup declines too, so nothing can quietly
    // supply a population band in its place.
    expect(
      getMetricJudgment(profileId, PEAK_FLOW_SLUG, 430, "2026-05-01")
    ).toBeNull();
  });

  it("bands the reading once the best is declared, and re-bands when it moves", () => {
    const profileId = makeProfile("peak-flow-best");
    insertVitals(profileId, "2026-05-02", { peakFlow: "430" });
    setPeakFlowPersonalBest(profileId, 620);

    expect(getPeakFlowPersonalBest(profileId)).toBe(620);
    expect(peakFlowZone(430, getPeakFlowPersonalBest(profileId))).toMatchObject(
      { zone: "yellow", percent: 69 }
    );

    // THE REASON THE VERDICT IS NOT STORED: correcting the best re-bands every
    // reading immediately. A flag column written at ingest could not have done this.
    setPeakFlowPersonalBest(profileId, 500);
    expect(peakFlowZone(430, getPeakFlowPersonalBest(profileId))).toMatchObject(
      { zone: "green", percent: 86 }
    );
  });

  it("clears back to no verdict, and refuses an implausible best", () => {
    const profileId = makeProfile("peak-flow-best-clear");
    setPeakFlowPersonalBest(profileId, 600);
    setPeakFlowPersonalBest(profileId, null);
    expect(getPeakFlowPersonalBest(profileId)).toBeNull();

    setPeakFlowPersonalBest(profileId, 5000);
    expect(getPeakFlowPersonalBest(profileId)).toBeNull();
  });

  it("suggests the highest reading on file without ever writing it", () => {
    const profileId = makeProfile("peak-flow-suggest");
    insertVitals(profileId, "2026-05-03", { peakFlow: "560" });
    insertVitals(profileId, "2026-05-04", { peakFlow: "610" });

    const { points } = trendMetricSeriesFold(
      PEAK_FLOW_SLUG,
      profileId,
      "kg",
      "2026-05-05"
    );
    expect(suggestedPersonalBest(points.map((p) => p.value))).toBe(610);
    // …and the stored best is still unset: detect and SUGGEST, never write.
    expect(getPeakFlowPersonalBest(profileId)).toBeNull();
  });

  it("scopes the best to its own profile", () => {
    const a = makeProfile("peak-flow-scope-a");
    const b = makeProfile("peak-flow-scope-b");
    setPeakFlowPersonalBest(a, 620);
    expect(getPeakFlowPersonalBest(b)).toBeNull();
    // The same 500 L/min blow is green for one and yellow for the other, which is
    // the whole reason a population band cannot answer here.
    expect(peakFlowZone(500, getPeakFlowPersonalBest(a))?.zone).toBe("green");
    expect(peakFlowZone(500, getPeakFlowPersonalBest(b))).toBeNull();
  });
});
