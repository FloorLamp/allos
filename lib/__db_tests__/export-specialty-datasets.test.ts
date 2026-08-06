// DB INTEGRATION TIER — the two specialty record types that shipped in NO export
// bundle (issue #1846).
//
// `dental_procedures` and `skin_lesions` were export-allowlisted on the argument
// that neither has a FHIR structured feed — which conflated portability with FHIR.
// Both are manually-created (or document-extracted) clinical record types with their
// own page and their own finding→follow-up loop, and a user who tracked a mole for a
// year had no way to take that record to a new dermatologist. They are flat datasets
// now, exactly like imaging_studies, which has no FHIR builder either.
//
// This drives the real dataset readers end to end against realistic rows: create →
// export → assert the exported content, plus the CSV header, the provider resolution,
// and profile scoping.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { DATASETS, getDataset, toCsv } from "@/lib/export";
import { resolveProviderId } from "@/lib/providers-db";

let mine: number;
let theirs: number;

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

beforeAll(() => {
  mine = newProfile("SPECIALTY-MINE");
  theirs = newProfile("SPECIALTY-THEIRS");

  // Through the real registry resolver, so the rows carry the dedup key the
  // providers dataset is read against.
  const dentist = resolveProviderId({
    name: "Riverbend Dental",
    type: "organization",
    phone: "555-0100",
  })!;
  const derm = resolveProviderId({
    name: "Northgate Dermatology",
    type: "organization",
  })!;

  // A document the extraction provenance points at, so document_id is a real
  // cross-reference into the bundle's own medical_documents dataset.
  const docId = Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, doc_type, extraction_status)
         VALUES (?, 'dental-chart.pdf', 'data/uploads/medical/x/dental-chart.pdf',
                 'dental', 'done')`
      )
      .run(mine).lastInsertRowid
  );

  // Two dental rows: a completed restoration with a full tooth identity, and a
  // 'watch' finding carrying a follow-up interval (the finding→follow-up loop).
  db.prepare(
    `INSERT INTO dental_procedures
       (profile_id, name, status, tooth, tooth_system, surface, cdt_code,
        procedure_date, finding, follow_up_interval_days, provider_id, notes,
        source, document_id, external_id)
     VALUES (?, 'Composite restoration', 'completed', '19', 'universal', 'MO', 'D2392',
             '2026-02-11', NULL, NULL, ?, 'No sensitivity after', 'extracted', ?, 'ext-1')`
  ).run(mine, dentist, docId);
  db.prepare(
    `INSERT INTO dental_procedures
       (profile_id, name, status, tooth, tooth_system, procedure_date, finding,
        follow_up_interval_days, provider_id, source)
     VALUES (?, 'Periodontal charting', 'watch', '30', 'universal', '2026-05-04',
             'Pocket depth 5mm distal', 180, ?, 'manual')`
  ).run(mine, dentist);

  // Two lesion rows: a watched mole with a full ABCDE record and a size, and a
  // removed one. The mole is the "year of tracking" case the issue is about.
  db.prepare(
    `INSERT INTO skin_lesions
       (profile_id, label, body_region, body_side, size_mm, asymmetry, border, color,
        diameter, evolving, status, observed_date, finding, follow_up_interval_days,
        provider_id, notes, source, external_id)
     VALUES (?, 'Upper back mole', 'back', 'left', 6.5, 1, 1, 0, 1, 1, 'watch',
             '2026-04-02', 'Asymmetric, re-check in 6 months', 180, ?,
             'Photographed monthly', 'manual', 'ext-2')`
  ).run(mine, derm);
  db.prepare(
    `INSERT INTO skin_lesions
       (profile_id, label, body_region, status, observed_date, source)
     VALUES (?, 'Forearm seborrheic keratosis', 'arm', 'removed', '2025-11-20', 'manual')`
  ).run(mine);

  // The other profile's rows — nothing here may reach `mine`'s export.
  db.prepare(
    `INSERT INTO dental_procedures (profile_id, name, status, procedure_date)
     VALUES (?, 'THEIRS crown', 'completed', '2026-03-03')`
  ).run(theirs);
  db.prepare(
    `INSERT INTO skin_lesions (profile_id, label, status, observed_date)
     VALUES (?, 'THEIRS lesion', 'active', '2026-03-03')`
  ).run(theirs);
});

describe("dental_procedures is an exported dataset (#1846)", () => {
  it("round-trips the procedure identity, the finding, and its provenance", () => {
    const ds = getDataset("dental_procedures")!;
    const rows = ds.rows(mine);
    expect(rows).toHaveLength(2);

    // Newest procedure_date first.
    expect(rows.map((r) => r.name)).toEqual([
      "Periodontal charting",
      "Composite restoration",
    ]);

    const restoration = rows.find((r) => r.name === "Composite restoration")!;
    expect(restoration).toMatchObject({
      procedure_date: "2026-02-11",
      status: "completed",
      tooth: "19",
      tooth_system: "universal",
      surface: "MO",
      cdt_code: "D2392",
      notes: "No sensitivity after",
      source: "extracted",
      // The provider is resolved to a NAME — the portable fact for a domain with no
      // FHIR resource to carry the reference.
      provider: "Riverbend Dental",
    });
    expect(restoration.document_id).toEqual(expect.any(Number));

    // The finding→follow-up loop survives the trip.
    expect(rows.find((r) => r.name === "Periodontal charting")).toMatchObject({
      status: "watch",
      finding: "Pocket depth 5mm distal",
      follow_up_interval_days: 180,
    });
  });

  it("exports as CSV with the declared header and is browse-only", () => {
    const ds = getDataset("dental_procedures")!;
    const csv = toCsv(ds.columns, ds.rows(mine));
    expect(csv.split("\n")[0]).toBe(ds.columns.join(","));
    expect(csv).toContain("Composite restoration");
    // No id + profile_id delete: the care_plan_items follow-up chain references
    // these rows, so deletion lives on the dental page.
    expect(ds.deletable).toBe(false);
  });

  it("is scoped to the asked profile", () => {
    const ds = getDataset("dental_procedures")!;
    expect(ds.rows(mine).some((r) => String(r.name).startsWith("THEIRS"))).toBe(
      false
    );
    expect(ds.count(mine)).toBe(2);
    expect(ds.count(theirs)).toBe(1);
  });
});

describe("skin_lesions is an exported dataset (#1846)", () => {
  it("round-trips the lesion identity, size, and every ABCDE observation", () => {
    const ds = getDataset("skin_lesions")!;
    const rows = ds.rows(mine);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.label)).toEqual([
      "Upper back mole",
      "Forearm seborrheic keratosis",
    ]);

    expect(rows[0]).toMatchObject({
      label: "Upper back mole",
      body_region: "back",
      body_side: "left",
      status: "watch",
      observed_date: "2026-04-02",
      size_mm: 6.5,
      asymmetry: 1,
      border: 1,
      color: 0,
      diameter: 1,
      evolving: 1,
      finding: "Asymmetric, re-check in 6 months",
      follow_up_interval_days: 180,
      provider: "Northgate Dermatology",
      notes: "Photographed monthly",
      source: "manual",
    });
    // A lesion recorded with no provider exports a null, not a dangling id.
    expect(rows[1].provider).toBeNull();
  });

  it("exports as CSV with the declared header and is browse-only", () => {
    const ds = getDataset("skin_lesions")!;
    const csv = toCsv(ds.columns, ds.rows(mine));
    expect(csv.split("\n")[0]).toBe(ds.columns.join(","));
    expect(csv).toContain("Upper back mole");
    expect(ds.deletable).toBe(false);
  });

  it("is scoped to the asked profile", () => {
    const ds = getDataset("skin_lesions")!;
    expect(
      ds.rows(mine).some((r) => String(r.label).startsWith("THEIRS"))
    ).toBe(false);
    expect(ds.count(mine)).toBe(2);
    expect(ds.count(theirs)).toBe(1);
  });
});

describe("both datasets keep their linked providers in the bundle (#1846)", () => {
  it("exports the providers the dental/lesion rows reference", () => {
    // The providers dataset is exactly the providers REFERENCED by this profile's
    // rows; without the two new PROVIDER_LINK_SELECTS entries these would be the
    // only rows in the archive naming a provider that isn't in it.
    const names = getDataset("providers")!
      .rows(mine)
      .map((r) => r.name);
    expect(names).toContain("Riverbend Dental");
    expect(names).toContain("Northgate Dermatology");
    // The other profile references neither.
    expect(getDataset("providers")!.rows(theirs)).toEqual([]);
  });

  it("both datasets are registered, so the archive writes their JSON + CSV", () => {
    const keys = DATASETS.map((d) => d.key);
    expect(keys).toContain("dental_procedures");
    expect(keys).toContain("skin_lesions");
  });
});
