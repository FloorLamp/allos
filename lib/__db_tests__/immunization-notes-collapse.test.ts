// DB INTEGRATION TIER — the immunization representative must not discard the losing
// rows' notes (#4731).
//
// The representative is elected per (profile_id, vaccine, date, COALESCE(dose_label,
// '')) with a provenance preference and an `id DESC` tie-break. Notes are in neither,
// so when two overlapping portal documents produce ONE administration and only the
// lower-id row carries the note, the note-less row wins and the text is unreachable
// from every surface a person reads — while still sitting in the table.
//
// These cases assert the REACHABLE TEXT on the two display surfaces the issue names
// (the Timeline event's detail and a Search query for the note's own words), never a
// row count: a row count cannot tell "the note is shown" from "the note is gone and
// the dose is still listed". One case holds the OTHER direction — the collapse itself
// still happens and distinct administrations still stay apart — so a run that went
// green because de-duplication stopped working is not mistaken for a pass, and two
// more state the limits this fix does not cross (it stays inside one profile, and it
// does not reach the editable rows `getImmunizations` returns).
//
// The both-rows-carry-different-notes case is the one that CHOSE the fix. A
// note-preference in the election (the issue's smaller option) answers the first case
// and cannot answer that one: with both rows carrying notes the preference ties and
// `id DESC` still drops one. It is asserted here rather than left out.
//
// Synthetic, clearly fictional vocabulary and low-entropy lot numbers only (no PHI).
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { getImmunizations } from "@/lib/queries";
import { getTimelineEvents } from "@/lib/timeline";
import { searchAll } from "@/lib/queries/search";
import { flattenHits } from "@/lib/search-rank";

const DATE = "2021-03-01";
const LOWER_NOTE = "Lot 12345, left deltoid";
const HIGHER_NOTE = "Lot 67890, right deltoid";

let profileId: number;

function newDocument(filename: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents (profile_id, filename, stored_path, extraction_status)
         VALUES (?, ?, '', 'done')`
      )
      .run(profileId, filename).lastInsertRowid
  );
}

// One imported administration, stored per-document exactly as import-persist does:
// each document keeps its own physical row under its own scoped external id, so the
// two rows differ in nothing the collapse identity reads.
function importDose(
  docId: number,
  notes: string | null,
  overrides: { date?: string; vaccine?: string } = {}
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO immunizations
           (profile_id, date, vaccine, dose_label, notes, source, external_id)
         VALUES (?, ?, ?, '1', ?, ?, ?)`
      )
      .run(
        profileId,
        overrides.date ?? DATE,
        overrides.vaccine ?? "influenza",
        notes,
        `document:${docId}`,
        `document:${docId}|${overrides.vaccine ?? "influenza"}:${
          overrides.date ?? DATE
        }`
      ).lastInsertRowid
  );
}

// What the Timeline actually shows under each immunization event.
function timelineDetails(): (string | null)[] {
  return getTimelineEvents(profileId)
    .filter((e) => e.category === "immunization")
    .map((e) => e.detail ?? null);
}

// flattenHits, not the group list: searchAll returns ONE group per domain, so
// filtering the groups counts domains and can never see a missing (or duplicated)
// row — the vacuous-assertion shape #4728 found and #4725 filed.
function searchFinds(term: string): number {
  return flattenHits(searchAll(profileId, term, null)).filter(
    (h) => h.domain === "immunization"
  ).length;
}

describe("a collapsed immunization keeps every contributor's note (#4731)", () => {
  beforeEach(() => {
    profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run("imm-notes-4731")
        .lastInsertRowid
    );
  });

  // THE ISSUE'S OWN PROBE. Before the fix this read `TIMELINE detail=null` and
  // `SEARCH 'Lot 12345': []` — the note-less higher-id row won the election and the
  // text was unreachable.
  it("shows the LOSING row's note on the Timeline and finds it in Search", () => {
    const withNote = importDose(newDocument("A.ccd"), LOWER_NOTE);
    const noteless = importDose(newDocument("B.ccd"), null);
    // The note is on the row the election DISCARDS: same identity, lower id, and no
    // provenance difference to break the tie before `id DESC` does.
    expect(withNote).toBeLessThan(noteless);
    expect(getImmunizations(profileId).map((r) => r.id)).toEqual([noteless]);

    expect(timelineDetails()).toEqual([LOWER_NOTE]);
    expect(searchFinds("Lot 12345")).toBe(1);
  });

  // THE CASE THAT CHOSE THE FIX. A note-preference in the election ties here and
  // `id DESC` decides, so exactly one of these two notes would survive. Both are
  // asserted reachable, on both surfaces.
  it("keeps BOTH notes when the two contributing rows say different things", () => {
    importDose(newDocument("A.ccd"), LOWER_NOTE);
    importDose(newDocument("B.ccd"), HIGHER_NOTE);

    // One event, carrying both texts, oldest contributing row first.
    expect(timelineDetails()).toEqual([`${LOWER_NOTE} · ${HIGHER_NOTE}`]);
    expect(searchFinds("Lot 12345")).toBe(1);
    expect(searchFinds("Lot 67890")).toBe(1);
  });

  // The STATED limit of "distinct", asserted rather than left to be discovered: two
  // near-duplicate spellings of one fact both survive and read twice. Only exact
  // text (after TRIM) is folded — the direction that never drops a reader's words.
  it("folds only exactly-equal note text, and shows near-duplicates twice", () => {
    importDose(newDocument("A.ccd"), "  Lot 12345  ");
    importDose(newDocument("B.ccd"), "Lot 12345");
    importDose(newDocument("C.ccd"), "Lot 12345.");

    expect(timelineDetails()).toEqual(["Lot 12345 · Lot 12345."]);
  });

  // A dose nobody annotated still reads as an unannotated dose.
  it("leaves a group with no notes at all showing no detail", () => {
    importDose(newDocument("A.ccd"), null);
    importDose(newDocument("B.ccd"), null);

    expect(timelineDetails()).toEqual([null]);
  });

  // THE OTHER DIRECTION. Merging notes must not become "elect everything": the
  // collapse still collapses, distinct administrations still stay apart, and a note
  // never migrates from one administration to another.
  it("still collapses one administration and never merges two", () => {
    const docA = newDocument("A.ccd");
    const docB = newDocument("B.ccd");
    importDose(docA, LOWER_NOTE);
    importDose(docB, null);
    // Same vaccine another day, and another vaccine the same day — each with its own
    // note, each its own administration.
    importDose(docA, "Lot 22222, deferred", { date: "2022-03-01" });
    importDose(docA, "Lot 33333, thigh", { vaccine: "mmr" });

    expect(timelineDetails().sort()).toEqual(
      [
        "Lot 12345, left deltoid",
        "Lot 22222, deferred",
        "Lot 33333, thigh",
      ].sort()
    );
    // Four physical rows behind those three events.
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM immunizations WHERE profile_id = ?"
          )
          .get(profileId) as { n: number }
      ).n
    ).toBe(4);
    // Each note reaches Search on its own administration, and only once.
    expect(searchFinds("Lot 12345")).toBe(1);
    expect(searchFinds("Lot 22222")).toBe(1);
    expect(searchFinds("Lot 33333")).toBe(1);
  });

  // The gathering is NEW SQL with its own `profile_id = ?`, and the thing it gathers
  // is free text — so a leak here would put one person's note on another's Timeline.
  // Two profiles holding the SAME (vaccine, date, dose label) is the shape that would
  // show it.
  it("never carries one profile's note onto another profile's dose", () => {
    importDose(newDocument("A.ccd"), LOWER_NOTE);
    importDose(newDocument("B.ccd"), null);
    const mine = profileId;

    profileId = Number(
      db
        .prepare("INSERT INTO profiles (name) VALUES (?)")
        .run("imm-notes-4731-other").lastInsertRowid
    );
    importDose(newDocument("C.ccd"), HIGHER_NOTE);
    importDose(newDocument("D.ccd"), null);

    expect(timelineDetails()).toEqual([HIGHER_NOTE]);
    expect(searchFinds("Lot 12345")).toBe(0);
    profileId = mine;
    expect(timelineDetails()).toEqual([LOWER_NOTE]);
    expect(searchFinds("Lot 67890")).toBe(0);
  });

  // THE LIMIT THIS FIX DOES NOT CROSS, asserted so nobody reads the comment as a
  // wider claim than the code makes. getImmunizations is untouched — its rows feed
  // ImmunizationForm's notes field, which updateImmunization writes straight back —
  // so the record page still shows only the surviving row's own note, and
  // assessSchedule's input is unchanged.
  it("does NOT merge into getImmunizations, whose rows are editable", () => {
    importDose(newDocument("A.ccd"), LOWER_NOTE);
    importDose(newDocument("B.ccd"), null);

    expect(getImmunizations(profileId).map((r) => r.notes)).toEqual([null]);
  });
});
