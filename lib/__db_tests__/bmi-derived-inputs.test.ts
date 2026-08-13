// DB INTEGRATION TIER — issue #2646: the `derived-inputs` reach arm finally has an
// ingest consequence, and the rows it never had one for are retired.
//
// WHAT WAS BROKEN. `METRIC_DOCUMENT_REACH.bmi` declares `reaches: "derived-inputs"` —
// BMI has no row of its own, and `/trends/metric/bmi` computes it from the weight and
// height that arrive in the same document, both of which are themselves projected.
// That declaration removes "Body Mass Index" from the flat Biomarkers browser. But
// unlike every other REACHING variant it resolved nothing at ingest: no projector, no
// destination, no drop. So the imported `medical_records` row survived, an AI import
// coined an `ai` `canonical_biomarkers` name for it, and the name sat under
// Data → Coverage → "Uncatalogued items" forever — a permanent outstanding candidate
// for a quantity the app already answers on a chart.
//
// The first suite proves the FORWARD arm through a real C-CDA import (the whole
// pipeline, not the shape mapper in isolation): no BMI record is written, the inputs
// still are, and the Coverage surface — which is what the issue is actually about —
// offers nothing. The second proves the MIGRATION over the rows already on disk.
//
// SYNTHETIC ONLY: an invented patient, fictional dates, low-entropy values, and a
// clearly fake document id. No PHI.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ingestMedicalUpload } from "@/lib/medical-pipeline";
import { seedActor } from "@/lib/__action_tests__/harness";
import { getCanonicalVocabulary, getUsedCanonicalNames } from "@/lib/queries";
import { getCoverageGapCandidates } from "@/lib/queries/coverage";
import { up } from "@/lib/migrations/versions/20260813-bmi-derived-rows";

const VISIT = "2026-04-08";
const VISIT_HL7 = "20260408";

// A vitals section that prints the two INPUTS and the derived result beside them,
// which is the shape every real encounter summary has. `inputs: false` reproduces the
// other observed shape: a visit that recorded vitals only and echoed a BMI carried
// forward from an earlier chart.
function ccda(opts: { inputs: boolean }): string {
  const inputs = opts.inputs
    ? `
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="29463-7" codeSystem="2.16.840.1.113883.6.1" displayName="Body weight"/>
          <effectiveTime value="${VISIT_HL7}"/>
          <value xsi:type="PQ" value="70" unit="kg"/>
        </observation></component>
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="8302-2" codeSystem="2.16.840.1.113883.6.1" displayName="Body height"/>
          <effectiveTime value="${VISIT_HL7}"/>
          <value xsi:type="PQ" value="170" unit="cm"/>
        </observation></component>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <id root="1.2.3.4" extension="20260408001"/>
  <effectiveTime value="${VISIT_HL7}"/>
  <recordTarget><patientRole><patient>
    <name><given>Wren</given><family>Placeholder</family></name>
    <administrativeGenderCode code="F"/>
    <birthTime value="19900101"/>
  </patient></patientRole></recordTarget>
  <component><structuredBody>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.4.1"/>
      <code code="8716-3" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Vital Signs</title>
      <entry><organizer classCode="CLUSTER" moodCode="EVN">${inputs}
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="39156-5" codeSystem="2.16.840.1.113883.6.1" displayName="Body mass index (BMI)"/>
          <effectiveTime value="${VISIT_HL7}"/>
          <value xsi:type="PQ" value="24.2" unit="kg/m2"/>
        </observation></component>
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="8310-5" codeSystem="2.16.840.1.113883.6.1" displayName="Body temperature"/>
          <effectiveTime value="${VISIT_HL7}"/>
          <value xsi:type="PQ" value="36.8" unit="Cel"/>
        </observation></component>
      </organizer></entry>
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;
}

async function importOnce(opts: { inputs: boolean }, filename: string) {
  const { login, profile } = seedActor();
  await ingestMedicalUpload(
    login.id,
    profile.id,
    new File([Buffer.from(ccda(opts))], filename, { type: "application/xml" })
  );
  return profile;
}

function recordNames(profileId: number): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM medical_records WHERE profile_id = ? ORDER BY name"
      )
      .all(profileId) as { name: string }[]
  ).map((r) => r.name);
}

describe("the derived-inputs arm drops a printed BMI at ingest (#2646)", () => {
  it("writes no BMI record when the document carried its inputs", async () => {
    const profile = await importOnce({ inputs: true }, "visit-inputs.xml");
    const names = recordNames(profile.id);
    expect(names.some((n) => /body mass index|bmi/i.test(n))).toBe(false);
    // …while the reading that IS a chart point is untouched, so the drop is aimed at
    // the derived row rather than at the whole vitals organizer.
    expect(names).toContain("Body temperature");
  });

  it("still projects the INPUTS, which is what makes the drop safe", async () => {
    // The declaration's own claim: "the quantity is charted from the same import".
    // Weight goes to body_metrics, height to metric_samples — both charted, and both
    // feeding bmiSeriesDatePaired.
    const profile = await importOnce({ inputs: true }, "visit-inputs-2.xml");
    const weight = db
      .prepare(
        "SELECT weight_kg FROM body_metrics WHERE profile_id = ? AND date = ?"
      )
      .get(profile.id, VISIT) as { weight_kg: number } | undefined;
    expect(weight?.weight_kg).toBe(70);
    const height = db
      .prepare(
        "SELECT value FROM metric_samples WHERE profile_id = ? AND metric = 'height_cm' AND date = ?"
      )
      .get(profile.id, VISIT) as { value: number } | undefined;
    expect(height?.value).toBe(170);
  });

  it("writes no BMI record when the document carried NO inputs either", async () => {
    // The carry-forward case, and the drop is deliberately unconditional: a visit that
    // recorded no weight and no height printed a chart value from an earlier one, so
    // the number is an echo rather than a measurement (#2646's evidence — an identical
    // BMI to two decimals six days apart, a flat BMI two months on for a toddler).
    const profile = await importOnce({ inputs: false }, "visit-echo.xml");
    expect(recordNames(profile.id)).toEqual(["Body temperature"]);
  });

  // THE SURFACE THIS ISSUE IS ABOUT. Row counts are the mechanism; the complaint was
  // a permanent Coverage candidate, so that is asserted directly.
  it("leaves the name out of the vocabulary and off Coverage", async () => {
    const profile = await importOnce({ inputs: true }, "visit-coverage.xml");
    const used = getUsedCanonicalNames(profile.id);
    expect(used.some((n) => /body mass index|bmi/i.test(n))).toBe(false);
    const vocab = getCanonicalVocabulary();
    expect(vocab).not.toContain("Body Mass Index (BMI)");
    const candidates = getCoverageGapCandidates(profile.id).map((c) => c.label);
    expect(candidates.some((n) => /body mass index|bmi/i.test(n))).toBe(false);
  });
});

// ---- the migration over the rows already on disk ----------------------------

// The minimal pre-migration shape (the 165/171/174/176/180 pattern), so every claim
// is about this migration and not about whatever else the baseline supplies.
function preMigrationDb(): Database.Database {
  const mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE medical_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      category TEXT,
      name TEXT,
      canonical_name TEXT,
      value TEXT,
      value_num REAL
    );
    CREATE TABLE care_plan_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      source_medical_record_id INTEGER,
      resolved_by_medical_record_id INTEGER
    );
    CREATE TABLE intake_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      source_record_id INTEGER
    );
    CREATE TABLE canonical_biomarkers (name TEXT PRIMARY KEY, source TEXT);
    CREATE TABLE saved_items (
      profile_id INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL
    );
    CREATE TABLE coverage_gaps (
      profile_id INTEGER NOT NULL, kind TEXT NOT NULL, item_key TEXT NOT NULL
    );
    CREATE TABLE upcoming_dismissals (
      profile_id INTEGER NOT NULL, signal_key TEXT NOT NULL
    );
  `);
  mem
    .prepare("INSERT INTO profiles (id, name) VALUES (1, 'A'), (2, 'B')")
    .run();
  const rec = mem.prepare(
    `INSERT INTO medical_records
       (id, profile_id, date, category, name, canonical_name, value, value_num)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // Profile 1 — the three spellings a real import produced, all one quantity.
  rec.run(11, 1, VISIT, "vitals", "BMI", "Body Mass Index (BMI)", "24.2", 24.2);
  rec.run(
    12,
    1,
    "2026-04-14",
    "vitals",
    "Body Mass Index",
    "Body Mass Index (BMI)",
    "24.2",
    24.2
  );
  rec.run(
    13,
    1,
    "2026-05-02",
    "vitals",
    "Body Mass Index (BMI)",
    null,
    "24.2",
    24.2
  );
  // The BMI PERCENTILE is a different quantity — an age/sex percentile the app
  // recomputes from the growth curves — and it must survive.
  rec.run(
    14,
    1,
    VISIT,
    "vitals",
    "Body Mass Index Percentile",
    "Body Mass Index Percentile",
    "62",
    62
  );
  // The INPUTS, and a neighbour that merely shares the section: all untouched.
  rec.run(15, 1, VISIT, "vitals", "Body weight", "Weight", "70", 70);
  rec.run(16, 1, VISIT, "vitals", "Body temperature", null, "36.8", 36.8);
  // Profile 2 — a BMI a care-plan item still points at, which is skipped rather than
  // deleted (an FK parent is a bigger claim than this issue makes).
  rec.run(21, 2, VISIT, "vitals", "BMI", "Body Mass Index (BMI)", "22.0", 22);
  mem
    .prepare(
      "INSERT INTO care_plan_items (profile_id, source_medical_record_id) VALUES (2, 21)"
    )
    .run();
  // The name-keyed state a stored BMI reading accumulates.
  mem
    .prepare("INSERT INTO canonical_biomarkers (name, source) VALUES (?, 'ai')")
    .run("Body Mass Index (BMI)");
  for (const pid of [1, 2]) {
    mem
      .prepare(
        "INSERT INTO saved_items (profile_id, kind, key) VALUES (?, 'biomarker', ?)"
      )
      .run(pid, "Body Mass Index (BMI)");
    mem
      .prepare(
        "INSERT INTO coverage_gaps (profile_id, kind, item_key) VALUES (?, 'biomarker', ?)"
      )
      .run(pid, "body mass index (bmi)");
    mem
      .prepare(
        "INSERT INTO upcoming_dismissals (profile_id, signal_key) VALUES (?, ?)"
      )
      .run(pid, "biomarker:body mass index (bmi)");
  }
  return mem;
}

function ids(mem: Database.Database, profileId: number): number[] {
  return (
    mem
      .prepare(
        "SELECT id FROM medical_records WHERE profile_id = ? ORDER BY id"
      )
      .all(profileId) as { id: number }[]
  ).map((r) => r.id);
}

function count(mem: Database.Database, sql: string): number {
  return (mem.prepare(sql).get() as { n: number }).n;
}

describe("migration 20260813 — the BMI rows already on disk (#2646)", () => {
  it("retires every spelling of the derived reading", () => {
    const mem = preMigrationDb();
    up(mem);
    // 11/12/13 gone; the percentile, the inputs and the neighbour stay.
    expect(ids(mem, 1)).toEqual([14, 15, 16]);
  });

  it("SKIPS a row a care-plan item still references", () => {
    const mem = preMigrationDb();
    up(mem);
    expect(ids(mem, 2)).toEqual([21]);
  });

  it("sweeps the side-state of the profile that lost the name", () => {
    const mem = preMigrationDb();
    up(mem);
    expect(
      count(mem, "SELECT COUNT(*) AS n FROM saved_items WHERE profile_id = 1")
    ).toBe(0);
    expect(
      count(mem, "SELECT COUNT(*) AS n FROM coverage_gaps WHERE profile_id = 1")
    ).toBe(0);
    expect(
      count(
        mem,
        "SELECT COUNT(*) AS n FROM upcoming_dismissals WHERE profile_id = 1"
      )
    ).toBe(0);
  });

  it("KEEPS the side-state of the profile whose row was skipped", () => {
    // The sweep's condition is "no identity-carrying row is left", not "the migration
    // ran". A ★ or a snooze whose subject still exists is not orphaned.
    const mem = preMigrationDb();
    up(mem);
    expect(
      count(mem, "SELECT COUNT(*) AS n FROM saved_items WHERE profile_id = 2")
    ).toBe(1);
    expect(
      count(mem, "SELECT COUNT(*) AS n FROM coverage_gaps WHERE profile_id = 2")
    ).toBe(1);
  });

  it("keeps the ai vocabulary row while ANY profile still backs the name", () => {
    // Profile 2's skipped row is exactly that case, and the vocabulary table is
    // global — so the cross-profile question is answered by unioning each profile's
    // own surviving names, never by an unscoped read.
    const mem = preMigrationDb();
    up(mem);
    expect(count(mem, "SELECT COUNT(*) AS n FROM canonical_biomarkers")).toBe(
      1
    );
  });

  it("drops the ai vocabulary row once no profile backs the name", () => {
    const mem = preMigrationDb();
    mem.prepare("DELETE FROM care_plan_items").run();
    up(mem);
    expect(count(mem, "SELECT COUNT(*) AS n FROM canonical_biomarkers")).toBe(
      0
    );
  });

  it("never deletes a CURATED vocabulary row (#2306)", () => {
    const mem = preMigrationDb();
    mem.prepare("DELETE FROM care_plan_items").run();
    mem
      .prepare("UPDATE canonical_biomarkers SET source = 'seed' WHERE name = ?")
      .run("Body Mass Index (BMI)");
    up(mem);
    expect(count(mem, "SELECT COUNT(*) AS n FROM canonical_biomarkers")).toBe(
      1
    );
  });

  it("is idempotent — a second run finds nothing left", () => {
    const mem = preMigrationDb();
    up(mem);
    const after = [...ids(mem, 1), ...ids(mem, 2)];
    up(mem);
    expect([...ids(mem, 1), ...ids(mem, 2)]).toEqual(after);
  });

  it("runs on a database that has no BMI reading at all", () => {
    const mem = preMigrationDb();
    mem
      .prepare(
        "DELETE FROM medical_records WHERE name LIKE '%BMI%' OR name LIKE '%Mass Index%'"
      )
      .run();
    expect(() => up(mem)).not.toThrow();
    expect(count(mem, "SELECT COUNT(*) AS n FROM canonical_biomarkers")).toBe(
      1
    );
  });

  // THE COVERAGE CONSEQUENCE, against the REAL schema and the real read — the surface
  // the issue reports, rather than the row count that causes it.
  it("removes the name from getUsedCanonicalNames on a real database", () => {
    const { profile } = seedActor();
    db.prepare(
      `INSERT INTO medical_records (profile_id, date, category, name, canonical_name, value, value_num)
       VALUES (?, ?, 'vitals', 'BMI', 'Body Mass Index (BMI)', '24.2', 24.2)`
    ).run(profile.id, VISIT);
    expect(getUsedCanonicalNames(profile.id)).toContain(
      "Body Mass Index (BMI)"
    );
    up(db);
    expect(getUsedCanonicalNames(profile.id)).not.toContain(
      "Body Mass Index (BMI)"
    );
  });
});
