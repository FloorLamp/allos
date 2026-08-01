// DB INTEGRATION TIER (npm run test:db) — the guard for the FAILURE SHAPE behind #1808,
// not just its instance.
//
// The shape: `IMPORT_FOOTPRINT_TABLES` is the delete-set a document delete/reprocess
// removes. Any table that REFERENCES one of those rows with ON DELETE NO ACTION and is
// NOT itself removed by that delete will REFUSE it, and the whole transaction rolls back
// — the document becomes undeletable and unreprocessable, reported as a bare
// SQLITE_CONSTRAINT_FOREIGNKEY. Migration 095 added `episode_stopped_meds` with two such
// FKs, years after the delete-set was established, and nothing connected the two. That is
// a recurring, mechanical failure — so scan for it mechanically.
//
// Two checks, both against the REAL migrated schema (not a hand-written table list):
//
//  1. FK REACH. Walk the delete-set transitively — a footprint table plus everything
//     CASCADE-deleted with it, since one hop is not enough (`episode_stopped_meds`'s
//     `course_id` points at `medication_courses`, a CASCADE child of `intake_items`, and
//     blocked the same delete one hop later). Every FK INTO that closure must either be
//     CASCADE / SET NULL, or be declared below with the code that frees it first.
//
//  2. DOCUMENT REACH. Every table carrying an FK to `medical_documents` must be in
//     IMPORT_FOOTPRINT_TABLES or declared below. `skin_lesions.document_id` is the live
//     example: an FK the footprint list does not know about, harmless only because no
//     importer writes lesions yet.
//
// A new FK that lands in either net fails here with the question it has to answer, which
// is the whole point: the decision must be made when the FK is added, not when a user
// finds an undeletable document.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { IMPORT_FOOTPRINT_TABLES } from "@/lib/import-footprint";

interface ForeignKey {
  table: string; // parent table
  from: string; // child column
  on_delete: string;
}

// Every FK a table declares, keyed by the declaring (child) table.
function foreignKeys(): Map<string, ForeignKey[]> {
  const tables = (
    db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
  const out = new Map<string, ForeignKey[]>();
  for (const t of tables) {
    out.set(
      t,
      db.prepare(`PRAGMA foreign_key_list("${t}")`).all() as ForeignKey[]
    );
  }
  return out;
}

// The footprint tables PLUS every table CASCADE-deleted along with them, to fixpoint.
function deleteSetClosure(fks: Map<string, ForeignKey[]>): Set<string> {
  const closure = new Set(IMPORT_FOOTPRINT_TABLES.map((t) => t.table));
  for (let changed = true; changed; ) {
    changed = false;
    for (const [child, list] of fks) {
      if (closure.has(child)) continue;
      if (list.some((fk) => closure.has(fk.table) && fk.on_delete === "CASCADE")) {
        closure.add(child);
        changed = true;
      }
    }
  }
  return closure;
}

// A NO ACTION / RESTRICT reference into the delete-set that some code frees before the
// footprint delete runs. `why` names that code — the same shape as the profile-scoping
// allowlist. Anything not listed here fails the scan.
const FREED_BEFORE_DELETE: { ref: string; why: string }[] = [
  {
    ref: "appointments.encounter_id -> encounters",
    why: "clearImportedDocumentRows nulls the appointment→encounter back-link first (#288); moveImportedDocumentRows re-enforces the same-profile invariant on reassign",
  },
  ...[
    "medical_records",
    "intake_items",
    "conditions",
    "procedures",
    "imaging_studies",
    "immunizations",
    "optical_prescriptions",
    "dental_procedures",
    "skin_lesions",
    "allergies",
  ].map((table) => ({
    ref: `${table}.encounter_id -> encounters`,
    why: "clearImportedDocumentRows nulls every row's encounter_id back-link before the encounters delete (#1050/#1053, extended by #1526); moveImportedDocumentRows re-enforces the same-profile invariant on reassign",
  })),
  {
    ref: "episode_encounters.encounter_id -> encounters",
    why: "episode ↔ visit is a link table (#1198), so clearImportedDocumentRows DELETEs the link rows for this document's encounters; the durable 'linked' decision survives and re-resolves on reprocess",
  },
  ...["source_imaging_study_id", "resolved_by_imaging_study_id"].map((col) => ({
    ref: `care_plan_items.${col} -> imaging_studies`,
    why: "clearImportedDocumentRows nulls the follow-up's source/resolving imaging link first (#700); the follow-up survives as a generic care-plan item",
  })),
  ...["source_medical_record_id", "resolved_by_medical_record_id"].map(
    (col) => ({
      ref: `care_plan_items.${col} -> medical_records`,
      why: "clearImportedDocumentRows nulls the flagged-lab follow-up's source/resolving reading link first (#700 labs adapter)",
    })
  ),
  ...["source_dental_procedure_id", "resolved_by_dental_procedure_id"].map(
    (col) => ({
      ref: `care_plan_items.${col} -> dental_procedures`,
      why: "clearImportedDocumentRows nulls the dental follow-up's source/resolving link first (#705 dental adapter)",
    })
  ),
  {
    ref: "intake_items.indication_condition_id -> conditions",
    why: "clearImportedDocumentRows nulls the med→indication back-link before the conditions delete (#1051/#1052); the med survives with its indication honestly gone",
  },
  {
    ref: "intake_items.source_record_id -> medical_records",
    why: "the paired prescription→record back-link was retired in #1178 (migration 092 consolidated the twins) and nothing writes it; the column survives only so shipped migrations still PREPARE. undo-delete-db nulls it on a manual record delete",
  },
  {
    ref: "protocols.intake_item_id -> intake_items",
    why: "clearImportedDocumentRows nulls the protocol's intervention link before the extracted-meds delete (#1808); moveImportedDocumentRows re-enforces the same-profile invariant on reassign, and undo-delete-db does the same on a manual med delete (#660)",
  },
];

// A table with a document_id FK that is deliberately NOT part of the import footprint.
const NON_FOOTPRINT_DOCUMENT_REFS: { table: string; why: string }[] = [
  {
    table: "skin_lesions",
    why: "lesions are manual-only today — no importer writes one, so every row carries a NULL document_id and the footprint never has to clear it. The day a lesion importer lands, this entry must be replaced by an IMPORT_FOOTPRINT_TABLES row (#1808)",
  },
];

describe("import-footprint FK scan (#1808)", () => {
  const fks = foreignKeys();
  const closure = deleteSetClosure(fks);

  it("the delete-set closure reaches past the footprint list itself", () => {
    // Sanity: the CASCADE walk is doing something. `medication_courses` is the hop that
    // made fixing episode_stopped_meds.item_id alone insufficient.
    expect(closure.has("intake_items")).toBe(true);
    expect(closure.has("medication_courses")).toBe(true);
  });

  it("every FK into the delete-set is CASCADE, SET NULL, or declared as freed first", () => {
    const undeclared: string[] = [];
    const declared = new Set(FREED_BEFORE_DELETE.map((e) => e.ref));
    for (const [child, list] of fks) {
      for (const fk of list) {
        if (!closure.has(fk.table)) continue;
        if (fk.on_delete === "CASCADE" || fk.on_delete === "SET NULL") continue;
        const ref = `${child}.${fk.from} -> ${fk.table}`;
        if (!declared.has(ref)) undeclared.push(ref);
      }
    }
    expect(
      undeclared.sort(),
      "These foreign keys point INTO the document-import delete-set with ON DELETE " +
        "NO ACTION, so they will REFUSE a document delete/reprocess and roll the whole " +
        "transaction back (#1808). Give the FK an ON DELETE action, or free the link " +
        "before the footprint delete in clearImportedDocumentRows (and re-enforce it in " +
        "moveImportedDocumentRows) and declare it in FREED_BEFORE_DELETE with the code " +
        "that does so."
    ).toEqual([]);
  });

  it("every FK into the delete-set is also declared with a reason, and no reason is stale", () => {
    const live = new Set<string>();
    for (const [child, list] of fks) {
      for (const fk of list) {
        if (!closure.has(fk.table)) continue;
        if (fk.on_delete === "CASCADE" || fk.on_delete === "SET NULL") continue;
        live.add(`${child}.${fk.from} -> ${fk.table}`);
      }
    }
    for (const e of FREED_BEFORE_DELETE) {
      expect(live, `${e.ref} is no longer a live NO ACTION FK`).toContain(e.ref);
      expect(e.why.length, e.ref).toBeGreaterThan(0);
    }
  });

  it("every table with a document_id FK is in the footprint list or declared", () => {
    const footprint = new Set(IMPORT_FOOTPRINT_TABLES.map((t) => t.table));
    const declared = new Set(NON_FOOTPRINT_DOCUMENT_REFS.map((e) => e.table));
    const undeclared: string[] = [];
    for (const [child, list] of fks) {
      for (const fk of list) {
        if (fk.table !== "medical_documents") continue;
        if (footprint.has(child) || declared.has(child)) continue;
        undeclared.push(`${child}.${fk.from}`);
      }
    }
    expect(
      undeclared.sort(),
      "These tables reference medical_documents but are not in IMPORT_FOOTPRINT_TABLES, " +
        "so a document delete would orphan (or be refused by) their rows. Add the table " +
        "to the footprint list, or declare in NON_FOOTPRINT_DOCUMENT_REFS why no import " +
        "ever writes its document_id."
    ).toEqual([]);
  });

  it("the episode stopped-med links are the SET NULL shape migration 137 gave them", () => {
    const links = (
      db.prepare(`PRAGMA foreign_key_list("episode_stopped_meds")`).all() as
        ForeignKey[]
    ).filter((fk) => fk.from === "item_id" || fk.from === "course_id");
    expect(links).toHaveLength(2);
    for (const fk of links) expect(fk.on_delete, fk.from).toBe("SET NULL");
    // …and both columns are nullable, so SET NULL can actually apply.
    const cols = db
      .prepare(`PRAGMA table_info("episode_stopped_meds")`)
      .all() as { name: string; notnull: number }[];
    for (const name of ["item_id", "course_id"]) {
      expect(cols.find((c) => c.name === name)?.notnull, name).toBe(0);
    }
    // The snapshot that makes the degradation honest rather than lossy.
    expect(cols.some((c) => c.name === "med_name")).toBe(true);
  });
});
