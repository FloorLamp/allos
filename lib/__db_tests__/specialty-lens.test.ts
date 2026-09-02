// DB INTEGRATION TIER — the specialty lens over shared records (issue #2921).
//
// The pure classifier is unit-tested (lib/__tests__/specialty-lens.test.ts). What
// this tier pins is everything the gather has to get right for the panes:
//
//   • the widened Vision/Dental GATE opens on lens content — the issue's anchor
//     case is a child with ophthalmology visits and ZERO optical prescriptions —
//     and, the half that matters, STAYS SHUT for a profile with nothing in the
//     line, including one whose record is full of unrelated visits;
//   • the gate follows the VIEW (#2557) on lens content exactly as it does on
//     structured rows;
//   • the classification is READ-DERIVED: correcting a provider's specialty
//     reflows the lens with no write to any record.
//
// Synthetic fixtures only (no PHI).

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { getRecordsSpecialtyRelevanceForView } from "@/lib/queries/nav-relevance";
import {
  getSpecialtyLensEntries,
  hasSpecialtyLensContent,
} from "@/lib/queries/specialty-lens";

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix} ${seq}`;
}

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(uniq(name))
      .lastInsertRowid
  );
}

function newProvider(opts: {
  name: string;
  type?: "individual" | "organization";
  specialty?: string | null;
  specialtyCode?: string | null;
}): number {
  const name = uniq(opts.name);
  return Number(
    db
      .prepare(
        `INSERT INTO providers (name, type, specialty, specialty_code, dedup_key)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        name,
        opts.type ?? "individual",
        opts.specialty ?? null,
        opts.specialtyCode ?? null,
        name.toLowerCase()
      ).lastInsertRowid
  );
}

function addVisit(
  profileId: number,
  opts: {
    date: string;
    type: string;
    providerId?: number | null;
    locationProviderId?: number | null;
  }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO encounters
           (profile_id, date, type, provider_id, location_provider_id, source)
         VALUES (?, ?, ?, ?, ?, NULL)`
      )
      .run(
        profileId,
        opts.date,
        opts.type,
        opts.providerId ?? null,
        opts.locationProviderId ?? null
      ).lastInsertRowid
  );
}

function addCondition(
  profileId: number,
  name: string,
  code: string | null,
  codeSystem: string | null
): void {
  db.prepare(
    `INSERT INTO conditions (profile_id, name, code, code_system, status, source)
     VALUES (?, ?, ?, ?, 'active', NULL)`
  ).run(profileId, uniq(name), code, codeSystem);
}

function addRx(profileId: number): void {
  db.prepare(
    `INSERT INTO optical_prescriptions (profile_id, kind, brand, issued_date, source)
     VALUES (?, 'glasses', ?, '2026-03-01', NULL)`
  ).run(profileId, uniq("Frames"));
}

describe("Vision gate widens to lens content (#2921)", () => {
  it("an ophthalmology-classified visit with zero prescriptions shows the pane and lists the visit", () => {
    const child = newProfile("Lens Child");
    const eyeDoc = newProvider({
      name: "Pediatric Eye Clinician",
      specialtyCode: "207W00000X",
    });
    addVisit(child, {
      date: "2026-02-10",
      type: "Office Visit",
      providerId: eyeDoc,
    });
    addCondition(child, "Strabismus", "H50.05", "ICD-10-CM");

    // Not one optical_prescriptions row — the old gate's only question.
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM optical_prescriptions WHERE profile_id = ?"
        )
        .get(child)
    ).toEqual({ n: 0 });

    expect(getRecordsSpecialtyRelevanceForView(child, [child]).vision).toBe(
      true
    );
    const entries = getSpecialtyLensEntries(child, "vision");
    expect(entries.map((e) => e.kind).sort()).toEqual(["condition", "visit"]);
    expect(entries[0].href).toBe("/encounters/" + entries[0].id);
  });

  it("keeps the structured rows their own question — adding an Rx changes neither the gate nor the strip", () => {
    const child = newProfile("Lens Child With Rx");
    const eyeDoc = newProvider({
      name: "Eye Clinician",
      specialtyCode: "207W00000X",
    });
    addVisit(child, {
      date: "2026-02-10",
      type: "Office Visit",
      providerId: eyeDoc,
    });
    const before = getSpecialtyLensEntries(child, "vision");

    addRx(child);

    expect(getRecordsSpecialtyRelevanceForView(child, [child]).vision).toBe(
      true
    );
    // The Rx is a structured row, not lens content: it belongs to the section on
    // top of the pane and never appears in the history strip.
    expect(getSpecialtyLensEntries(child, "vision")).toEqual(before);
  });

  // THE NEGATIVE CONTROL, and the fixture is built so it can genuinely fail: this
  // profile HAS a visit, a provider and a coded condition — just none of them
  // eye-related. A gate that classified anything it could not read would go true here.
  it("stays hidden for a profile whose record is full of unrelated care", () => {
    const adult = newProfile("Lens Unrelated");
    const gp = newProvider({
      name: "Family Clinician",
      specialty: "Family Medicine",
      specialtyCode: "207Q00000X",
    });
    addVisit(adult, {
      date: "2026-01-05",
      type: "Office Visit",
      providerId: gp,
    });
    addVisit(adult, {
      date: "2026-01-30",
      type: "Annual physical exam",
      providerId: gp,
    });
    addCondition(adult, "Type 2 diabetes", "E11.9", "ICD-10-CM");

    const relevance = getRecordsSpecialtyRelevanceForView(adult, [adult]);
    expect(relevance.vision).toBe(false);
    expect(relevance.dental).toBe(false);
    expect(getSpecialtyLensEntries(adult, "vision")).toEqual([]);
  });

  it("an uncoded, unnamed visit is not guessed into a lens", () => {
    const adult = newProfile("Lens Unclassifiable");
    addVisit(adult, { date: "2026-01-05", type: "Follow-up" });
    expect(hasSpecialtyLensContent(adult, "vision")).toBe(false);
    expect(hasSpecialtyLensContent(adult, "dental")).toBe(false);
    expect(hasSpecialtyLensContent(adult, "hearing")).toBe(false);
    expect(hasSpecialtyLensContent(adult, "skin")).toBe(false);
  });
});

describe("Dental gate widens to lens content (#2921)", () => {
  it("dental visits with no dental_procedures rows unhide the pane", () => {
    const adult = newProfile("Lens Dental");
    const dentist = newProvider({
      name: "Neighborhood Dental Group",
      type: "organization",
      specialty: "Dentistry",
    });
    addVisit(adult, {
      date: "2026-02-20",
      type: "Cleaning",
      locationProviderId: dentist,
    });

    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM dental_procedures WHERE profile_id = ?"
        )
        .get(adult)
    ).toEqual({ n: 0 });
    expect(getRecordsSpecialtyRelevanceForView(adult, [adult]).dental).toBe(
      true
    );
    expect(getSpecialtyLensEntries(adult, "dental")).toHaveLength(1);
  });
});

describe("The lens is derived at read, never stored (#2921)", () => {
  it("correcting the provider's specialty reflows the lens with no record write", () => {
    const adult = newProfile("Lens Reflow");
    const provider = newProvider({
      name: "Clinician",
      specialty: "Family Medicine",
    });
    addVisit(adult, {
      date: "2026-02-01",
      type: "Office Visit",
      providerId: provider,
    });

    expect(hasSpecialtyLensContent(adult, "skin")).toBe(false);

    // The registry is corrected — nothing about the ENCOUNTER changes.
    db.prepare(
      "UPDATE providers SET specialty_code = ?, specialty = ? WHERE id = ?"
    ).run("207N00000X", "Dermatology", provider);

    expect(hasSpecialtyLensContent(adult, "skin")).toBe(true);
    expect(getSpecialtyLensEntries(adult, "skin")).toHaveLength(1);
  });
});

describe("The widened gate follows the VIEW, not the actor (#2557 + #2921)", () => {
  it("a caregiver with no eye care of their own gets the pane once the child in view has visits", () => {
    const caregiver = newProfile("Lens Caregiver");
    const child = newProfile("Lens Viewed Child");
    const optometrist = newProvider({
      name: "Optometry Clinician",
      specialtyCode: "152W00000X",
    });
    addVisit(child, {
      date: "2026-02-14",
      type: "Eye check",
      providerId: optometrist,
    });

    expect(
      getRecordsSpecialtyRelevanceForView(caregiver, [caregiver]).vision
    ).toBe(false);
    expect(
      getRecordsSpecialtyRelevanceForView(caregiver, [caregiver, child]).vision
    ).toBe(true);
    // An accessible profile OUT of view still contributes nothing.
    const outOfView = newProfile("Lens Out Of View");
    addVisit(outOfView, {
      date: "2026-02-15",
      type: "Eye check",
      providerId: optometrist,
    });
    expect(
      getRecordsSpecialtyRelevanceForView(caregiver, [caregiver]).vision
    ).toBe(false);
  });
});
