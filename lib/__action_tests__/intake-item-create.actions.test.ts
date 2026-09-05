// SERVER-ACTION TIER — the ONE intake-item create core, seen from all three doors
// (#4669): the item form, an accepted AI suggestion, and an imported prescription.
//
// Every case here ASSERTS THE ROW, not the call. That is the whole point: the three
// statements this replaced disagreed about which columns an intake item has, and the
// only place that disagreement was ever visible was the row each one left behind. A
// test that asserted "the core was called" would go green on a caller that passed it
// nothing.
//
// The three doors are asked the same questions, so a column one of them stops writing
// reds HERE rather than surfacing as a badge that reads OTC on a prescription.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { getEpisodeMedReconciliation } from "@/lib/queries";
import { shiftDateStr } from "@/lib/date";
import {
  addIntakeItem,
  acceptSuggestion,
  updateIntakeItem,
} from "@/app/(app)/nutrition/intake-actions";
import { persistDocumentImport } from "@/lib/import-persist";
import type {
  PersistInput,
  PersistClinicalObservation,
} from "@/lib/import-shape";
import { seedActor, fd } from "./harness";

const DOC_DATE = "2024-03-04";

interface ItemRow {
  id: number;
  profile_id: number;
  name: string;
  notes: string | null;
  active: number;
  kind: string;
  condition: string;
  obligation: string;
  stack: string | null;
  situation: string | null;
  situation_id: number | null;
  rx: number;
  prescriber: string | null;
  pharmacy: string | null;
  rx_number: string | null;
  quantity_on_hand: number | null;
  qty_per_dose: number;
  redose_notice: number;
  min_interval_hours: number | null;
  max_daily_count: number | null;
  source: string | null;
  document_id: number | null;
  import_key: string | null;
  created_at: string;
  cadence_kind: string;
  supply_id: number | null;
}

function itemsOf(profileId: number): ItemRow[] {
  return db
    .prepare("SELECT * FROM intake_items WHERE profile_id = ? ORDER BY id")
    .all(profileId) as ItemRow[];
}

function onlyItem(profileId: number): ItemRow {
  const rows = itemsOf(profileId);
  expect(rows).toHaveLength(1);
  return rows[0];
}

interface DoseRow {
  id: number;
  item_id: number;
  amount: string | null;
  time_of_day: string | null;
  food_timing: string;
  sort: number;
  created_at: string | null;
}

function dosesOf(itemId: number): DoseRow[] {
  return db
    .prepare("SELECT * FROM intake_item_doses WHERE item_id = ? ORDER BY sort")
    .all(itemId) as DoseRow[];
}

/** The birth schedule version (#1973) a dose must be born with, from any door. */
function versionsOf(doseId: number): { effective_from: string }[] {
  return db
    .prepare(
      "SELECT effective_from FROM intake_dose_schedule_versions WHERE dose_id = ?"
    )
    .all(doseId) as { effective_from: string }[];
}

function coursesOf(itemId: number): { started_on: string | null }[] {
  return db
    .prepare("SELECT started_on FROM medication_courses WHERE item_id = ?")
    .all(itemId) as { started_on: string | null }[];
}

function seedSuggestion(
  profileId: number,
  over: Record<string, string | null> = {}
): number {
  const row = {
    name: "Magnesium glycinate",
    dosage: "200 mg once daily",
    condition: "daily",
    obligation: "should",
    rationale: "Your sleep logs.",
    situation: null as string | null,
    ...over,
  };
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_suggestions
           (name, dosage, condition, obligation, rationale, situation, status,
            profile_id)
         VALUES (?,?,?,?,?,?, 'pending', ?)`
      )
      .run(
        row.name,
        row.dosage,
        row.condition,
        row.obligation,
        row.rationale,
        row.situation,
        profileId
      ).lastInsertRowid
  );
}

function prescription(
  name: string,
  over: Partial<PersistClinicalObservation> = {}
): PersistClinicalObservation {
  return {
    category: "prescription",
    name,
    canonical: name,
    value: null,
    value_num: null,
    unit: null,
    date: DOC_DATE,
    reference_range: null,
    flag: null,
    panel: null,
    notes: null,
    source: null,
    external_id: `med:${name}`,
    loinc: null,
    provider: null,
    courses: null,
    ...over,
  };
}

function importInput(observations: PersistClinicalObservation[]): PersistInput {
  return {
    observations,
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
      docType: "ccd",
      source: "ccd",
      documentDate: DOC_DATE,
      patientName: null,
      raw: null,
      model: null,
      importReport: null,
    },
    canonicalNamesToRegister: [],
    providers: [],
  };
}

/** An OPEN illness episode covering the last few days, by id. */
function openIllnessEpisode(profileId: number, daysAgo = 3): number {
  return Number(
    db
      .prepare(
        `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
         VALUES (?, 'Illness', ?, NULL)`
      )
      .run(profileId, shiftDateStr(today(profileId), -daysAgo)).lastInsertRowid
  );
}

function seedDocument(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, 'rx.ccd', '', 'done', 'ccd')`
      )
      .run(profileId).lastInsertRowid
  );
}

// ── The form ────────────────────────────────────────────────────────────────

describe("the item form's create writes the whole column set", () => {
  it("a medication carries its identity, its provenance, its cadence and an open course", async () => {
    const { profile } = seedActor();
    const res = await addIntakeItem(
      fd({
        name: "Atorvastatin",
        kind: "medication",
        obligation: "must",
        condition: "daily",
        prescriber: "Dr. Reyes",
        pharmacy: "Elm St Pharmacy",
        rx_number: "RX-7781",
        rx: "1",
        // POSTED, and refused. A hand-built form (or a kind flip) can carry a stack a
        // medication has no affordance for, and the post does not survive to the row.
        //
        // What this sees is the PAIR, not either half. Two barriers stand between the
        // post and the column — `fields()` nulls it, and the core nulls it again from
        // the same affordance table — so removing one leaves this green on the other.
        // Each half has its own witness instead: `fields()`'s is the edit test below
        // (the UPDATE writes `f.stack` straight through, so that gate is all it has),
        // and the core's is in lib/__db_tests__/intake-item-create-core.test.ts, which
        // calls the core directly because no door hands it a stack to refuse.
        stack: "Morning",
        quantity_on_hand: "30",
        qty_per_dose: "1",
        cadence_kind: "daily",
        doses: JSON.stringify([
          { amount: "20 mg", time_of_day: "20:00", food_timing: "any" },
        ]),
      })
    );
    expect(res.ok).toBe(true);

    const row = onlyItem(profile.id);
    expect(row).toMatchObject({
      name: "Atorvastatin",
      active: 1,
      kind: "medication",
      condition: "daily",
      obligation: "must",
      rx: 1,
      prescriber: "Dr. Reyes",
      pharmacy: "Elm St Pharmacy",
      rx_number: "RX-7781",
      quantity_on_hand: 30,
      qty_per_dose: 1,
      source: "manual",
      document_id: null,
      import_key: null,
      cadence_kind: "daily",
      supply_id: null,
      // A medication has no stack — the affordance table says so, and now so does
      // the model.
      stack: null,
    });
    expect(row.created_at).not.toBe("");

    const doses = dosesOf(row.id);
    expect(doses).toHaveLength(1);
    expect(doses[0].amount).toBe("20 mg");
    expect(doses[0].created_at).not.toBeNull();
    expect(versionsOf(doses[0].id)).toEqual([
      { effective_from: today(profile.id) },
    ]);

    expect(coursesOf(row.id)).toEqual([{ started_on: today(profile.id) }]);
  });

  it("a supplement leaves every medication-only column NULL", async () => {
    const { profile } = seedActor();
    await addIntakeItem(
      fd({ name: "Creatine", kind: "supplement", stack: "Morning" })
    );
    const row = onlyItem(profile.id);
    expect(row).toMatchObject({
      kind: "supplement",
      // The kind's own default obligation, not the column's blanket 'should' by luck.
      obligation: "should",
      rx: 0,
      prescriber: null,
      pharmacy: null,
      rx_number: null,
      min_interval_hours: null,
      max_daily_count: null,
      redose_notice: 0,
      stack: "Morning",
    });
    // A supplement opens no medication course.
    expect(coursesOf(row.id)).toEqual([]);
  });

  it("refuses a blank name and writes nothing", async () => {
    const { profile } = seedActor();
    const res = await addIntakeItem(fd({ name: "   ", kind: "medication" }));
    expect(res.ok).toBe(false);
    expect(itemsOf(profile.id)).toEqual([]);
  });
});

// ── The edit, against the create ────────────────────────────────────────────

describe("the EDIT leaves the same shape the CREATE would", () => {
  it("a medication's stack is nulled by the edit too, however the field arrives", async () => {
    // A row's shape must not depend on which door touched it last. `stack` is a
    // SUPPLEMENT affordance (intakeKindAffordances), and the create nulls it for a
    // medication — so an edit that wrote it left a medication carrying a column the
    // create refuses, reachable by a hand-built POST or by flipping a stacked
    // supplement to a medication on the edit form.
    const { profile } = seedActor();
    await addIntakeItem(
      fd({ name: "Creatine", kind: "supplement", stack: "Morning" })
    );
    const before = onlyItem(profile.id);
    expect(before.stack).toBe("Morning");

    const res = await updateIntakeItem(
      fd({
        id: String(before.id),
        name: "Creatine",
        kind: "medication",
        stack: "Morning",
      })
    );
    expect(res.ok).toBe(true);
    const after = onlyItem(profile.id);
    expect(after.kind).toBe("medication");
    expect(after.stack).toBeNull();
  });

  it("…and a supplement's stack is still the user's to edit", async () => {
    // The other direction, so the rule cannot be "the edit never writes a stack".
    const { profile } = seedActor();
    await addIntakeItem(
      fd({ name: "Creatine", kind: "supplement", stack: "Morning" })
    );
    const before = onlyItem(profile.id);
    await updateIntakeItem(
      fd({
        id: String(before.id),
        name: "Creatine",
        kind: "supplement",
        stack: "Evening",
      })
    );
    expect(onlyItem(profile.id).stack).toBe("Evening");
  });
});

// ── The accepted suggestion ─────────────────────────────────────────────────

describe("an accepted suggestion lands as a fully stated supplement", () => {
  it("says supplement OUTRIGHT and carries the born-row columns it used to leave to the schema", async () => {
    const { profile } = seedActor();
    const sid = seedSuggestion(profile.id);
    expect(await acceptSuggestion(fd({ id: sid }))).toEqual({ ok: true });

    const row = onlyItem(profile.id);
    expect(row).toMatchObject({
      name: "Magnesium glycinate",
      notes: "Your sleep logs.",
      // Pinned behavior: an accepted suggestion is still a supplement — now because
      // the caller says so, not because the column defaults that way.
      kind: "supplement",
      active: 1,
      condition: "daily",
      obligation: "should",
      rx: 0,
      qty_per_dose: 1,
      redose_notice: 0,
      source: "manual",
      document_id: null,
      import_key: null,
      cadence_kind: "daily",
      supply_id: null,
    });

    // The dose the accept mints is born the same way the form's is — stamped, and
    // with its first schedule version. Neither was true of a hand-rolled insert.
    const doses = dosesOf(row.id);
    expect(doses).toHaveLength(1);
    expect(doses[0].amount).toBe("200 mg");
    expect(doses[0].created_at).not.toBeNull();
    expect(versionsOf(doses[0].id)).toEqual([
      { effective_from: today(profile.id) },
    ]);
  });

  it("a non-situational suggestion stores no orphan situation label", async () => {
    const { profile } = seedActor();
    const sid = seedSuggestion(profile.id, {
      condition: "daily",
      situation: "Travel",
    });
    expect(await acceptSuggestion(fd({ id: sid }))).toEqual({ ok: true });
    const row = onlyItem(profile.id);
    // The free-text column is the id-keyed row's denormalized FALLBACK (#560); a
    // fallback with no id behind it is a label nothing can resolve.
    expect(row.situation).toBeNull();
    expect(row.situation_id).toBeNull();
  });

  it("REFUSES a blank-named suggestion and leaves it pending", async () => {
    const { profile } = seedActor();
    const sid = seedSuggestion(profile.id, { name: "   " });
    const res = await acceptSuggestion(fd({ id: sid }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("Enter a name.");
    expect(itemsOf(profile.id)).toEqual([]);
    // The claim is rolled back with the create: the suggestion is not consumed by an
    // accept that produced nothing.
    const status = (
      db
        .prepare("SELECT status FROM intake_item_suggestions WHERE id = ?")
        .get(sid) as { status: string }
    ).status;
    expect(status).toBe("pending");
  });
});

// ── The import ──────────────────────────────────────────────────────────────

describe("an imported prescription is created as a prescription", () => {
  it("derives Rx from its own prescriber and Rx number, and keeps its extracted provenance", async () => {
    const { profile } = seedActor();
    const docId = seedDocument(profile.id);
    persistDocumentImport(
      profile.id,
      docId,
      importInput([
        prescription("Lisinopril 10 mg", {
          value: "Take 1 tablet by mouth daily",
          prescriber: "Dr. Okafor",
          pharmacy: "Elm St Pharmacy",
          rxNumber: "RX-4412",
        }),
      ])
    );

    const row = onlyItem(profile.id);
    expect(row).toMatchObject({
      name: "Lisinopril",
      kind: "medication",
      active: 1,
      condition: "daily",
      // A scheduled sig lands on the medication default (#1505).
      obligation: "must",
      // THE DEFECT #4669 FOUND. A prescription with a prescriber and an Rx number used
      // to land rx = 0 — badged OTC, its prescriber fields hidden, and read as an OTC
      // PRN by the episode reconciler — because only migration 045's backfill ever
      // applied this derivation. The create core applies it at birth.
      rx: 1,
      prescriber: "Dr. Okafor",
      pharmacy: "Elm St Pharmacy",
      rx_number: "RX-4412",
      source: "extracted",
      document_id: docId,
      // Columns an import genuinely does not know stay NULL rather than guessed.
      brand: null,
      product: null,
      stack: null,
      situation: null,
      supply_id: null,
      quantity_on_hand: null,
      cadence_kind: "daily",
    });
    expect(row.import_key).toBe(`medimport:${docId}|lisinopril`);

    // Its dose is born like every other dose: stamped, and with a first version.
    const doses = dosesOf(row.id);
    expect(doses.length).toBeGreaterThan(0);
    expect(doses[0].created_at).not.toBeNull();
    expect(versionsOf(doses[0].id)).toEqual([
      { effective_from: today(profile.id) },
    ]);

    expect(coursesOf(row.id)).toHaveLength(1);
  });

  it("an as-needed sig still lands `may`, and an OTC-shaped import stays OTC", async () => {
    const { profile } = seedActor();
    const docId = seedDocument(profile.id);
    persistDocumentImport(
      profile.id,
      docId,
      importInput([
        prescription("Ibuprofen 200 mg", {
          value: "Take 1 tablet as needed for pain",
        }),
      ])
    );
    const row = onlyItem(profile.id);
    expect(row.obligation).toBe("may");
    // No prescriber and no Rx number recorded ⇒ over-the-counter, migration 045's
    // rule read in the other direction.
    expect(row.rx).toBe(0);
    // A PRN medication carries no redose notice it did not confirm the numbers for.
    expect(row).toMatchObject({
      min_interval_hours: null,
      max_daily_count: null,
      redose_notice: 0,
    });
  });

  it("does NOT read a sig's stray 'doctor' as attribution — the OTC stays OTC, and stays the pre-checked row", async () => {
    // THE DEFECT THIS PAIRS WITH. Migration 045's rule — a recorded prescriber or Rx
    // number means prescription — was written over columns a PERSON had typed. At
    // import time those same two columns may instead hold a label heuristic's guess
    // over prose: prescription-parse scrapes on a bare "doctor", so an ordinary OTC
    // label sentence yields prescriber = "if symptoms persist", and "no prescription
    // required" yields an Rx number. Deriving the clinical flag from THAT turns a
    // drugstore ibuprofen into a prescription.
    const { profile } = seedActor();
    const docId = seedDocument(profile.id);
    persistDocumentImport(
      profile.id,
      docId,
      importInput([
        prescription("Ibuprofen 200 mg", {
          value:
            "Take 1 tablet every 6 hours as needed for pain. Call your doctor if symptoms persist",
          notes: "Over-the-counter; no prescription required",
        }),
      ])
    );

    const row = onlyItem(profile.id);
    // The scraped text is still STORED — it is what the label said, and losing it is
    // not this fix's business — but it is not attribution.
    expect(row.prescriber).toBe("if symptoms persist");
    expect(row.rx_number).toBe("required");
    expect(row.rx).toBe(0);
    expect(row.obligation).toBe("may");
  });

  it("…and that OTC is still the PRE-CHECKED row when the illness episode resolves", () => {
    // The classification that rides on the flag, asserted on its own so it reds on its
    // own. `otcPrn = med.asNeeded && !med.rx` (lib/episode-med-reconcile.ts:75): an
    // rx = 1 reclassifies this med as a "course" — listed but never pre-checked,
    // because finishing an antibiotic is a real decision — so the 2am ibuprofen added
    // DURING the illness stops being offered as "Also stop?" when it resolves. That is
    // a user-visible consequence of a label heuristic finding the word "doctor".
    const { profile } = seedActor();
    const docId = seedDocument(profile.id);
    persistDocumentImport(
      profile.id,
      docId,
      importInput([
        prescription("Ibuprofen 200 mg", {
          value:
            "Take 1 tablet every 6 hours as needed for pain. Call your doctor if symptoms persist",
          notes: "Over-the-counter; no prescription required",
        }),
      ])
    );
    const row = onlyItem(profile.id);
    const episodeId = openIllnessEpisode(profile.id);
    expect(getEpisodeMedReconciliation(profile.id, episodeId)).toEqual([
      {
        itemId: row.id,
        name: "Ibuprofen",
        klass: "otc-prn",
        defaultChecked: true,
      },
    ]);
  });

  it("still reads the SOURCE's own structured attribution as a prescription", async () => {
    // The other direction, so the fix above cannot be "never derive". A mapper-supplied
    // prescriber is an assertion, and it still means Rx — even with the identical
    // as-needed sig that carries the scrapeable sentence.
    const { profile } = seedActor();
    const docId = seedDocument(profile.id);
    persistDocumentImport(
      profile.id,
      docId,
      importInput([
        prescription("Oxycodone 5 mg", {
          value:
            "Take 1 tablet every 6 hours as needed for pain. Call your doctor if symptoms persist",
          prescriber: "Dr. Okafor",
        }),
      ])
    );
    const row = onlyItem(profile.id);
    expect(row.prescriber).toBe("Dr. Okafor");
    expect(row.rx).toBe(1);
  });

  it("a blank-named prescription creates no medication and does not abort the import", async () => {
    const { profile } = seedActor();
    const docId = seedDocument(profile.id);
    persistDocumentImport(
      profile.id,
      docId,
      importInput([
        prescription("   "),
        prescription("Metformin 500 mg", { value: "Take 1 tablet daily" }),
      ])
    );
    // The blank one is filtered before the core is reached; the real one still lands.
    expect(itemsOf(profile.id).map((r) => r.name)).toEqual(["Metformin"]);
  });
});
