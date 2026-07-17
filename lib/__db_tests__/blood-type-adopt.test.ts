// DB INTEGRATION TIER — adopting a blood type from an imported document.
//
// Blood type is NOT stored on the profile by the importer's demographics path (it
// isn't document metadata like sex/birthdate — it arrives as a lab row), and the
// READ path derives it by looking up two records canonically named "ABO Blood
// Group" and "Rh Type". Nothing maps a LOINC onto those names, so a real imported
// row — Epic emits a single combined "ABORh Interpretation" = "A POSITIVE" —
// resolved to nothing and the emergency card read "Unknown" with the record sitting
// in the database. Only a hand-typed value ever filled it.
//
// These pin the adopt-if-unset contract: an import fills a blank, and never
// overwrites what the user set themselves.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { getBloodType, setBloodType } from "@/lib/settings";
import {
  adoptBloodTypeFromRecords,
  getBloodTypeParts,
} from "@/lib/settings/profile-attrs";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

const reading = (name: string, value: string | null) => ({
  name,
  canonical: name,
  value,
});

describe("adoptBloodTypeFromRecords", () => {
  it("adopts from Epic's COMBINED row, canonicalized like a hand-entered value", () => {
    const p = newProfile("bt-combined");
    expect(getBloodType(p)).toBeNull();

    const adopted = adoptBloodTypeFromRecords(p, [
      reading("ABORh Interpretation", "A POSITIVE"),
    ]);

    // Stored canonicalized ("A POSITIVE" -> "A+"), exactly as setBloodType stores
    // a value typed by hand.
    expect(adopted).toBe("A+");
    expect(getBloodType(p)).toBe("A+");
  });

  it("adopts from the two-row form (separate ABO + Rh records)", () => {
    const p = newProfile("bt-two-row");
    expect(
      adoptBloodTypeFromRecords(p, [
        reading("ABO Blood Group", "O"),
        reading("Rh Type", "NEGATIVE"),
      ])
    ).toBe("O-");
    expect(getBloodType(p)).toBe("O-");
  });

  it("NEVER overwrites a blood type the user set", () => {
    const p = newProfile("bt-manual");
    setBloodType(p, "O-");

    const adopted = adoptBloodTypeFromRecords(p, [
      reading("ABORh Interpretation", "A POSITIVE"),
    ]);

    // The user's value stands and nothing is reported as adopted.
    expect(adopted).toBeNull();
    expect(getBloodType(p)).toBe("O-");
  });

  it("is idempotent — re-importing the same document re-adopts nothing new", () => {
    const p = newProfile("bt-idempotent");
    const rows = [reading("ABORh Interpretation", "AB NEGATIVE")];

    expect(adoptBloodTypeFromRecords(p, rows)).toBe("AB-");
    // The second run sees a value already set and leaves it alone.
    expect(adoptBloodTypeFromRecords(p, rows)).toBeNull();
    expect(getBloodType(p)).toBe("AB-");
  });

  it("adopts nothing when the document carries no blood group", () => {
    const p = newProfile("bt-none");
    expect(
      adoptBloodTypeFromRecords(p, [
        reading("Sodium", "140"),
        // An Rh factor alone is meaningless without the ABO group.
        reading("Rh Type", "POSITIVE"),
      ])
    ).toBeNull();
    expect(getBloodType(p)).toBeNull();
    // …and an empty/absent record set is a no-op, not a throw.
    expect(adoptBloodTypeFromRecords(p, [])).toBeNull();
    expect(adoptBloodTypeFromRecords(p, null)).toBeNull();
  });

  it("adopts nothing from a group-shaped value on an unrelated analyte", () => {
    const p = newProfile("bt-false-positive");
    expect(
      adoptBloodTypeFromRecords(p, [
        reading("Hepatitis B Surface Antigen", "A POSITIVE"),
      ])
    ).toBeNull();
    expect(getBloodType(p)).toBeNull();
  });

  // A group written as the DIGIT zero — the European notation, and the obvious
  // AI/OCR misread of an O — adopts as group O rather than being dropped.
  it("adopts a group written as a digit zero", () => {
    const p = newProfile("bt-zero-group");
    expect(
      adoptBloodTypeFromRecords(p, [
        reading("ABORh Interpretation", "0 Positive"),
      ])
    ).toBe("O+");
    expect(getBloodTypeParts(p)).toEqual({ abo: "O", rh: "+" });
  });
});

// The halves are stored apart precisely so PARTIAL results accumulate. Held as one
// composed string, "O" was not a member of BLOOD_TYPES, so normalizeBloodType
// rejected it and an ABO-only import silently stored NOTHING.
describe("adoptBloodTypeFromRecords — partial results accumulate across imports", () => {
  it("adopts an ABO-only document, then a later Rh completes it", () => {
    const p = newProfile("bt-partial-abo-first");

    // Document 1: the group only (Rh not drawn / not reported).
    expect(
      adoptBloodTypeFromRecords(p, [reading("ABO Blood Group", "O")])
    ).toBe("O");
    expect(getBloodTypeParts(p)).toEqual({ abo: "O", rh: null });
    // Renders as the group alone until the factor is known — never dropped.
    expect(getBloodType(p)).toBe("O");

    // Document 2, later: the Rh factor completes it, without a re-draw.
    expect(
      adoptBloodTypeFromRecords(p, [reading("Rh Type", "RH(D) POSITIVE")])
    ).toBe("O+");
    expect(getBloodTypeParts(p)).toEqual({ abo: "O", rh: "+" });
    expect(getBloodType(p)).toBe("O+");
  });

  it("adopts an Rh-only document first, then the group completes it", () => {
    const p = newProfile("bt-partial-rh-first");

    // An Rh factor alone is meaningless to DISPLAY, so nothing renders yet…
    expect(
      adoptBloodTypeFromRecords(p, [reading("Rh Type", "NEGATIVE")])
    ).toBeNull();
    expect(getBloodType(p)).toBeNull();
    // …but it IS kept, so the group's arrival completes the type.
    expect(getBloodTypeParts(p)).toEqual({ abo: null, rh: "-" });

    expect(
      adoptBloodTypeFromRecords(p, [reading("ABO Blood Group", "AB")])
    ).toBe("AB-");
    expect(getBloodType(p)).toBe("AB-");
  });

  it("a later import never overwrites a half already on file", () => {
    const p = newProfile("bt-partial-no-clobber");
    // The user set a full type by hand.
    setBloodType(p, "O-");
    expect(getBloodTypeParts(p)).toEqual({ abo: "O", rh: "-" });

    // A document disagreeing on BOTH halves changes neither.
    expect(
      adoptBloodTypeFromRecords(p, [
        reading("ABORh Interpretation", "A POSITIVE"),
      ])
    ).toBeNull();
    expect(getBloodType(p)).toBe("O-");
  });

  it("fills only the missing half when the user set just the group", () => {
    const p = newProfile("bt-partial-half-manual");
    setBloodType(p, "B"); // group only, Rh unknown
    expect(getBloodTypeParts(p)).toEqual({ abo: "B", rh: null });

    // The document's group is ignored (already set); only the Rh is taken.
    expect(
      adoptBloodTypeFromRecords(p, [
        reading("ABORh Interpretation", "A POSITIVE"),
      ])
    ).toBe("B+");
    expect(getBloodTypeParts(p)).toEqual({ abo: "B", rh: "+" });
  });
});

describe("blood type storage round-trip", () => {
  it("splits a set value into halves and composes it back", () => {
    const p = newProfile("bt-round-trip");
    setBloodType(p, "AB+");
    expect(getBloodTypeParts(p)).toEqual({ abo: "AB", rh: "+" });
    expect(getBloodType(p)).toBe("AB+");

    // Stored as two discrete profile_settings rows.
    const keys = db
      .prepare(
        "SELECT key, value FROM profile_settings WHERE profile_id = ? AND key LIKE 'blood_type%' ORDER BY key"
      )
      .all(p) as { key: string; value: string }[];
    expect(keys).toEqual([
      { key: "blood_type_abo", value: "AB" },
      { key: "blood_type_rh", value: "+" },
    ]);
  });

  it("accepts a printable or partial value, and clears both halves on null/blank", () => {
    const p = newProfile("bt-set-forms");
    setBloodType(p, "O Positive"); // an imported-style string
    expect(getBloodType(p)).toBe("O+");
    setBloodType(p, "A"); // group only — no longer rejected
    expect(getBloodTypeParts(p)).toEqual({ abo: "A", rh: null });
    setBloodType(p, ""); // the "Unknown" option
    expect(getBloodTypeParts(p)).toEqual({ abo: null, rh: null });
    expect(getBloodType(p)).toBeNull();
  });
});
