// DB INTEGRATION TIER — the ranked catalog option builders (#1677). The pure ordering
// rules are covered in lib/__tests__/{medication,supplement,provider,immunization}-rank
// .test.ts; this pins the SQL that feeds them: which ledger rows count as usage, that
// the reads are profile-scoped (one household member's medications never reorder
// another's picker), and that the provider ranking sees links from every domain.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  getIntakeCatalogOptions,
  getRankedMedicationBrandOptions,
  getRankedMedicationOptions,
  getRankedSupplementOptions,
  getRankedPickerProviders,
  getRankedSpecialtyOptions,
  getRankedVaccineOptions,
} from "@/lib/queries";
import { curatedMedicationOptions } from "@/lib/medication-rank";
import { curatedSupplementOptions } from "@/lib/supplement-rank";
import { curatedSpecialtyOptions } from "@/lib/provider-rank";
import { setProfileBirthdate, setProfileSex } from "@/lib/settings";
import { GENERIC_BRAND_OPTION } from "@/lib/medication-info";

// The Combobox shows 8 rows and an empty query keeps source order.
const PICKER_ROWS = 8;
const head = (options: string[]) => options.slice(0, PICKER_ROWS);

let seq = 0;
function makeProfile(): number {
  seq += 1;
  return Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES (?)")
      .run(`Rank Fixture ${seq}`).lastInsertRowid
  );
}

function addItem(
  profileId: number,
  fields: {
    name: string;
    kind: "medication" | "supplement";
    active?: number;
    brand?: string;
    providerId?: number;
  }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, active, brand, provider_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        fields.name,
        fields.kind,
        fields.active ?? 1,
        fields.brand ?? null,
        fields.providerId ?? null
      ).lastInsertRowid
  );
}

function makeProvider(name: string, specialty?: string): number {
  seq += 1;
  return Number(
    db
      .prepare(
        `INSERT INTO providers (name, type, specialty, dedup_key)
         VALUES (?, 'individual', ?, ?)`
      )
      .run(name, specialty ?? null, `rank-fixture-${seq}`).lastInsertRowid
  );
}

describe("getRankedMedicationOptions", () => {
  it("is the curated order for a profile with no medications", () => {
    expect(getRankedMedicationOptions(makeProfile())).toEqual(
      curatedMedicationOptions()
    );
  });

  it("leads with the profile's own medication", () => {
    const profileId = makeProfile();
    addItem(profileId, { name: "Metformin", kind: "medication" });
    expect(getRankedMedicationOptions(profileId)[0]).toMatch(/^Metformin/);
  });

  it("counts a STOPPED medication, behind a current one", () => {
    const profileId = makeProfile();
    const stopped = addItem(profileId, {
      name: "Warfarin",
      kind: "medication",
      active: 0,
    });
    db.prepare(
      `INSERT INTO medication_courses (item_id, started_on, stopped_on)
       VALUES (?, '2024-01-01', '2024-06-01')`
    ).run(stopped);
    addItem(profileId, { name: "Metformin", kind: "medication" });

    const ranked = getRankedMedicationOptions(profileId);
    expect(ranked[0]).toMatch(/^Metformin/);
    expect(ranked[1]).toMatch(/^Warfarin/);
  });

  it("reads an OPEN course as current even when the item was deactivated", () => {
    const profileId = makeProfile();
    const item = addItem(profileId, {
      name: "Levothyroxine",
      kind: "medication",
      active: 0,
    });
    db.prepare(
      `INSERT INTO medication_courses (item_id, started_on) VALUES (?, '2024-01-01')`
    ).run(item);
    addItem(profileId, {
      name: "Warfarin",
      kind: "medication",
      active: 0,
    });

    const ranked = getRankedMedicationOptions(profileId);
    expect(ranked[0]).toMatch(/^Levothyroxine/);
  });

  it("does not offer SUPPLEMENT rows as medication usage", () => {
    const profileId = makeProfile();
    addItem(profileId, { name: "Creatine Monohydrate", kind: "supplement" });
    expect(getRankedMedicationOptions(profileId)).toEqual(
      curatedMedicationOptions()
    );
  });

  it("is profile-scoped — a sibling's medications don't reorder this picker", () => {
    const mine = makeProfile();
    const sibling = makeProfile();
    addItem(sibling, { name: "Metformin", kind: "medication" });
    expect(getRankedMedicationOptions(mine)).toEqual(
      curatedMedicationOptions()
    );
    expect(getRankedMedicationOptions(sibling)[0]).toMatch(/^Metformin/);
  });
});

describe("getRankedMedicationBrandOptions", () => {
  it("is the plain catalog list for a profile with no recorded brand", () => {
    const options = getRankedMedicationBrandOptions(makeProfile());
    expect(options[0]).toBe(GENERIC_BRAND_OPTION);
    expect(options[1]).toBe("Abilify"); // alphabetical catalog behind it
  });

  it("leads with the profile's own brands, active ahead of retired", () => {
    const profileId = makeProfile();
    addItem(profileId, {
      name: "Acetaminophen",
      kind: "medication",
      brand: "Tylenol",
      active: 0,
    });
    addItem(profileId, {
      name: "Ibuprofen",
      kind: "medication",
      brand: "Motrin",
    });
    expect(
      head(getRankedMedicationBrandOptions(profileId)).slice(0, 3)
    ).toEqual([GENERIC_BRAND_OPTION, "Motrin", "Tylenol"]);
  });
});

describe("getRankedSupplementOptions", () => {
  it("is the curated order for an empty shelf", () => {
    expect(getRankedSupplementOptions(makeProfile())).toEqual(
      curatedSupplementOptions()
    );
  });

  it("leads with this shelf, retired items included", () => {
    const profileId = makeProfile();
    addItem(profileId, {
      name: "Ashwagandha",
      kind: "supplement",
      active: 0,
    });
    addItem(profileId, { name: "Creatine Monohydrate", kind: "supplement" });
    expect(getRankedSupplementOptions(profileId).slice(0, 2)).toEqual([
      "Creatine Monohydrate",
      "Ashwagandha",
    ]);
  });

  it("does not offer MEDICATION rows as supplement usage", () => {
    const profileId = makeProfile();
    addItem(profileId, { name: "Metformin", kind: "medication" });
    expect(getRankedSupplementOptions(profileId)).toEqual(
      curatedSupplementOptions()
    );
  });
});

describe("getIntakeCatalogOptions", () => {
  it("hands the full-form and quick-add call sites ONE medication order", () => {
    const profileId = makeProfile();
    addItem(profileId, { name: "Metformin", kind: "medication" });
    const bundle = getIntakeCatalogOptions(profileId);
    expect(bundle.medications).toEqual(getRankedMedicationOptions(profileId));
    expect(bundle.medicationBrands).toEqual(
      getRankedMedicationBrandOptions(profileId)
    );
    expect(bundle.supplements).toEqual(getRankedSupplementOptions(profileId));
  });
});

describe("getRankedPickerProviders", () => {
  it("is alphabetical for a profile with no provider links", () => {
    const profileId = makeProfile();
    const before = getRankedPickerProviders(profileId).map((p) => p.name);
    expect(before).toEqual(
      [...before].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    );
  });

  it("leads with the provider this profile actually sees", () => {
    const profileId = makeProfile();
    const pcp = makeProvider("Zzyzx Family Practice", "Family Medicine");
    const now = today(profileId);
    for (const date of [now, "2026-04-01", "2026-01-05"]) {
      db.prepare(
        `INSERT INTO encounters (profile_id, date, type, provider_id)
         VALUES (?, ?, 'office', ?)`
      ).run(profileId, date, pcp);
    }
    expect(getRankedPickerProviders(profileId)[0].id).toBe(pcp);
  });

  it("counts links from every provider-bearing domain, not just visits", () => {
    const profileId = makeProfile();
    const dentist = makeProvider("Zzyzx Dental Group", "Dentistry");
    db.prepare(
      `INSERT INTO dental_procedures (profile_id, procedure_date, name, provider_id)
       VALUES (?, ?, 'Cleaning', ?)`
    ).run(profileId, today(profileId), dentist);
    expect(getRankedPickerProviders(profileId)[0].id).toBe(dentist);
  });

  it("is profile-scoped — a sibling's clinician doesn't lead this picker", () => {
    const mine = makeProfile();
    const sibling = makeProfile();
    const theirs = makeProvider("Zzyzx Sibling Clinic");
    db.prepare(
      `INSERT INTO encounters (profile_id, date, type, provider_id)
       VALUES (?, ?, 'office', ?)`
    ).run(sibling, today(sibling), theirs);
    expect(getRankedPickerProviders(sibling)[0].id).toBe(theirs);
    expect(getRankedPickerProviders(mine)[0].id).not.toBe(theirs);
  });
});

describe("getRankedSpecialtyOptions", () => {
  it("is the curated order when the profile links no provider", () => {
    expect(getRankedSpecialtyOptions(makeProfile())).toEqual(
      curatedSpecialtyOptions()
    );
  });

  it("leads with the specialty this profile's own provider carries", () => {
    const profileId = makeProfile();
    const rheum = makeProvider("Zzyzx Rheumatology", "Rheumatology");
    db.prepare(
      `INSERT INTO encounters (profile_id, date, type, provider_id)
       VALUES (?, ?, 'office', ?)`
    ).run(profileId, today(profileId), rheum);
    expect(getRankedSpecialtyOptions(profileId)[0]).toBe("Rheumatology");
  });
});

describe("getRankedVaccineOptions", () => {
  it("sinks the infant series out of an adult's visible eight", () => {
    const profileId = makeProfile();
    setProfileBirthdate(profileId, "1981-03-02");
    setProfileSex(profileId, "female");
    const visible = head(getRankedVaccineOptions(profileId));
    expect(visible).not.toContain("Rotavirus");
    expect(visible).not.toContain("Haemophilus influenzae type b (Hib)");
  });

  it("keeps the infant series leading an infant's picker", () => {
    const profileId = makeProfile();
    const now = today(profileId);
    const year = Number(now.slice(0, 4));
    setProfileBirthdate(profileId, `${year}-${now.slice(5, 10)}`);
    setProfileSex(profileId, "male");
    expect(head(getRankedVaccineOptions(profileId))).toContain("Rotavirus");
  });
});
