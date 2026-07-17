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
import { adoptBloodTypeFromRecords } from "@/lib/settings/profile-attrs";

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
});
