// DB INTEGRATION TIER (not the pure unit suite).
//
// Issue #2378 — the DB GATHER for the deterministic biomarker→supplement engine
// (getCuratedSupplementSuggestions). The pure tier takes pre-gathered arrays and can't
// see the input layer, so this seeds real rows and asserts the gather end-to-end: which
// flagged readings reach the engine, that the safety facts come from the
// ingestible-conservative context (resolved allergies included), that the active stack
// suppresses a suggestion, and — the point of the whole exercise — that the result is
// identical on repeated calls with no model configured.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { getCuratedSupplementSuggestions } from "@/lib/queries";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function insertReading(
  profileId: number,
  opts: { name: string; flag: string; value?: string; date?: string }
): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, flag)
     VALUES (?, ?, 'lab', ?, ?, 'ng/mL', ?, ?)`
  ).run(
    profileId,
    opts.date ?? today(profileId),
    opts.name,
    opts.value ?? "12",
    opts.name,
    opts.flag
  );
}

describe("getCuratedSupplementSuggestions (#2378)", () => {
  it("answers a covered flagged-low family from the curated map", () => {
    const pid = makeProfile("curated-supp-basic");
    insertReading(pid, { name: "Vitamin D, 25-Hydroxy", flag: "low" });

    const out = getCuratedSupplementSuggestions(pid);
    expect(out.map((s) => s.key)).toEqual(["vitamin-d"]);
    expect(out[0].origin).toBe("curated");
    expect(out[0].triggeredBy).toEqual(["Vitamin D, 25-Hydroxy"]);
    expect(out[0].source.length).toBeGreaterThan(0);
  });

  it("is IDENTICAL on repeated calls and makes no model call (the determinism the issue asks for)", () => {
    const pid = makeProfile("curated-supp-determinism");
    insertReading(pid, { name: "Vitamin D, 25-Hydroxy", flag: "low" });
    insertReading(pid, { name: "Ferritin", flag: "low" });

    // No AI credentials are configured in this tier at all; if the curated path ever
    // reached for a model it would fail or degrade, not repeat itself byte for byte.
    const runs = Array.from({ length: 3 }, () =>
      JSON.stringify(getCuratedSupplementSuggestions(pid))
    );
    expect(new Set(runs).size).toBe(1);
    expect(JSON.parse(runs[0]).map((s: { key: string }) => s.key)).toEqual([
      "vitamin-d",
      "iron",
    ]);
  });

  it("says nothing for a family the map does not cover — that falls to the AI route", () => {
    const pid = makeProfile("curated-supp-uncovered");
    insertReading(pid, { name: "Zinc", flag: "low" });
    expect(getCuratedSupplementSuggestions(pid)).toEqual([]);
  });

  it("only considers the CURRENT reading — a newer normal result retires the suggestion", () => {
    const pid = makeProfile("curated-supp-current");
    insertReading(pid, {
      name: "Folate",
      flag: "low",
      date: "2024-01-01",
    });
    expect(getCuratedSupplementSuggestions(pid).map((s) => s.key)).toEqual([
      "folate",
    ]);
    insertReading(pid, { name: "Folate", flag: null as unknown as string });
    expect(getCuratedSupplementSuggestions(pid)).toEqual([]);
  });

  it("screens against a RESOLVED allergy too (the ingestible-conservative gather, #691)", () => {
    const pid = makeProfile("curated-supp-resolved-allergy");
    insertReading(pid, { name: "Omega-3 EPA", flag: "low" });
    db.prepare(
      `INSERT INTO allergies (profile_id, substance, status) VALUES (?, 'fish', 'resolved')`
    ).run(pid);

    const out = getCuratedSupplementSuggestions(pid);
    expect(out).toHaveLength(1);
    // The primary was struck even though the allergy is resolved; the curated
    // alternative surfaced in its place.
    expect(out[0].supplements[0].isAlternative).toBe(true);
    expect(out[0].supplements[0].name).toMatch(/algal/i);
  });

  it("hard-drops through the shared condition screen (CKD × magnesium)", () => {
    const pid = makeProfile("curated-supp-ckd");
    insertReading(pid, { name: "Magnesium", flag: "low" });
    expect(getCuratedSupplementSuggestions(pid).map((s) => s.key)).toEqual([
      "magnesium",
    ]);
    db.prepare(
      `INSERT INTO conditions (profile_id, name, status) VALUES (?, 'Chronic kidney disease stage 3', 'active')`
    ).run(pid);
    expect(getCuratedSupplementSuggestions(pid)).toEqual([]);
  });

  it("attaches a stack medication's separation-window advice without dropping the suggestion", () => {
    const pid = makeProfile("curated-supp-med-note");
    insertReading(pid, { name: "Ferritin", flag: "low" });
    db.prepare(
      `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Levothyroxine', 1, 'medication', 'daily', 'must')`
    ).run(pid);

    const out = getCuratedSupplementSuggestions(pid);
    expect(out).toHaveLength(1);
    expect(
      out[0].safetyNotes.filter((n) => n.kind === "medication")
    ).toHaveLength(1);
  });

  it("warns an anticoagulated profile about supplemental omega-3, off the real stack", () => {
    const pid = makeProfile("curated-supp-omega3-anticoag");
    insertReading(pid, { name: "Omega-3 EPA", flag: "low" });
    expect(
      getCuratedSupplementSuggestions(pid)[0].safetyNotes.filter(
        (n) => n.kind === "medication"
      )
    ).toEqual([]);

    db.prepare(
      `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation, rxcui)
         VALUES (?, 'Warfarin', 1, 'medication', 'daily', 'must', '11289')`
    ).run(pid);
    const notes = getCuratedSupplementSuggestions(pid)[0].safetyNotes.filter(
      (n) => n.kind === "medication"
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toMatch(/bleeding time/i);
  });

  it("does not answer a low serum Iron — ferritin is the status marker (#2378 review)", () => {
    const pid = makeProfile("curated-supp-serum-iron");
    insertReading(pid, { name: "Iron", flag: "low" });
    expect(getCuratedSupplementSuggestions(pid)).toEqual([]);
  });

  it("says nothing about a substance already in the ACTIVE stack, and speaks again once it is stopped", () => {
    const pid = makeProfile("curated-supp-already-taking");
    insertReading(pid, { name: "Vitamin D, 25-Hydroxy", flag: "low" });
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation)
             VALUES (?, 'Vitamin D3', 1, 'supplement', 'daily', 'should')`
        )
        .run(pid).lastInsertRowid
    );
    expect(getCuratedSupplementSuggestions(pid)).toEqual([]);

    db.prepare("UPDATE intake_items SET active = 0 WHERE id = ?").run(itemId);
    expect(getCuratedSupplementSuggestions(pid).map((s) => s.key)).toEqual([
      "vitamin-d",
    ]);
  });

  it("is profile-scoped — another profile's flagged reading does not leak in", () => {
    const mine = makeProfile("curated-supp-scope-mine");
    const theirs = makeProfile("curated-supp-scope-theirs");
    insertReading(theirs, { name: "Vitamin D, 25-Hydroxy", flag: "low" });
    expect(getCuratedSupplementSuggestions(mine)).toEqual([]);
    expect(getCuratedSupplementSuggestions(theirs)).toHaveLength(1);
  });
});
