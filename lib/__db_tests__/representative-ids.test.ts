// DB INTEGRATION TIER — the extracted representative-row builder (issue #2035)
// selects the SAME rows the seven hand-written copies selected.
//
// The pure tier (lib/__tests__/representative-ids.test.ts) pins the emitted SQL TEXT
// against the pre-extraction statements; this tier pins the ROWS. Each of the seven
// former sites gets its own case, built the same way: store the same entry twice —
// once as a MANUAL row and once as an IMPORTED twin carrying a document — then read
// through the real query function and assert (a) the twins collapsed to exactly one
// row and (b) the survivor is the MANUAL one, which is the preference axis every site
// declares. Immunizations is the one that spells that preference on `source` rather
// than `document_id` (that table has no document_id column), so its case is what
// proves the named axis variant still behaves like its six siblings.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts. Synthetic,
// clearly fictional clinical vocabulary only (no PHI).

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  getAllergies,
  getConditions,
  getEncounters,
  getFamilyHistory,
  getImmunizations,
  getMedicalRecords,
  getProcedures,
} from "@/lib/queries";
import { biomarkerFamilyKey } from "@/lib/queries/medical";
import {
  REPRESENTATIVE_SPECS,
  medicalDedupSpec,
  medicalLatestSpec,
  representativeCte,
  representativeIds,
} from "@/lib/representative-ids";

let seq = 0;
function newProfile(): number {
  seq += 1;
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`rep-ids-${seq}`)
      .lastInsertRowid
  );
}

function newDoc(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents (profile_id, filename, stored_path, extraction_status)
         VALUES (?, 'ccd.xml', '', 'done')`
      )
      .run(profileId).lastInsertRowid
  );
}

// Insert the same logical entry twice: manual first (lower id, so a naive `id DESC`
// would pick the IMPORTED one — the preference axis is what makes the manual row win).
function twins(sql: string, manual: unknown[], imported: unknown[]) {
  const stmt = db.prepare(sql);
  return {
    manualId: Number(stmt.run(...(manual as never[])).lastInsertRowid),
    importedId: Number(stmt.run(...(imported as never[])).lastInsertRowid),
  };
}

describe("representativeIds — the seven former sites still collapse to the manual twin", () => {
  it("allergies (was ALLERGY_REPRESENTATIVE_IDS)", () => {
    const p = newProfile();
    const doc = newDoc(p);
    const { manualId } = twins(
      `INSERT INTO allergies (profile_id, substance, reaction, status, document_id)
       VALUES (?, ?, ?, 'active', ?)`,
      [p, "Testolin", "hives", null],
      [p, "Testolin", "hives", doc]
    );
    const rows = getAllergies(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(manualId);
  });

  it("conditions (was CONDITION_REPRESENTATIVE_IDS), and the #193 active-first precedence", () => {
    const p = newProfile();
    const doc = newDoc(p);
    const { manualId } = twins(
      `INSERT INTO conditions (profile_id, name, code, status, document_id)
       VALUES (?, ?, NULL, 'active', ?)`,
      [p, "Fictitious arthropathy", null],
      [p, "Fictitious arthropathy", doc]
    );
    const rows = getConditions(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(manualId);

    // The precedence term still outranks the preference axis: an ACTIVE imported twin
    // beats a RESOLVED manual one, so an active-filtered view can never be emptied.
    const q = newProfile();
    const qdoc = newDoc(q);
    db.prepare(
      `INSERT INTO conditions (profile_id, name, status, document_id)
       VALUES (?, 'Fictitious dermatosis', 'resolved', NULL)`
    ).run(q);
    const activeImported = Number(
      db
        .prepare(
          `INSERT INTO conditions (profile_id, name, status, document_id)
           VALUES (?, 'Fictitious dermatosis', 'active', ?)`
        )
        .run(q, qdoc).lastInsertRowid
    );
    const all = getConditions(q);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(activeImported);
    // And the status push-down still picks a representative from the matching rows
    // only, so the filtered view is not emptied by the other twin.
    expect(getConditions(q, { status: "resolved" })).toHaveLength(1);
  });

  it("procedures (was PROCEDURE_REPRESENTATIVE_IDS)", () => {
    const p = newProfile();
    const doc = newDoc(p);
    const { manualId } = twins(
      `INSERT INTO procedures (profile_id, name, date, document_id)
       VALUES (?, ?, '2024-03-02', ?)`,
      [p, "Fictitious arthroscopy", null],
      [p, "Fictitious arthroscopy", doc]
    );
    const rows = getProcedures(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(manualId);
  });

  it("family_history (was FAMILY_HISTORY_REPRESENTATIVE_IDS)", () => {
    const p = newProfile();
    const doc = newDoc(p);
    const { manualId } = twins(
      `INSERT INTO family_history (profile_id, relation, condition, document_id)
       VALUES (?, 'Mother', ?, ?)`,
      [p, "Fictitious cardiomyopathy", null],
      [p, "Fictitious cardiomyopathy", doc]
    );
    const rows = getFamilyHistory(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(manualId);
  });

  it("encounters (was ENCOUNTER_REPRESENTATIVE_IDS)", () => {
    const p = newProfile();
    const doc = newDoc(p);
    const { manualId } = twins(
      `INSERT INTO encounters (profile_id, date, type, reason, document_id)
       VALUES (?, '2024-05-06', 'office', ?, ?)`,
      [p, "annual review", null],
      [p, "annual review", doc]
    );
    const rows = getEncounters(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(manualId);
  });

  it("medical_records (was DEDUP_IDS_CTE), and is_latest still ranks over the survivor", () => {
    const p = newProfile();
    const doc = newDoc(p);
    const { manualId } = twins(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, value_num, unit, document_id)
       VALUES (?, '2024-01-10', 'lab', 'Glucose', '95', 95, 'mg/dL', ?)`,
      [p, null],
      [p, doc]
    );
    // An older reading of the same analyte, so the latest CTE has something to rank.
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, value_num, unit)
       VALUES (?, '2023-01-10', 'lab', 'Glucose', '88', 88, 'mg/dL')`
    ).run(p);

    const rows = getMedicalRecords(p);
    expect(rows).toHaveLength(2);
    // The 2024 twins collapsed to the manual row…
    expect(rows.map((r) => r.id)).toContain(manualId);
    // …and the LATEST CTE (was LATEST_IDS_CTE) marks exactly that row current.
    const latest = rows.filter((r) => r.is_latest);
    expect(latest).toHaveLength(1);
    expect(latest[0].id).toBe(manualId);
  });

  it("immunizations (was the inline imm_deduped) — the `source` preference axis", () => {
    const p = newProfile();
    const doc = newDoc(p);
    const { manualId } = twins(
      `INSERT INTO immunizations (profile_id, date, vaccine, dose_label, source)
       VALUES (?, '2024-09-01', 'Fictitious vaccine', '1', ?)`,
      [p, "manual"],
      [p, `document:${doc}`]
    );
    const rows = getImmunizations(p);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(manualId);
    // A NULL source is manual too (the axis reads `source IS NULL OR NOT LIKE …`).
    const q = newProfile();
    const qdoc = newDoc(q);
    const nullSource = Number(
      db
        .prepare(
          `INSERT INTO immunizations (profile_id, date, vaccine, dose_label, source)
           VALUES (?, '2024-09-01', 'Fictitious vaccine', '1', NULL)`
        )
        .run(q).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO immunizations (profile_id, date, vaccine, dose_label, source)
       VALUES (?, '2024-09-01', 'Fictitious vaccine', '1', ?)`
    ).run(q, `document:${qdoc}`);
    const qrows = getImmunizations(q);
    expect(qrows).toHaveLength(1);
    expect(qrows[0].id).toBe(nullSource);
  });
});

describe("the emitted SQL is executable and profile-scoped", () => {
  it("every registry row and both medical specs run against the real schema", () => {
    const p = newProfile();
    for (const spec of Object.values(REPRESENTATIVE_SPECS)) {
      const ids = db
        .prepare(`SELECT id FROM (${representativeIds(spec)})`)
        .all(p) as { id: number }[];
      // A fresh profile owns nothing, and the statement binds exactly one param —
      // which is the profile filter, so nobody else's rows can appear.
      expect(ids).toEqual([]);
    }
    const familyKey = biomarkerFamilyKey();
    const medical = db
      .prepare(
        `WITH ${representativeCte("deduped", medicalDedupSpec(familyKey))},
              ${representativeCte("latest", medicalLatestSpec(familyKey), {
                where: "id IN (SELECT id FROM deduped)",
              })}
         SELECT id FROM latest`
      )
      .all(p, p) as { id: number }[];
    expect(medical).toEqual([]);
  });

  it("biomarkerFamilyKey() is the exact expression the pure golden pins", () => {
    // The pure tier cannot import lib/queries/medical.ts (it opens the DB), so it
    // spells the family expression out. This is the join between the two halves: if
    // the helper ever changes, the golden must be updated with it.
    expect(biomarkerFamilyKey()).toBe(
      "biomarker_family(COALESCE(NULLIF(TRIM(canonical_name), ''), name))"
    );
  });
});
