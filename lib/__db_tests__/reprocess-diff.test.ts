// DB INTEGRATION TIER — reprocess-diff.
//
// Proves the PERSISTED-side snapshot reader (getReprocessSnapshot) and the pure
// extraction-side snapshot (snapshotFromPersistInput) line up through the shared
// row builders, and — the key guarantee — that COMMITTING a reprocess
// (persistDocumentImport, the unchanged one-shot writer) leaves the DB in exactly
// the end state the fresh extraction described. So the preview is faithful to what
// confirm will produce.

import { describe, it, expect, beforeAll } from "vitest";
import {
  getCanonicalVocabulary,
  getReprocessSnapshot,
  previewReconcileFlags,
  foldConsolidatedMedsIntoSnapshot,
  pruneDeferredMetricsFromSnapshot,
  getMedMatchStates,
} from "@/lib/queries";
import {
  persistDocumentImport,
  applyImportFollowups,
} from "@/lib/import-persist";
import { snapshotFromPersistInput, computeImportDiff } from "@/lib/import-diff";
import { healthRecordToPersistInput } from "@/lib/import-shape";
import type { PersistInput } from "@/lib/import-shape";
import { persistHealthRecordDoc } from "@/lib/health-record-doc";
import { parseHealthRecord } from "@/lib/health-record-parse";
import {
  buildCanonicalIndex,
  snapCanonicalNameIntoBatch,
  distinguishVitaminDIsoform,
} from "@/lib/canonical-name";
import { db } from "@/lib/db";

const DATE = "2020-05-01";

function makeInput(over: Partial<PersistInput> = {}): PersistInput {
  return {
    records: [
      {
        category: "lab",
        name: "Glucose",
        canonical: "Glucose",
        value: "95",
        value_num: 95,
        unit: "mg/dL",
        date: DATE,
        reference_range: null,
        flag: null,
        panel: "Metabolic",
        notes: null,
        source: "ccda",
        external_id: "obs:glucose",
        loinc: null,
        provider: null,
        courses: null,
      },
      {
        category: "prescription",
        name: "Lisinopril 10 mg",
        canonical: "Lisinopril",
        value: null,
        value_num: null,
        unit: null,
        date: DATE,
        reference_range: null,
        flag: null,
        panel: null,
        notes: "Take one daily",
        source: "ccda",
        external_id: "med:lisinopril",
        loinc: null,
        provider: null,
        courses: null,
      },
    ],
    immunizations: [
      {
        date: DATE,
        vaccine: "influenza",
        dose_label: null,
        notes: null,
        external_id: "imm:flu",
        provider: null,
      },
    ],
    allergies: [
      {
        substance: "Penicillin",
        substance_code: null,
        substance_code_system: null,
        reaction: "Hives",
        severity: "moderate",
        status: "active",
        onset_date: null,
        external_id: "alg:pcn",
      },
    ],
    conditions: [
      {
        name: "Hypertension",
        code: "I10",
        code_system: "ICD-10",
        status: "active",
        onset_date: null,
        resolved_date: null,
        external_id: "cond:htn",
      },
    ],
    encounters: [
      {
        date: DATE,
        end_date: null,
        type: "Office Visit",
        class_code: "AMB",
        reason: "Annual physical",
        diagnoses: ["Hypertension"],
        provider: null,
        location: null,
        notes: null,
        external_id: "enc:1",
      },
    ],
    procedures: [],
    familyHistory: [],
    carePlanItems: [],
    careGoals: [],
    appointments: [],
    bodyMetrics: [
      { date: DATE, weight_kg: 82, body_fat_pct: null, resting_hr: null },
    ],
    heights: [{ date: DATE, height_cm: 178 }],
    headCircs: [{ date: DATE, head_circumference_cm: 47 }],
    demographics: null,
    meta: {
      docType: "ccd",
      source: "ccd",
      documentDate: DATE,
      patientName: "Test Patient",
      raw: null,
      model: null,
      importReport: null,
    },
    canonicalNamesToRegister: [],
    providers: [],
    ...over,
  };
}

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function newDocument(profileId: number, filename: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, ?, '', 'processing', 'ccd')`
      )
      .run(profileId, filename).lastInsertRowid
  );
}

let profileId: number;
let docId: number;

beforeAll(() => {
  profileId = newProfile("DIFF-A");
  docId = newDocument(profileId, "A.ccd");
  persistDocumentImport(profileId, docId, makeInput());
});

describe("getReprocessSnapshot vs snapshotFromPersistInput", () => {
  it("the persisted snapshot equals the fresh extraction's snapshot after an import", () => {
    const current = getReprocessSnapshot(profileId, docId);
    const next = snapshotFromPersistInput(makeInput());
    const diff = computeImportDiff(current, next);
    expect(diff.hasChanges).toBe(false);
    // Every tracked kind produced exactly one unchanged row (records has 2).
    expect(diff.totals.unchanged).toBe(current.records.length + 8);
  });

  it("is profile-scoped: another profile sees an empty snapshot for this doc", () => {
    const other = newProfile("DIFF-B");
    const snap = getReprocessSnapshot(other, docId);
    expect(snap.records).toEqual([]);
    expect(snap.immunizations).toEqual([]);
    expect(snap.bodyMetrics).toEqual([]);
  });
});

describe("reprocess-diff preview then commit", () => {
  it("previews add/remove/change, and committing reaches exactly the fresh state", () => {
    // A reprocess result that: changes Glucose's value, drops the immunization,
    // adds an HDL lab, and keeps everything else.
    const reprocessed = makeInput({
      records: [
        {
          category: "lab",
          name: "Glucose",
          canonical: "Glucose",
          value: "110",
          value_num: 110,
          unit: "mg/dL",
          date: DATE,
          reference_range: null,
          flag: "high",
          panel: "Metabolic",
          notes: null,
          source: "ccda",
          external_id: "obs:glucose",
          loinc: null,
          provider: null,
          courses: null,
        },
        {
          category: "lab",
          name: "HDL",
          canonical: "HDL Cholesterol",
          value: "55",
          value_num: 55,
          unit: "mg/dL",
          date: DATE,
          reference_range: null,
          flag: null,
          panel: "Lipids",
          notes: null,
          source: "ccda",
          external_id: "obs:hdl",
          loinc: null,
          provider: null,
          courses: null,
        },
        {
          category: "prescription",
          name: "Lisinopril 10 mg",
          canonical: "Lisinopril",
          value: null,
          value_num: null,
          unit: null,
          date: DATE,
          reference_range: null,
          flag: null,
          panel: null,
          notes: "Take one daily",
          source: "ccda",
          external_id: "med:lisinopril",
          loinc: null,
          provider: null,
          courses: null,
        },
      ],
      immunizations: [],
    });

    // Preview (no writes): diff persisted vs the fresh extraction.
    const before = getReprocessSnapshot(profileId, docId);
    const next = snapshotFromPersistInput(reprocessed);
    const diff = computeImportDiff(before, next);
    const recs = diff.entities.find((e) => e.entity === "records")!;
    expect(recs.added.map((r) => r.key)).toContain("ext:obs:hdl");
    expect(recs.changed.map((c) => c.after.key)).toContain("ext:obs:glucose");
    const imms = diff.entities.find((e) => e.entity === "immunizations")!;
    expect(imms.removed).toHaveLength(1);
    // The preview did NOT mutate the DB — persisted snapshot is unchanged.
    expect(
      computeImportDiff(getReprocessSnapshot(profileId, docId), before)
        .hasChanges
    ).toBe(false);

    // Commit (the unchanged one-shot writer) and assert the DB now equals `next`.
    persistDocumentImport(profileId, docId, reprocessed);
    const after = getReprocessSnapshot(profileId, docId);
    expect(computeImportDiff(after, next).hasChanges).toBe(false);
  });
});

// The two preview-phantom classes: a byte-identical reprocess must preview clean.
//
// (1) Derived flags: applyImportFollowups → reconcileFlags writes app-derived
// flags (canonical ranges) onto persisted rows AFTER the persist boundary, while
// the preview's extraction side carries only source-stated flags — so every
// derived flag read as "changed: flag → none". previewReconcileFlags is the
// preview twin that derives the same flags onto the fresh input.
//
// (2) Consolidated medications (#1204): a drug a later document derives that the
// profile already tracks persists as renewal courses on the EXISTING item — no
// intake_items row carries the later document_id — so the later document's
// preview showed it as a phantom "+ added" med. foldConsolidatedMedsIntoSnapshot
// folds tracked matches into the persisted side.
describe("reprocess preview phantoms", () => {
  it("previewReconcileFlags derives the same flag the commit-side reconcile wrote", () => {
    const pid = newProfile("PHANTOM-FLAGS");
    const did = newDocument(pid, "flags.ccd");
    const glucoseHigh = () =>
      makeInput({
        records: [
          {
            category: "lab",
            name: "Glucose",
            canonical: "Glucose",
            value: "200",
            value_num: 200,
            unit: "mg/dL",
            date: DATE,
            reference_range: null,
            flag: null, // the source states no flag — the app derives one
            panel: "Metabolic",
            notes: null,
            source: "ccda",
            external_id: "obs:glucose-hi",
            loinc: null,
            provider: null,
            courses: null,
          },
          {
            // Qualitative pass: a durable-immunity titer gets a derived 'immune'
            // (#544) — the second flavor of app-derived flag the preview must mirror.
            category: "lab",
            name: "Rubella Antibody IgG",
            canonical: "Rubella Antibody IgG",
            value: "Immune",
            value_num: null,
            unit: null,
            date: DATE,
            reference_range: null,
            flag: null,
            panel: null,
            notes: null,
            source: "ccda",
            external_id: "obs:rubella-igg",
            loinc: null,
            provider: null,
            courses: null,
          },
        ],
        immunizations: [],
        allergies: [],
        conditions: [],
        encounters: [],
        bodyMetrics: [],
        heights: [],
        headCircs: [],
      });
    const persisted = persistDocumentImport(pid, did, glucoseHigh());
    applyImportFollowups(pid, {
      demographics: null,
      canonicalNames: [],
      insertedRecordIds: persisted.insertedRecordIds,
    });
    // Sanity: the follow-ups really derived both flag flavors (else vacuous).
    const storedFlags = db
      .prepare(
        "SELECT name, flag FROM medical_records WHERE profile_id = ? ORDER BY name"
      )
      .all(pid) as { name: string; flag: string | null }[];
    expect(storedFlags).toEqual([
      { name: "Glucose", flag: "high" },
      { name: "Rubella Antibody IgG", flag: "immune" },
    ]);

    // Without enrichment: the phantom (flag high/immune → none).
    const raw = glucoseHigh();
    expect(
      computeImportDiff(
        getReprocessSnapshot(pid, did),
        snapshotFromPersistInput(raw)
      ).hasChanges
    ).toBe(true);

    // With the preview twin: both flavors derived identically → clean.
    previewReconcileFlags(pid, raw.records);
    expect(raw.records[0].flag).toBe("high");
    expect(raw.records[1].flag).toBe("immune");
    expect(
      computeImportDiff(
        getReprocessSnapshot(pid, did),
        snapshotFromPersistInput(raw)
      ).hasChanges
    ).toBe(false);
  });

  it("foldConsolidatedMedsIntoSnapshot keeps a renewal-consolidated med out of 'added'", () => {
    const pid = newProfile("PHANTOM-MEDS");
    const rx = (name: string, ext: string) => ({
      category: "prescription" as const,
      name,
      canonical: name,
      value: null,
      value_num: null,
      unit: null,
      date: DATE,
      reference_range: null,
      flag: null,
      panel: null,
      notes: null,
      source: "ccda",
      external_id: ext,
      loinc: null,
      provider: null,
      courses: null,
    });
    const bare = {
      immunizations: [],
      allergies: [],
      conditions: [],
      encounters: [],
      bodyMetrics: [],
      heights: [],
      headCircs: [],
    };
    const docA = newDocument(pid, "A.ccd");
    persistDocumentImport(
      pid,
      docA,
      makeInput({ ...bare, records: [rx("Ibuprofen 200 mg", "med:ibu-a")] })
    );
    const inputB = () =>
      makeInput({
        ...bare,
        records: [
          rx("Ibuprofen 200 mg", "med:ibu-b"),
          rx("Cetirizine 10 mg", "med:cet-b"),
        ],
      });
    const docB = newDocument(pid, "B.ccd");
    persistDocumentImport(pid, docB, inputB());

    // The renewal consolidated Ibuprofen onto doc A's item — doc B owns only
    // Cetirizine, so the raw preview shows Ibuprofen as a phantom addition.
    const current = getReprocessSnapshot(pid, docB);
    expect(current.medications.map((m) => m.key)).toEqual(["med:cetirizine"]);
    const next = snapshotFromPersistInput(inputB());
    const rawDiff = computeImportDiff(current, next);
    expect(
      rawDiff.entities
        .find((e) => e.entity === "medications")!
        .added.map((m) => m.key)
    ).toEqual(["med:ibuprofen"]);

    // Folded: the tracked match compares unchanged; nothing added or removed.
    foldConsolidatedMedsIntoSnapshot(
      pid,
      current,
      next.medications,
      inputB().records
    );
    const folded = computeImportDiff(current, next);
    const meds = folded.entities.find((e) => e.entity === "medications")!;
    expect(meds.added).toEqual([]);
    expect(meds.removed).toEqual([]);
    expect(meds.unchanged.map((m) => m.key).sort()).toEqual([
      "med:cetirizine",
      "med:ibuprofen",
    ]);

    // A derived drug the profile does NOT track still previews as added.
    const withNew = makeInput({
      ...bare,
      records: [
        rx("Ibuprofen 200 mg", "med:ibu-b"),
        rx("Cetirizine 10 mg", "med:cet-b"),
        rx("Amoxicillin 400 mg", "med:amox-b"),
      ],
    });
    const current2 = getReprocessSnapshot(pid, docB);
    const next2 = snapshotFromPersistInput(withNew);
    foldConsolidatedMedsIntoSnapshot(
      pid,
      current2,
      next2.medications,
      withNew.records
    );
    const diff2 = computeImportDiff(current2, next2);
    expect(
      diff2.entities
        .find((e) => e.entity === "medications")!
        .added.map((m) => m.key)
    ).toEqual(["med:amoxicillin"]);
  });

  it("does NOT fold a #1027 concurrent-different-strength derived med — it previews as an addition (#1280)", () => {
    const pid = newProfile("PHANTOM-MEDS-1027");
    const rx = (name: string, ext: string) => ({
      category: "prescription" as const,
      name,
      canonical: name,
      value: null,
      value_num: null,
      unit: null,
      date: DATE,
      reference_range: null,
      flag: null,
      panel: null,
      notes: null,
      source: "ccda",
      external_id: ext,
      loinc: null,
      provider: null,
      courses: null,
    });
    const bare = {
      immunizations: [],
      allergies: [],
      conditions: [],
      encounters: [],
      bodyMetrics: [],
      heights: [],
      headCircs: [],
    };

    // Doc A tracks Ibuprofen 200 mg — a fresh import gives it a single OPEN course
    // at 200 mg (ensureMedicationCourse(..., stopped=false)), the #1027 precondition.
    const docA = newDocument(pid, "A.ccd");
    persistDocumentImport(
      pid,
      docA,
      makeInput({ ...bare, records: [rx("Ibuprofen 200 mg", "med:ibu-a")] })
    );
    // Doc B owns only Cetirizine (so it exists as this document's tracked med).
    const docB = newDocument(pid, "B.ccd");
    persistDocumentImport(
      pid,
      docB,
      makeInput({ ...bare, records: [rx("Cetirizine 10 mg", "med:cet-b")] })
    );

    // Sanity: the existing Ibuprofen really has an open course at 200 mg.
    const states = getMedMatchStates(pid);
    const ibu = states.find((s) =>
      s.name.toLowerCase().startsWith("ibuprofen")
    )!;
    expect(ibu.hasOpenCourse).toBe(true);
    expect(ibu.strengths).toContain("200 mg");

    // Now a reprocess of doc B derives Ibuprofen 800 mg (Rx) alongside its Cetirizine.
    // Commit-time classifyReprescription → "separate" (open course + provably
    // different strength) → a NEW item. So the preview MUST surface it as an addition.
    const reB = makeInput({
      ...bare,
      records: [
        rx("Ibuprofen 800 mg", "med:ibu-b"),
        rx("Cetirizine 10 mg", "med:cet-b"),
      ],
    });
    const current = getReprocessSnapshot(pid, docB);
    expect(current.medications.map((m) => m.key)).toEqual(["med:cetirizine"]);
    const next = snapshotFromPersistInput(reB);
    foldConsolidatedMedsIntoSnapshot(
      pid,
      current,
      next.medications,
      reB.records
    );
    const diff = computeImportDiff(current, next);
    const meds = diff.entities.find((e) => e.entity === "medications")!;
    // The genuinely-new Ibuprofen 800 mg is shown as added, NOT silently hidden.
    expect(meds.added.map((m) => m.key)).toEqual(["med:ibuprofen"]);
    expect(meds.unchanged.map((m) => m.key)).toEqual(["med:cetirizine"]);

    // Contrast: a SAME-strength renewal (Ibuprofen 200 mg) still folds to unchanged
    // — the #1204 phantom-diff fix is intact, the #1280 correction is precise.
    const renewB = makeInput({
      ...bare,
      records: [
        rx("Ibuprofen 200 mg", "med:ibu-b"),
        rx("Cetirizine 10 mg", "med:cet-b"),
      ],
    });
    const current2 = getReprocessSnapshot(pid, docB);
    const next2 = snapshotFromPersistInput(renewB);
    foldConsolidatedMedsIntoSnapshot(
      pid,
      current2,
      next2.medications,
      renewB.records
    );
    const meds2 = computeImportDiff(current2, next2).entities.find(
      (e) => e.entity === "medications"
    )!;
    expect(meds2.added).toEqual([]);
    expect(meds2.unchanged.map((m) => m.key).sort()).toEqual([
      "med:cetirizine",
      "med:ibuprofen",
    ]);
  });
});

// (3) Canonical-vocabulary feedback: an import carrying TWO spellings of one
// analyte ("Zeta Antibody IgG" / "Zeta Antibody (IgG)" — same normalized key)
// used to register BOTH into the vocabulary (each record snapped only against the
// PRE-import vocabulary), splitting the series and making the next snap's winner
// an arbitrary alphabetical pick — so a byte-identical reprocess renamed
// canonicals. The batch-aware snap collapses same-key spellings within one import
// onto the first occurrence.
describe("intra-batch canonical collapse (end-to-end)", () => {
  const TWO_SPELLINGS_CCD = `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <effectiveTime value="20200501"/>
  <recordTarget><patientRole><patient>
    <name><given>Test</given><family>Patient</family></name>
  </patient></patientRole></recordTarget>
  <component><structuredBody>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
      <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Results</title>
      <entry><organizer classCode="BATTERY" moodCode="EVN">
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="99991-1" codeSystem="2.16.840.1.113883.6.1" displayName="Zeta Antibody IgG"/>
          <effectiveTime value="20200501"/>
          <value type="PQ" value="10" unit="U/mL"/>
        </observation></component>
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="99992-9" codeSystem="2.16.840.1.113883.6.1" displayName="Zeta Antibody (IgG)"/>
          <effectiveTime value="20200501"/>
          <value type="PQ" value="20" unit="U/mL"/>
        </observation></component>
      </organizer></entry>
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;

  it("one import of two same-key spellings yields one canonical, one vocabulary entry, and a clean preview", () => {
    const pid = newProfile("BATCH-SNAP");
    const did = newDocument(pid, "two-spellings.ccd");
    const buffer = Buffer.from(TWO_SPELLINGS_CCD);
    const outcome = persistHealthRecordDoc(pid, did, buffer);
    expect(outcome.status).toBe("done");

    // Both rows share the batch's FIRST spelling; only that one registered.
    const canonicals = db
      .prepare(
        "SELECT DISTINCT canonical_name FROM medical_records WHERE profile_id = ?"
      )
      .all(pid) as { canonical_name: string }[];
    expect(canonicals.map((c) => c.canonical_name)).toEqual([
      "Zeta Antibody IgG",
    ]);
    const vocab = db
      .prepare("SELECT name FROM canonical_biomarkers WHERE name LIKE 'Zeta%'")
      .all() as { name: string }[];
    expect(vocab.map((v) => v.name)).toEqual(["Zeta Antibody IgG"]);

    // Reprocess preview (the extractPersistInputForPreview shape): re-parse,
    // batch-snap against the NOW-registered vocabulary, enrich, diff → clean.
    const { parsed, source } = parseHealthRecord(buffer);
    const index = buildCanonicalIndex(getCanonicalVocabulary());
    for (const r of parsed.records) {
      r.canonical = snapCanonicalNameIntoBatch(
        distinguishVitaminDIsoform(r.canonical, r.name),
        index
      );
    }
    const input = healthRecordToPersistInput(parsed, source, "MyChart export");
    previewReconcileFlags(pid, input.records);
    const current = getReprocessSnapshot(pid, did);
    const next = snapshotFromPersistInput(input);
    foldConsolidatedMedsIntoSnapshot(
      pid,
      current,
      next.medications,
      input.records
    );
    expect(computeImportDiff(current, next).hasChanges).toBe(false);
  });
});

// Deferred body metrics / height / head-circ (the reprocess phantom-add fix): when a
// weight / height / head-circ shares a date with a metric ALREADY held by another
// source, a reprocess DEFERS it (never overwrites) — so it isn't stored under this
// document, yet the defer-blind fresh snapshot keeps proposing it. Without the prune
// it reads as a phantom "add" on every reprocess; pruneDeferredMetricsFromSnapshot
// reconciles `next` with the same defer the commit applies.
describe("reprocess-diff — deferred body metrics don't phantom-add", () => {
  it("prunes a metric another document already covers for the date", () => {
    const pid = newProfile("DEFER");
    const doc1 = newDocument(pid, "one.ccd");
    const doc2 = newDocument(pid, "two.ccd");
    // doc1 lands the weight/height/head-circ for DATE; doc2's identical metrics defer.
    persistDocumentImport(pid, doc1, makeInput());
    persistDocumentImport(pid, doc2, makeInput());

    // doc2 holds NO body_metrics/metric_samples rows (all deferred to doc1).
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM body_metrics WHERE profile_id = ? AND source = ?"
          )
          .get(pid, `document:${doc2}`) as { n: number }
      ).n
    ).toBe(0);

    const input = makeInput();
    const current = getReprocessSnapshot(pid, doc2);
    const next = snapshotFromPersistInput(input);

    // Without the prune, the fresh side re-proposes the deferred metrics → phantom add.
    const naive = computeImportDiff(current, next);
    const entity = (d: typeof naive, name: string) =>
      (d.entities ?? []).find((e) => e.entity === name);
    expect(entity(naive, "bodyMetrics")?.added.length ?? 0).toBeGreaterThan(0);
    expect(entity(naive, "heights")?.added.length ?? 0).toBeGreaterThan(0);
    expect(entity(naive, "headCircs")?.added.length ?? 0).toBeGreaterThan(0);

    // With the prune, an unchanged reprocess previews clean for the deferred metrics.
    pruneDeferredMetricsFromSnapshot(pid, doc2, next, input);
    const fixed = computeImportDiff(current, next);
    expect(entity(fixed, "bodyMetrics")?.added.length ?? 0).toBe(0);
    expect(entity(fixed, "heights")?.added.length ?? 0).toBe(0);
    expect(entity(fixed, "headCircs")?.added.length ?? 0).toBe(0);
  });

  it("does NOT prune a metric only this document covers (a genuine reading survives)", () => {
    const pid = newProfile("DEFER-SOLO");
    const doc = newDocument(pid, "solo.ccd");
    persistDocumentImport(pid, doc, makeInput());
    const input = makeInput();
    const current = getReprocessSnapshot(pid, doc);
    const next = snapshotFromPersistInput(input);
    // Only this document holds the metric, so the prune must leave `next` intact and
    // the reprocess previews clean (current already has the same rows).
    pruneDeferredMetricsFromSnapshot(pid, doc, next, input);
    expect(computeImportDiff(current, next).hasChanges).toBe(false);
    expect(next.bodyMetrics.length).toBe(1);
    expect(next.heights.length).toBe(1);
    expect(next.headCircs.length).toBe(1);
  });
});
