// DB INTEGRATION TIER (#1050/#1053, the #448 builder discipline): the visit-link
// gather + persist. Exercises the tier-1 FHIR self-heal, the read-time suggestion
// (incl. the late-arrival case a stored-at-import design misses), the reprocess
// re-apply of an accepted decision, encounter-delete NULLing the links (row-ops), and
// the episode late-import case. Deterministic: :memory: DB via setup.ts; fixed dates.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { persistDocumentImport } from "@/lib/import-persist";
import type { PersistInput } from "@/lib/import-shape";
import {
  suggestionsForEncounter,
  suggestionForRecord,
  linkRecordToEncounter,
  encounterForRecord,
  linkedRowsForEncounter,
  suggestionForEpisode,
  linkEpisodeToEncounter,
  unlinkEpisodeFromEncounter,
  encountersForEpisode,
  episodeForLinkedEncounter,
  reapplyVisitLinkDecisions,
  nullEncounterLinks,
} from "@/lib/queries";

const DATE = "2026-03-03";

function emptyInput(over: Partial<PersistInput> = {}): PersistInput {
  return {
    records: [],
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
    canonicalNamesToRegister: [],
    providers: [],
    meta: {
      docType: "ccd",
      source: "Test Clinic",
      documentDate: DATE,
      patientName: null,
      raw: null,
      model: null,
      importReport: null,
    },
    ...over,
  };
}

// An import bundle with one visit + a prescription + a lab, both carrying the FHIR
// encounter reference to that visit (tier-1).
function bundleWithVisitLinks(): PersistInput {
  return emptyInput({
    encounters: [
      {
        date: DATE,
        end_date: null,
        type: "Office Visit",
        code: null,
        code_system: null,
        class_code: "AMB",
        reason: "Cough",
        diagnoses: [],
        provider: null,
        location: null,
        notes: null,
        external_id: "ccda:encounter:v1",
      },
    ],
    records: [
      {
        category: "prescription",
        name: "Amoxicillin 500 mg",
        canonical: "Amoxicillin 500 mg",
        value: null,
        value_num: null,
        unit: null,
        date: DATE,
        reference_range: null,
        flag: null,
        panel: null,
        notes: "Take 1 capsule by mouth twice daily",
        source: null,
        external_id: "med:amox",
        loinc: null,
        provider: null,
        encounter_external_id: "ccda:encounter:v1",
      },
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
        panel: null,
        notes: null,
        source: null,
        external_id: "obs:glucose",
        loinc: null,
        provider: null,
        encounter_external_id: "ccda:encounter:v1",
      },
      // A lab with NO encounter reference — stays unlinked by tier-1.
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
        panel: null,
        notes: null,
        source: null,
        external_id: "obs:hdl",
        loinc: null,
        provider: null,
      },
    ],
  });
}

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}
function newDocument(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents (profile_id, filename, stored_path, extraction_status)
         VALUES (?, 'r.xml', '/tmp/r.xml', 'pending')`
      )
      .run(profileId).lastInsertRowid
  );
}
function encId(profileId: number): number {
  return (
    db
      .prepare(`SELECT id FROM encounters WHERE profile_id = ? LIMIT 1`)
      .get(profileId) as { id: number }
  ).id;
}

let profileId: number;
beforeEach(() => {
  profileId = newProfile(`VL-${Math.random()}`);
});

describe("tier-1 FHIR self-heal", () => {
  it("stamps encounter_id on the med + labeled lab, leaving an unreferenced lab unlinked", () => {
    const doc = newDocument(profileId);
    persistDocumentImport(profileId, doc, bundleWithVisitLinks());
    const eid = encId(profileId);

    const med = db
      .prepare(
        `SELECT encounter_id FROM intake_items WHERE profile_id = ? AND kind = 'medication'`
      )
      .get(profileId) as { encounter_id: number | null };
    expect(med.encounter_id).toBe(eid);

    const glucose = db
      .prepare(
        `SELECT encounter_id FROM medical_records WHERE profile_id = ? AND name = 'Glucose'`
      )
      .get(profileId) as { encounter_id: number | null };
    expect(glucose.encounter_id).toBe(eid);

    const hdl = db
      .prepare(
        `SELECT encounter_id FROM medical_records WHERE profile_id = ? AND name = 'HDL'`
      )
      .get(profileId) as { encounter_id: number | null };
    expect(hdl.encounter_id).toBeNull();

    // The med surfaces "Prescribed at" and the visit lists it "From this visit".
    const medRow = db
      .prepare(
        `SELECT id FROM intake_items WHERE profile_id = ? AND kind = 'medication'`
      )
      .get(profileId) as { id: number };
    expect(encounterForRecord(profileId, "medication", medRow.id)?.id).toBe(
      eid
    );
    expect(
      linkedRowsForEncounter(profileId, eid).some(
        (r) => r.domain === "medication"
      )
    ).toBe(true);
  });

  it("re-derives tier-1 links on reprocess (new row ids, links restored)", () => {
    const doc = newDocument(profileId);
    persistDocumentImport(profileId, doc, bundleWithVisitLinks());
    const firstEnc = encId(profileId);
    // Reprocess: delete-and-reinsert under new ids.
    persistDocumentImport(profileId, doc, bundleWithVisitLinks());
    const secondEnc = encId(profileId);
    expect(secondEnc).not.toBe(firstEnc);
    const med = db
      .prepare(
        `SELECT encounter_id FROM intake_items WHERE profile_id = ? AND kind = 'medication'`
      )
      .get(profileId) as { encounter_id: number | null };
    expect(med.encounter_id).toBe(secondEnc);
  });
});

describe("read-time suggestion — the late-arrival case", () => {
  it("a medication predating a LATER-imported visit gets suggested at read time (no backfill)", () => {
    // A manually-entered medication with a course dated DATE, no visit yet. (Since
    // #1178 a prescription is the `medication` entity, not a `record` — this is the
    // late-arrival case for the single medication domain.)
    const recId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, kind) VALUES (?, 'Ibuprofen', 'medication')`
        )
        .run(profileId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO medication_courses (item_id, started_on) VALUES (?, ?)`
    ).run(recId, DATE);
    // No suggestion — there is no encounter yet.
    expect(suggestionForRecord(profileId, "medication", recId)).toBeNull();

    // The CCD containing the originating visit imports LATER.
    const doc = newDocument(profileId);
    persistDocumentImport(
      profileId,
      doc,
      emptyInput({
        encounters: [
          {
            date: DATE,
            end_date: null,
            type: "Urgent Care",
            code: null,
            code_system: null,
            class_code: "AMB",
            reason: null,
            diagnoses: [],
            provider: null,
            location: null,
            notes: null,
            external_id: "ccda:encounter:late",
          },
        ],
      })
    );
    const eid = encId(profileId);

    // Now the read-time engine pairs them — in BOTH directions.
    const recSug = suggestionForRecord(profileId, "medication", recId);
    expect(recSug?.encounter?.id).toBe(eid);
    const encSug = suggestionsForEncounter(profileId, eid);
    expect(encSug.suggestions.some((s) => s.record.id === recId)).toBe(true);

    // Accept the medication↔visit link (a manual med uses the id-based token path).
    expect(linkRecordToEncounter(profileId, "medication", recId, eid)).toBe(
      true
    );
    expect(encounterForRecord(profileId, "medication", recId)?.id).toBe(eid);
  });
});

describe("accepted decisions survive reprocess", () => {
  it("re-applies a manual record's accepted link after the visit's document reprocesses", () => {
    // Manual med on DATE.
    const medId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, kind) VALUES (?, 'Manual Med', 'medication')`
        )
        .run(profileId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO medication_courses (item_id, started_on) VALUES (?, ?)`
    ).run(medId, DATE);

    const doc = newDocument(profileId);
    persistDocumentImport(profileId, doc, bundleWithVisitLinks());
    const firstEnc = encId(profileId);

    // Accept the suggested manual-med ↔ visit link.
    expect(
      linkRecordToEncounter(profileId, "medication", medId, firstEnc)
    ).toBe(true);
    expect(
      (
        db
          .prepare(`SELECT encounter_id FROM intake_items WHERE id = ?`)
          .get(medId) as { encounter_id: number | null }
      ).encounter_id
    ).toBe(firstEnc);

    // Reprocess the visit's document — the encounter id churns.
    persistDocumentImport(profileId, doc, bundleWithVisitLinks());
    const secondEnc = encId(profileId);
    expect(secondEnc).not.toBe(firstEnc);

    // The accepted link was re-applied to the NEW encounter id.
    expect(
      (
        db
          .prepare(`SELECT encounter_id FROM intake_items WHERE id = ?`)
          .get(medId) as { encounter_id: number | null }
      ).encounter_id
    ).toBe(secondEnc);
  });

  it("sweeps a decision whose target no longer exists", () => {
    const doc = newDocument(profileId);
    persistDocumentImport(profileId, doc, bundleWithVisitLinks());
    const eid = encId(profileId);
    const medId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, kind) VALUES (?, 'Gone', 'medication')`
        )
        .run(profileId).lastInsertRowid
    );
    linkRecordToEncounter(profileId, "medication", medId, eid);
    db.prepare(`DELETE FROM intake_items WHERE id = ?`).run(medId);
    reapplyVisitLinkDecisions(profileId);
    const left = db
      .prepare(
        `SELECT COUNT(*) AS n FROM visit_link_decisions WHERE profile_id = ? AND domain = 'medication'`
      )
      .get(profileId) as { n: number };
    expect(left.n).toBe(0);
  });
});

describe("encounter delete NULLs the links (row-ops)", () => {
  it("nullEncounterLinks NULLs every record + episode back-link, freeing the delete", () => {
    const doc = newDocument(profileId);
    persistDocumentImport(profileId, doc, bundleWithVisitLinks());
    const eid = encId(profileId);
    const medRow = db
      .prepare(
        `SELECT id FROM intake_items WHERE profile_id = ? AND kind = 'medication'`
      )
      .get(profileId) as { id: number };

    // A linked episode too (many-model link table, #1198).
    const episodeId = Number(
      db
        .prepare(
          `INSERT INTO illness_episodes (profile_id, situation, started_at)
           VALUES (?, 'cold', ?)`
        )
        .run(profileId, DATE).lastInsertRowid
    );
    expect(linkEpisodeToEncounter(profileId, episodeId, eid)).toBe(true);

    // The unlink core, then the delete (mirrors deleteEncounter's order); with the
    // links removed first the FK no longer blocks the delete.
    nullEncounterLinks(profileId, eid);
    db.prepare(`DELETE FROM encounters WHERE id = ? AND profile_id = ?`).run(
      eid,
      profileId
    );

    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM encounters WHERE id = ?`).get(eid)
    ).toEqual({ n: 0 });
    expect(
      (
        db
          .prepare(`SELECT encounter_id FROM intake_items WHERE id = ?`)
          .get(medRow.id) as { encounter_id: number | null }
      ).encounter_id
    ).toBeNull();
    // The episode's link row for that encounter is gone, and its 'linked' decision
    // was swept (the #203 side-state fix).
    expect(encountersForEpisode(profileId, episodeId)).toHaveLength(0);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM visit_link_decisions
            WHERE profile_id = ? AND domain = 'episode' AND decision = 'linked'`
        )
        .get(profileId)
    ).toEqual({ n: 0 });
  });
});

describe("episode ↔ visit MANY model (#1198)", () => {
  function episode(situation: string): number {
    return Number(
      db
        .prepare(
          `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
           VALUES (?, ?, '2026-03-01', '2026-03-15')`
        )
        .run(profileId, situation).lastInsertRowid
    );
  }
  function encounter(date: string, extId: string): number {
    return Number(
      db
        .prepare(
          `INSERT INTO encounters (profile_id, date, type, external_id)
           VALUES (?, ?, 'Office Visit', ?)`
        )
        .run(profileId, date, extId).lastInsertRowid
    );
  }

  it("links two visits, lists them date-ordered, and unlink removes just one", () => {
    const epId = episode("flu");
    const a = encounter("2026-03-10", "enc:a");
    const b = encounter("2026-03-04", "enc:b");
    expect(linkEpisodeToEncounter(profileId, epId, a)).toBe(true);
    expect(linkEpisodeToEncounter(profileId, epId, b)).toBe(true);
    // Both present, ordered by date ascending (the care trail).
    expect(encountersForEpisode(profileId, epId).map((e) => e.id)).toEqual([
      b,
      a,
    ]);
    // Idempotent: re-linking the same visit adds no duplicate.
    linkEpisodeToEncounter(profileId, epId, a);
    expect(encountersForEpisode(profileId, epId)).toHaveLength(2);
    // Unlink one → the other remains, and only its 'linked' decision is cleared.
    expect(unlinkEpisodeFromEncounter(profileId, epId, a)).toBe(true);
    expect(encountersForEpisode(profileId, epId).map((e) => e.id)).toEqual([b]);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM visit_link_decisions
            WHERE profile_id = ? AND domain = 'episode' AND decision = 'linked'`
        )
        .get(profileId)
    ).toEqual({ n: 1 });
  });

  it("the reverse back-link lists an episode an encounter is linked to", () => {
    const epId = episode("cold");
    const e = encounter("2026-03-06", "enc:back");
    linkEpisodeToEncounter(profileId, epId, e);
    expect(episodeForLinkedEncounter(profileId, e)?.id).toBe(epId);
  });

  it("a relink never leaves the previous encounter's 'linked' decision (the #203 leak)", () => {
    const epId = episode("sinus");
    const first = encounter("2026-03-05", "enc:first");
    const second = encounter("2026-03-09", "enc:second");
    linkEpisodeToEncounter(profileId, epId, first);
    unlinkEpisodeFromEncounter(profileId, epId, first);
    linkEpisodeToEncounter(profileId, epId, second);
    // Exactly one 'linked' decision (the second) — the first's was cleared on unlink,
    // so the link table and the decisions ledger agree.
    const linked = db
      .prepare(
        `SELECT encounter_key FROM visit_link_decisions
          WHERE profile_id = ? AND domain = 'episode' AND decision = 'linked'`
      )
      .all(profileId) as { encounter_key: string }[];
    expect(linked).toHaveLength(1);
    expect(encountersForEpisode(profileId, epId).map((e) => e.id)).toEqual([
      second,
    ]);
  });
});

describe("episode ↔ visit late-import (#1053)", () => {
  it("an episode logged live gets suggested the visit imported weeks later", () => {
    const episodeId = Number(
      db
        .prepare(
          `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
           VALUES (?, 'flu', '2026-03-01', '2026-03-08')`
        )
        .run(profileId).lastInsertRowid
    );
    // No in-range visit yet.
    expect(
      suggestionForEpisode(profileId, {
        id: episodeId,
        start: "2026-03-01",
        lastActiveDay: "2026-03-07",
      })
    ).toBeNull();

    // The visit's CCD imports later — dated inside the episode range.
    const doc = newDocument(profileId);
    persistDocumentImport(
      profileId,
      doc,
      emptyInput({
        encounters: [
          {
            date: "2026-03-04",
            end_date: null,
            type: "Urgent Care",
            code: null,
            code_system: null,
            class_code: "AMB",
            reason: null,
            diagnoses: [],
            provider: null,
            location: null,
            notes: null,
            external_id: "ccda:encounter:flu",
          },
        ],
      })
    );
    const eid = encId(profileId);
    const sug = suggestionForEpisode(profileId, {
      id: episodeId,
      start: "2026-03-01",
      lastActiveDay: "2026-03-07",
    });
    expect(sug?.encounter?.id).toBe(eid);

    // Accept it → the cockpit Care line resolves.
    expect(linkEpisodeToEncounter(profileId, episodeId, eid)).toBe(true);
    expect(encountersForEpisode(profileId, episodeId).map((e) => e.id)).toEqual(
      [eid]
    );
    // With the many-model the in-range suggestion goes silent only because the sole
    // in-range visit is now linked (it's excluded), not because "any link exists".
    expect(
      suggestionForEpisode(profileId, {
        id: episodeId,
        start: "2026-03-01",
        lastActiveDay: "2026-03-07",
      })
    ).toBeNull();
  });
});
