// SERVER-ACTION TIER — the RxNorm RE-CHECK inside the imported-name adoption
// (#3480), which is the step that makes the write trustworthy rather than merely
// authenticated.
//
// WHY THIS FILE EXISTS AT ALL. Nothing observed that block. The whole
// `lookupRxNormCandidates` guard could be deleted from
// app/(app)/import/name-actions.ts and every other tier stayed green, because the
// only other file that names the module imports it as a TYPE. The behaviour was
// correct and nothing held it there — which is one mechanism and a comment, not a
// guard.
//
// The re-check is the answer to a forged or stale payload: the form carries a name
// and a code side by side, and before a medicine is renamed the action asks RxNorm
// whether that code really does answer to that name FOR THE STORED STRING. So the
// cases below drive the real action with a real FormData payload and a stubbed
// RxNav, and assert the two things that matter — the refusal, and the row afterwards.
// A refusal that still wrote would satisfy an assertion about the message alone.
//
// The lookup is stubbed rather than reached: a test that hit NLM would be measuring
// their uptime, and the shapes below (a disagreeing answer, an empty answer, a
// throwing one) are exactly what the network hands back on a bad day.
//
// All fixtures synthetic. The medication string is a product label, not anybody's
// data.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { db } from "@/lib/db";
import { seedActor, fd } from "./harness";
import type { RxNormCandidate } from "@/lib/rxnorm";
import { adoptImportedMedicationName } from "@/app/(app)/import/name-actions";

const PORTAL_NAME = "Calcium Carb-Cholecalciferol (CALCIUM 500 + D OR)";
const CLEAN_NAME = "Calcium Carbonate / Cholecalciferol";
const CLEAN_RXCUI = "904458";

// What RxNav answers this run, in a hoisted box so the mock factory (which is
// hoisted above the imports) and the cases below share one object.
const rxnav = vi.hoisted(() => ({
  candidates: [] as { rxcui: string; name: string; score: number }[],
  throws: false,
}));

// Only the two network calls are replaced. `serializeRxcuiIngredients` is pure and is
// what the write actually stores, so it stays real.
vi.mock("@/lib/rxnorm", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/rxnorm")>("@/lib/rxnorm");
  return {
    ...actual,
    lookupRxNormCandidates: async () => {
      if (rxnav.throws) throw new Error("rxnav unreachable");
      return rxnav.candidates;
    },
    lookupRxNormIngredients: async () => [],
  };
});

let profileId = 0;
let documentId = 0;
let itemId = 0;
let seq = 0;

function seedImportedMedication(name = PORTAL_NAME): void {
  const { profile } = seedActor({ profileName: `imported_name_${++seq}` });
  profileId = profile.id;
  documentId = Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, 'meds.ccd', '', 'done', 'ccd')`
      )
      .run(profileId).lastInsertRowid
  );
  itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, source, document_id)
         VALUES (?, ?, 'medication', 'extracted', ?)`
      )
      .run(profileId, name, documentId).lastInsertRowid
  );
}

function storedRow(): { name: string; source_name: string | null } {
  return db
    .prepare("SELECT name, source_name FROM intake_items WHERE id = ?")
    .get(itemId) as { name: string; source_name: string | null };
}

const payload = (over: Record<string, string | number> = {}) =>
  fd({
    item_id: itemId,
    document_id: documentId,
    rxcui: CLEAN_RXCUI,
    name: CLEAN_NAME,
    ...over,
  });

beforeEach(() => {
  rxnav.candidates = [{ rxcui: CLEAN_RXCUI, name: CLEAN_NAME, score: 100 }];
  rxnav.throws = false;
  seedImportedMedication();
});

describe("the RxNorm re-check", () => {
  it("renames when RxNorm confirms the code answers to that name", async () => {
    // The control. Without it the refusals below would also pass against an action
    // that refused everything.
    await expect(adoptImportedMedicationName(payload())).resolves.toEqual({
      ok: true,
    });
    expect(storedRow()).toEqual({
      name: CLEAN_NAME,
      source_name: PORTAL_NAME,
    });
  });

  it("refuses a name RxNorm does not give that code", async () => {
    // A stale tab, or a forged payload: the code is real and the name is not the one
    // it answers to. Renaming a medicine to something nobody was shown is the one
    // outcome this whole action exists to prevent.
    const res = await adoptImportedMedicationName(
      payload({ name: "Vitamin D3 5000 IU" })
    );
    expect(res.ok).toBe(false);
    expect(storedRow()).toEqual({ name: PORTAL_NAME, source_name: null });
  });

  it("refuses a code RxNorm does not give that name", async () => {
    const res = await adoptImportedMedicationName(payload({ rxcui: "1234" }));
    expect(res.ok).toBe(false);
    expect(storedRow()).toEqual({ name: PORTAL_NAME, source_name: null });
  });

  it("refuses when RxNorm answers with nothing", async () => {
    rxnav.candidates = [];
    const res = await adoptImportedMedicationName(payload());
    expect(res.ok).toBe(false);
    expect(storedRow()).toEqual({ name: PORTAL_NAME, source_name: null });
  });

  it("refuses when the lookup cannot be reached at all", async () => {
    // AN UNREACHABLE LOOKUP REFUSES. Everywhere else in this feature an absent
    // lookup degrades silently, because everywhere else it costs a missing code;
    // here it would cost a wrong name, so "the network was down" is not a reason to
    // accept one. The action lets the throw out rather than swallowing it, which is
    // the loud version of the same answer — and the row is untouched either way.
    rxnav.throws = true;
    await expect(adoptImportedMedicationName(payload())).rejects.toThrow();
    expect(storedRow()).toEqual({ name: PORTAL_NAME, source_name: null });
  });

  it("asks RxNorm about the STORED string, not the one the form carried", async () => {
    // The offer is built from the stored name, so the re-check has to be too: a form
    // that named a different string could otherwise have a confirmation from a
    // lookup nobody ran against this row.
    let asked: string | null = null;
    const rxnorm = await import("@/lib/rxnorm");
    const spy = vi
      .spyOn(rxnorm, "lookupRxNormCandidates")
      .mockImplementation(async (term: string): Promise<RxNormCandidate[]> => {
        asked = term;
        return rxnav.candidates;
      });
    try {
      await adoptImportedMedicationName(payload());
    } finally {
      spy.mockRestore();
    }
    expect(asked).toBe(PORTAL_NAME);
  });
});

describe("what the action refuses before it looks anything up", () => {
  it("refuses a row this profile's document did not produce", async () => {
    // The document id is the offer's own provenance: an offer rendered on one
    // document can never rename another's row. Checked here as well as in the DB
    // tier because the action is where a forged id would arrive.
    const otherDoc = Number(
      db
        .prepare(
          `INSERT INTO medical_documents
             (profile_id, filename, stored_path, extraction_status, doc_type)
           VALUES (?, 'other.ccd', '', 'done', 'ccd')`
        )
        .run(profileId).lastInsertRowid
    );
    const res = await adoptImportedMedicationName(
      payload({ document_id: otherDoc })
    );
    expect(res.ok).toBe(false);
    expect(storedRow()).toEqual({ name: PORTAL_NAME, source_name: null });
  });

  it("refuses an rxcui that is not the shape a code takes", async () => {
    const res = await adoptImportedMedicationName(payload({ rxcui: "abc" }));
    expect(res.ok).toBe(false);
    expect(storedRow()).toEqual({ name: PORTAL_NAME, source_name: null });
  });
});
