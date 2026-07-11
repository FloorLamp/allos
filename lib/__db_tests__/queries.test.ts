// DB INTEGRATION TIER — query-layer SMOKE tests.
//
// The SQL in lib/queries/* is otherwise only *source-scanned* (the pure
// profile-scoping test) and never EXECUTED, so a typo'd JOIN, a renamed/wrong
// column, or a broken GROUP BY passes every gate and only fails at runtime. These
// tests seed a minimal cross-domain fixture into a real (throwaway) SQLite DB and
// call a representative read from each domain module, asserting the seeded shape
// comes back — catching that class of drift.
//
// This is a SMOKE layer: one or two reads per domain to prove the query runs and
// returns the seeded rows, NOT a re-test of business logic already covered by the
// pure unit suite. The db singleton is redirected at a per-file temp DB by
// lib/__db_tests__/setup.ts before this file is imported.

import { describe, it, expect, beforeAll } from "vitest";
import {
  getActivities,
  getStrengthByExercise,
  getCardioByActivity,
  getJournalWeekSummary,
  getDashboardStats,
  getGoals,
  getBodyMetrics,
  getWeights,
  getLatestBodyMetric,
  getMetricDailyTotals,
  getMedicalRecords,
  getLatestMedicalRecordByCanonical,
  getStarredBiomarkers,
  getMedicalDocuments,
  reconcileFlags,
  getImmunizations,
  getImmunizationOverrides,
  getSupplements,
  getSupplementDoses,
  getTakenDoseIds,
  getEncounters,
  getProviders,
  getConditions,
} from "@/lib/queries";
import type { Activity } from "@/lib/types";
import { getSmokingHistory, setSmokingHistory } from "@/lib/settings";
import { assessSchedule } from "@/lib/immunization-status";
import { daysOfSupplyLeft, isLowSupply } from "@/lib/refill";
import { gatherDigestInput } from "@/lib/notifications/digest-data";
import { healthRecordToPersistInput } from "@/lib/import-shape";
import { persistDocumentImport } from "@/lib/import-persist";
import type { ImportResult } from "@/lib/health-import";
import { db } from "@/lib/db";
import { seedProfile, type SeededProfile } from "./fixtures";

let fx: SeededProfile;

beforeAll(() => {
  fx = seedProfile("QSMOKE");
});

describe("training reads", () => {
  it("getActivities returns the seeded strength + cardio sessions", () => {
    const acts = getActivities(fx.profileId);
    expect(acts.length).toBe(2);
    const ids = acts.map((a) => a.id).sort();
    expect(ids).toEqual([fx.strengthActivityId, fx.cardioActivityId].sort());
    // profile_id is an infra column not on the domain Activity type — cast to read it.
    expect(
      acts.every(
        (a) =>
          (a as Activity & { profile_id: number }).profile_id === fx.profileId
      )
    ).toBe(true);
  });

  it("getStrengthByExercise derives the seeded Back Squat stat", () => {
    const stats = getStrengthByExercise(fx.profileId);
    const squat = stats.find((s) => s.exercise === "Back Squat");
    expect(squat).toBeDefined();
    expect(squat!.totalSets).toBe(2); // two seeded sets
    expect(squat!.topWeightKg).toBe(100);
  });

  it("getCardioByActivity derives the seeded run", () => {
    const cardio = getCardioByActivity(fx.profileId, "km");
    const run = cardio.find((c) => c.activity === `${fx.tag} Run`);
    expect(run).toBeDefined();
    expect(run!.totalDistanceKm).toBe(5);
  });

  it("getJournalWeekSummary + getDashboardStats aggregate the fixture", () => {
    const wk = getJournalWeekSummary(fx.profileId);
    expect(wk.sessions).toBe(2);
    expect(wk.streak).toBeGreaterThanOrEqual(1); // trained today
    const dash = getDashboardStats(fx.profileId);
    expect(dash.activityCount).toBe(2);
    expect(dash.activeGoals).toBe(1);
    expect(dash.latestWeight?.value).toBe(fx.weightKg);
  });

  it("getGoals returns the seeded active goal", () => {
    const goals = getGoals(fx.profileId);
    expect(goals.map((g) => g.title)).toContain(`${fx.tag} Squat 140`);
  });
});

describe("metrics reads", () => {
  it("body-metric reads return the seeded weigh-in", () => {
    expect(getBodyMetrics(fx.profileId).length).toBe(1);
    expect(getWeights(fx.profileId)[0].weight_kg).toBe(fx.weightKg);
    expect(getLatestBodyMetric(fx.profileId, "weight")).toBe(fx.weightKg);
  });

  it("getMetricDailyTotals rolls up the seeded steps sample", () => {
    const totals = getMetricDailyTotals(fx.profileId, "steps");
    expect(totals.length).toBe(1);
    expect(totals[0].value).toBe(8000);
    expect(totals[0].date).toBe(fx.todayStr);
  });
});

describe("medical / biomarker reads", () => {
  it("getMedicalRecords + latest-in-group return the seeded Glucose reading", () => {
    const recs = getMedicalRecords(fx.profileId);
    expect(recs.length).toBe(1);
    expect(recs[0].name).toBe("Glucose");
    expect((recs[0] as { is_latest: number }).is_latest).toBe(1);

    const latest = getLatestMedicalRecordByCanonical(fx.profileId, "glucose");
    expect(latest?.value_num).toBe(fx.glucoseValueNum);

    expect(getMedicalDocuments(fx.profileId).map((d) => d.filename)).toContain(
      `${fx.tag}-labs.pdf`
    );
    expect(
      getStarredBiomarkers(fx.profileId).map((s) => s.canonical_name)
    ).toContain("Glucose");
  });

  it("reconcileFlags round-trips: NULL flag → 'high' for an out-of-range value", () => {
    // Seeded with no flag; the derivation should flag Glucose 130 (> ref_high 99).
    expect(
      getLatestMedicalRecordByCanonical(fx.profileId, "Glucose")?.flag ?? null
    ).toBeNull();
    const changed = reconcileFlags(fx.profileId);
    expect(changed).toBeGreaterThanOrEqual(1);
    expect(
      getLatestMedicalRecordByCanonical(fx.profileId, "Glucose")?.flag
    ).toBe("high");
  });
});

describe("immunization reads", () => {
  it("assessSchedule reflects the seeded dose AND honors the declined override", () => {
    const records = getImmunizations(fx.profileId).map((r) => ({
      vaccine: r.vaccine,
      date: r.date,
    }));
    const overrides = getImmunizationOverrides(fx.profileId).map((o) => ({
      vaccine: o.vaccine,
      kind: o.kind,
    }));
    expect(records.some((r) => r.vaccine === fx.dosedVaccine)).toBe(true);

    const summary = assessSchedule(
      records,
      40 * 12,
      null,
      fx.todayStr,
      [],
      overrides
    );
    const dosed = summary.assessments.find((a) => a.code === fx.dosedVaccine);
    expect(dosed?.dosesReceived).toBeGreaterThanOrEqual(1);

    const declined = summary.assessments.find(
      (a) => a.code === fx.declinedVaccine
    );
    expect(declined?.status).toBe("declined");
    expect(declined?.override).toBe("declined");
  });
});

describe("intake / supplement reads", () => {
  it("getSupplements surfaces both a supplement and a medication row", () => {
    const items = getSupplements(fx.profileId);
    const kinds = items.map((i) => i.kind).sort();
    expect(kinds).toEqual(["medication", "supplement"]);
    expect(items.some((i) => i.name === `${fx.tag} Lisinopril`)).toBe(true);
  });

  it("dose + taken-log reads reflect the seeded morning dose", () => {
    const doses = getSupplementDoses(fx.profileId);
    expect(doses.length).toBe(2); // one per intake item
    const taken = getTakenDoseIds(fx.profileId, fx.todayStr);
    expect(taken.has(fx.supplementDoseId)).toBe(true);
  });

  it("refill read: the tracked supplement reports low days-of-supply", () => {
    const supp = getSupplements(fx.profileId).find(
      (s) => s.id === fx.supplementId
    )!;
    const dosesPerDay = getSupplementDoses(fx.profileId).filter(
      (d) => d.item_id === fx.supplementId
    ).length;
    const daysLeft = daysOfSupplyLeft(
      supp.quantity_on_hand,
      supp.qty_per_dose,
      dosesPerDay
    );
    expect(daysLeft).toBe(8); // 8 on hand / 1 per dose / 1 dose per day
    expect(isLowSupply(daysLeft)).toBe(true);
  });
});

describe("dashboard / digest gather", () => {
  it("gatherDigestInput runs across the fixture without throwing", () => {
    const input = gatherDigestInput(fx.profileId, fx.tag);
    expect(input.profileName).toBe(fx.tag);
    expect(typeof input.doseCount).toBe("number");
    expect(Array.isArray(input.activities)).toBe(true);
    expect(Array.isArray(input.newFlaggedBiomarkers)).toBe(true);
  });
});

describe("health-record import: height → metric_samples, weight → body_metrics", () => {
  // Build a fresh profile + document and run the real persist core, then assert an
  // imported Body Height lands in metric_samples(height_cm) and Body Weight in
  // body_metrics(weight_kg) — the split the growth chart height + BMI paths read.
  const anthro: ImportResult = {
    immunizations: [],
    records: [
      {
        category: "vitals",
        name: "Body Height",
        canonical: "Body Height",
        value: "178",
        value_num: 178,
        unit: "cm",
        date: "2024-01-10",
        external_id: "ccda:vital:8302-2:2024-01-10",
        loinc: "8302-2",
      },
      {
        category: "vitals",
        name: "Body Weight",
        canonical: "Body Weight",
        value: "82",
        value_num: 82,
        unit: "kg",
        date: "2024-01-10",
        external_id: "ccda:vital:29463-7:2024-01-10",
        loinc: "29463-7",
      },
      {
        // Head circumference: projects into metric_samples like height.
        category: "vitals",
        name: "Head Occipital-frontal circumference by Tape measure",
        canonical: "Head Occipital-frontal circumference by Tape measure",
        value: "46",
        value_num: 46,
        unit: "cm",
        date: "2024-01-10",
        external_id: "ccda:vital:8287-5:2024-01-10",
        loinc: "8287-5",
      },
    ],
    demographics: null,
  };

  function importInto(profileId: number, docId: number) {
    persistDocumentImport(
      profileId,
      docId,
      healthRecordToPersistInput(anthro, "ccda", "MyChart")
    );
  }

  function newProfileWithDoc(tag: string): {
    profileId: number;
    docId: number;
  } {
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run(tag)
        .lastInsertRowid
    );
    const docId = Number(
      db
        .prepare(
          `INSERT INTO medical_documents
             (profile_id, filename, stored_path, extraction_status)
           VALUES (?, ?, '', 'processing')`
        )
        .run(profileId, `${tag}.xml`).lastInsertRowid
    );
    return { profileId, docId };
  }

  it("routes Body Height to metric_samples and Body Weight to body_metrics", () => {
    const { profileId, docId } = newProfileWithDoc("HGT-IMPORT");
    importInto(profileId, docId);

    const height = getMetricDailyTotals(profileId, "height_cm");
    expect(height).toEqual([{ date: "2024-01-10", value: 178 }]);

    const weights = getWeights(profileId);
    expect(weights.map((w) => w.weight_kg)).toEqual([82]);

    // Head circumference lands in metric_samples('head_circumference_cm').
    const headCirc = getMetricDailyTotals(profileId, "head_circumference_cm");
    expect(headCirc).toEqual([{ date: "2024-01-10", value: 46 }]);

    // None of the anthropometric values remain as a generic medical_record.
    const recCount = db
      .prepare("SELECT COUNT(*) AS n FROM medical_records WHERE profile_id = ?")
      .get(profileId) as { n: number };
    expect(recCount.n).toBe(0);
  });

  it("is idempotent on reprocess (no duplicate height / head-circ sample)", () => {
    const { profileId, docId } = newProfileWithDoc("HGT-REPROCESS");
    importInto(profileId, docId);
    importInto(profileId, docId); // reprocess: delete-by-source then re-insert

    const rows = db
      .prepare(
        `SELECT value FROM metric_samples
           WHERE profile_id = ? AND metric = 'height_cm'`
      )
      .all(profileId) as { value: number }[];
    expect(rows.map((r) => r.value)).toEqual([178]);

    const hcRows = db
      .prepare(
        `SELECT value FROM metric_samples
           WHERE profile_id = ? AND metric = 'head_circumference_cm'`
      )
      .all(profileId) as { value: number }[];
    expect(hcRows.map((r) => r.value)).toEqual([46]);
  });
});

describe("health-record import: encounters → encounters table", () => {
  // A parsed CCD carrying one encounter with an attending clinician + facility and
  // a visit diagnosis. Run through the real persist core to prove: the row lands
  // profile-scoped, its providers resolve into the shared GLOBAL registry, and a
  // reprocess is idempotent (no duplicate encounter, no duplicate provider).
  const visit: ImportResult = {
    immunizations: [],
    records: [],
    encounters: [
      {
        date: "2026-06-08",
        end_date: "2026-06-08",
        type: "Office Visit",
        class_code: "AMB",
        reason: "Fever",
        diagnoses: ["Fever"],
        provider: {
          name: "Grace Hopper",
          type: "individual",
          npi: "1000000001",
          identifier: null,
          phone: null,
          address: null,
        },
        location: {
          name: "Sample Pediatrics - Springfield",
          type: "organization",
          npi: null,
          identifier: "200000001",
          phone: null,
          address: null,
        },
        notes: null,
        external_id: "ccda:encounter:100000001",
      },
    ],
    demographics: null,
  };

  function newProfileWithDoc(tag: string): {
    profileId: number;
    docId: number;
  } {
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run(tag)
        .lastInsertRowid
    );
    const docId = Number(
      db
        .prepare(
          `INSERT INTO medical_documents
             (profile_id, filename, stored_path, extraction_status)
           VALUES (?, ?, '', 'processing')`
        )
        .run(profileId, `${tag}.xml`).lastInsertRowid
    );
    return { profileId, docId };
  }

  function importVisit(profileId: number, docId: number) {
    persistDocumentImport(
      profileId,
      docId,
      healthRecordToPersistInput(visit, "ccda", "MyChart")
    );
  }

  it("persists the encounter linked to the shared providers registry", () => {
    const { profileId, docId } = newProfileWithDoc("ENC-IMPORT");
    importVisit(profileId, docId);

    const rows = getEncounters(profileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2026-06-08",
      type: "Office Visit",
      class_code: "AMB",
      reason: "Fever",
      diagnoses: "Fever", // stored as the joined summary column
      provider_name: "Grace Hopper",
      location_name: "Sample Pediatrics - Springfield",
    });
    expect(rows[0].provider_id).not.toBeNull();
    expect(rows[0].location_provider_id).not.toBeNull();

    // Both faces of the visit are shared providers (global, family-wide).
    const names = getProviders().map((p) => p.name);
    expect(names).toContain("Grace Hopper");
    expect(names).toContain("Sample Pediatrics - Springfield");
  });

  it("is idempotent on reprocess (no duplicate encounter or provider)", () => {
    const { profileId, docId } = newProfileWithDoc("ENC-REPROCESS");
    importVisit(profileId, docId);
    const afterFirst = getProviders().length;
    importVisit(profileId, docId); // reprocess: delete-by-document then re-insert

    // One encounter row survives, and the reprocess coins no new shared provider —
    // the clinician + facility re-resolve to the rows the first import created.
    expect(getEncounters(profileId)).toHaveLength(1);
    expect(getProviders().length).toBe(afterFirst);
  });

  it("keeps encounters profile-scoped (another profile sees none)", () => {
    const a = newProfileWithDoc("ENC-A");
    const b = newProfileWithDoc("ENC-B");
    importVisit(a.profileId, a.docId);
    expect(getEncounters(a.profileId)).toHaveLength(1);
    expect(getEncounters(b.profileId)).toHaveLength(0);
  });
});

describe("health-record import: smoking status supersede", () => {
  // A parsed CCD carrying one social-history smoking-status condition plus a real
  // problem-list condition. Smoking status is single-valued: re-importing a newer
  // status (as a SEPARATE document) must SUPERSEDE the prior one, leaving exactly
  // one social-smoking row — while never disturbing the coexisting problem-list
  // condition (a real ccda:condition:* row).
  function smokingDoc(smoking: { name: string; code: string }): ImportResult {
    return {
      immunizations: [],
      records: [],
      conditions: [
        {
          name: smoking.name,
          code: smoking.code,
          code_system: "SNOMED CT",
          status: "active",
          onset_date: null,
          resolved_date: null,
          external_id: `ccda:social-smoking:${smoking.code}`,
        },
        {
          // A genuine problem-list condition that must be left untouched by the
          // social-smoking supersede.
          name: "Asthma",
          code: "J45.909",
          code_system: "ICD-10-CM",
          status: "active",
          onset_date: "2020-01-01",
          resolved_date: null,
          external_id: "ccda:condition:j45.909:2020-01-01",
        },
      ],
      demographics: null,
    };
  }

  function newProfile(tag: string): number {
    return Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run(tag)
        .lastInsertRowid
    );
  }
  function newDoc(profileId: number, tag: string): number {
    return Number(
      db
        .prepare(
          `INSERT INTO medical_documents
             (profile_id, filename, stored_path, extraction_status)
           VALUES (?, ?, '', 'processing')`
        )
        .run(profileId, `${tag}.xml`).lastInsertRowid
    );
  }
  function importDoc(
    profileId: number,
    docId: number,
    result: ImportResult
  ): void {
    persistDocumentImport(
      profileId,
      docId,
      healthRecordToPersistInput(result, "ccda", "MyChart")
    );
  }

  function smokingRows(profileId: number) {
    return getConditions(profileId).filter((c) =>
      c.external_id?.includes("ccda:social-smoking:")
    );
  }

  it("supersedes an older status with a newer one (at most one, latest wins)", () => {
    const profileId = newProfile("SMOKE-SUPERSEDE");
    // Older document: "Current every day smoker".
    const doc1 = newDoc(profileId, "SMOKE-OLD");
    importDoc(
      profileId,
      doc1,
      smokingDoc({ name: "Current every day smoker", code: "449868002" })
    );
    expect(smokingRows(profileId).map((c) => c.name)).toEqual([
      "Current every day smoker",
    ]);

    // Newer document: "Former smoker" — a different status, separate document.
    const doc2 = newDoc(profileId, "SMOKE-NEW");
    importDoc(
      profileId,
      doc2,
      smokingDoc({ name: "Former smoker", code: "8517006" })
    );

    // Exactly one social-smoking row remains, and it's the newer status.
    const rows = smokingRows(profileId);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Former smoker");
    expect(rows[0].external_id).toContain("ccda:social-smoking:8517006");

    // The real problem-list condition is untouched by the supersede: each document
    // keeps its own physical Asthma row (source-scoped external_id), so BOTH
    // documents' physical Asthma rows survive — the smoking supersede deleted only
    // the ccda:social-smoking:* row, never a ccda:condition:* problem-list row.
    const physicalAsthma = db
      .prepare(
        "SELECT COUNT(*) AS n FROM conditions WHERE profile_id = ? AND name = 'Asthma'"
      )
      .get(profileId) as { n: number };
    expect(physicalAsthma.n).toBe(2);
    // …but the read layer collapses those cross-document twins to ONE (#134).
    const asthma = getConditions(profileId).filter((c) => c.name === "Asthma");
    expect(asthma).toHaveLength(1);
  });

  it("is idempotent (reimporting the same document yields one row)", () => {
    const profileId = newProfile("SMOKE-IDEMPOTENT");
    const docId = newDoc(profileId, "SMOKE-SAME");
    const result = smokingDoc({ name: "Former smoker", code: "8517006" });
    importDoc(profileId, docId, result);
    importDoc(profileId, docId, result); // reprocess
    expect(smokingRows(profileId)).toHaveLength(1);
    // And still just the one Asthma problem-list row (no duplication).
    expect(
      getConditions(profileId).filter((c) => c.name === "Asthma")
    ).toHaveLength(1);
  });

  it("keeps the supersede profile-scoped (another profile's status survives)", () => {
    const a = newProfile("SMOKE-A");
    const b = newProfile("SMOKE-B");
    const docA = newDoc(a, "SMOKE-A-DOC");
    const docB = newDoc(b, "SMOKE-B-DOC");
    importDoc(a, docA, smokingDoc({ name: "Former smoker", code: "8517006" }));
    importDoc(
      b,
      docB,
      smokingDoc({ name: "Current every day smoker", code: "449868002" })
    );
    // Importing B's status must NOT wipe A's — the supersede is WHERE profile_id.
    expect(smokingRows(a).map((c) => c.name)).toEqual(["Former smoker"]);
    expect(smokingRows(b).map((c) => c.name)).toEqual([
      "Current every day smoker",
    ]);
  });

  // Issue #83: the import ALSO seeds the structured smoking record so the risk-gated
  // screening rules read structured data, and a manual entry is never clobbered.
  it("seeds the structured smoking-history record from the imported status (#83)", () => {
    const profileId = newProfile("SMOKE-SEED");
    const docId = newDoc(profileId, "SMOKE-SEED-DOC");
    importDoc(
      profileId,
      docId,
      smokingDoc({ name: "Former smoker", code: "8517006" })
    );
    expect(getSmokingHistory(profileId).status).toBe("former");

    // A re-import (separate document) with a newer status re-seeds it.
    const doc2 = newDoc(profileId, "SMOKE-SEED-DOC2");
    importDoc(
      profileId,
      doc2,
      smokingDoc({ name: "Current every day smoker", code: "449868002" })
    );
    expect(getSmokingHistory(profileId).status).toBe("current");
  });

  it("a manual smoking entry survives a later import (source=manual, #83)", () => {
    const profileId = newProfile("SMOKE-MANUAL");
    // The user records "never" (plus, hypothetically, corrects a wrong import).
    setSmokingHistory(profileId, {
      status: "never",
      packYears: null,
      quitYear: null,
    });
    const docId = newDoc(profileId, "SMOKE-MANUAL-DOC");
    importDoc(
      profileId,
      docId,
      smokingDoc({ name: "Current every day smoker", code: "449868002" })
    );
    // The manual "never" is NOT overwritten by the imported "current".
    expect(getSmokingHistory(profileId).status).toBe("never");
    // The condition row is still imported (it remains the /conditions artifact).
    expect(smokingRows(profileId)).toHaveLength(1);
  });
});
