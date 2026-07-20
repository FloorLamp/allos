// DB INTEGRATION TIER — the preventive-care Upcoming slice (issue #82). Seeds a
// profile with a birthdate (so the assessor emits items), then proves the new
// query-layer reads/writers round-trip and that a mark-done / override each clears
// the corresponding due item from the profile-scoped Upcoming aggregation. The
// pure assessor + adapter are unit-tested in lib/__tests__; this exercises the
// real tables + query wiring.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { setUserBirthdate, setUserSex } from "@/lib/settings";
import {
  collectUpcoming,
  getPreventiveSatisfactions,
  getInferredPreventiveSatisfactions,
  getPreventiveOverrides,
  recordPreventiveDone,
  setPreventiveOverride,
  clearPreventiveOverride,
} from "@/lib/queries";

function makeProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  // A ~46-year-old male: past the adult-physical entry age (22, no visit on
  // record) and several screening entry ages (colorectal 45+, BP 18+, lipids 35+).
  setUserBirthdate(id, "1980-01-01");
  setUserSex(id, "male");
  return id;
}

let profileId: number;
let now: string;

beforeAll(() => {
  profileId = makeProfile("Preventive Test");
  now = today(profileId);
});

describe("preventive Upcoming integration", () => {
  it("surfaces due preventive visit + screening items for a demographics-known profile", () => {
    const items = collectUpcoming(profileId, now);
    expect(items.some((i) => i.domain === "visit")).toBe(true);
    expect(items.some((i) => i.domain === "screening")).toBe(true);
    // The adult physical is a due visit with no history and carries its rule key
    // (drives the inline mark-done / override forms).
    const visit = items.find((i) => i.key === "visit:adult_physical");
    expect(visit?.preventiveRuleKey).toBe("adult_physical");
    // No visit on record well past the entry age → an actionable (due/overdue) band.
    expect(["today", "overdue"]).toContain(visit?.band);
  });

  it("recordPreventiveDone writes an idempotent satisfaction that clears the item", () => {
    recordPreventiveDone(profileId, "adult_physical", now);
    // Idempotent: a repeat on the same day does not add a second row.
    recordPreventiveDone(profileId, "adult_physical", now);

    const sats = getPreventiveSatisfactions(profileId);
    expect(sats.filter((s) => s.ruleKey === "adult_physical")).toHaveLength(1);

    const items = collectUpcoming(profileId, now);
    expect(items.some((i) => i.key === "visit:adult_physical")).toBe(false);
  });

  it("a declined override hides a screening and clearing it restores the item", () => {
    const before = collectUpcoming(profileId, now);
    expect(before.some((i) => i.key === "screening:blood_pressure")).toBe(true);

    setPreventiveOverride(profileId, "blood_pressure", "declined");
    expect(
      getPreventiveOverrides(profileId).find(
        (o) => o.ruleKey === "blood_pressure"
      )?.kind
    ).toBe("declined");
    expect(
      collectUpcoming(profileId, now).some(
        (i) => i.key === "screening:blood_pressure"
      )
    ).toBe(false);

    // not_applicable upserts (flips the kind on the same row).
    setPreventiveOverride(profileId, "blood_pressure", "not_applicable");
    expect(getPreventiveOverrides(profileId)).toHaveLength(1);
    expect(getPreventiveOverrides(profileId)[0].kind).toBe("not_applicable");

    clearPreventiveOverride(profileId, "blood_pressure");
    expect(getPreventiveOverrides(profileId)).toHaveLength(0);
    expect(
      collectUpcoming(profileId, now).some(
        (i) => i.key === "screening:blood_pressure"
      )
    ).toBe(true);
  });

  it("preventive reads and writes are scoped to the profile", () => {
    const other = makeProfile("Other Preventive");
    setPreventiveOverride(other, "lipid_screening", "declined");
    recordPreventiveDone(other, "adult_physical", now);

    // The first profile still sees lipids as due (the other's override is invisible)
    // and its own satisfactions/overrides are unaffected.
    expect(getPreventiveOverrides(profileId).length).toBe(0);
    expect(
      collectUpcoming(profileId, now).some(
        (i) => i.key === "screening:lipid_screening"
      )
    ).toBe(true);
    expect(
      getPreventiveSatisfactions(other).some(
        (s) => s.ruleKey === "adult_physical"
      )
    ).toBe(true);
  });
});

// Issue #86 — record-driven inference feeding the SAME satisfaction stream.
describe("preventive inference from existing records", () => {
  let inferId: number;

  beforeAll(() => {
    inferId = makeProfile("Inference Test");
  });

  it("a coded colonoscopy procedure silently satisfies the colorectal rule", () => {
    // Due before any record.
    expect(
      collectUpcoming(inferId, now).some(
        (i) => i.key === "screening:colorectal_cancer"
      )
    ).toBe(true);

    db.prepare(
      `INSERT INTO procedures (profile_id, name, code, code_system, date)
         VALUES (?, 'Screening colonoscopy', '45378', 'CPT', ?)`
    ).run(inferId, now);

    // Inference now yields the satisfaction, and the item drops off Upcoming —
    // WITHOUT any manual mark-done and WITHOUT writing a preventive_events row.
    expect(
      getInferredPreventiveSatisfactions(inferId).some(
        (s) => s.ruleKey === "colorectal_cancer"
      )
    ).toBe(true);
    expect(getPreventiveSatisfactions(inferId)).toHaveLength(0);
    expect(
      collectUpcoming(inferId, now).some(
        (i) => i.key === "screening:colorectal_cancer"
      )
    ).toBe(false);
  });

  it("a completed appointment satisfies the matching visit rule", () => {
    expect(
      collectUpcoming(inferId, now).some(
        (i) => i.key === "visit:adult_physical"
      )
    ).toBe(true);

    db.prepare(
      `INSERT INTO appointments (profile_id, scheduled_at, title, status)
         VALUES (?, ?, 'Annual physical exam', 'completed')`
    ).run(inferId, now);

    expect(
      collectUpcoming(inferId, now).some(
        (i) => i.key === "visit:adult_physical"
      )
    ).toBe(false);
  });

  it("inference is profile-scoped — one profile's records never satisfy another's rules", () => {
    const bystander = makeProfile("Inference Bystander");
    // The bystander has no records, so its colorectal screening stays due despite
    // inferId's colonoscopy above.
    expect(getInferredPreventiveSatisfactions(bystander)).toHaveLength(0);
    expect(
      collectUpcoming(bystander, now).some(
        (i) => i.key === "screening:colorectal_cancer"
      )
    ).toBe(true);
  });
});

// Issue #515 — a dermatology encounter satisfies the "Skin check" visit rule via
// the provider/facility-name signal + folded-in notes.
describe("preventive inference from a specialty encounter (issue #515)", () => {
  it("a dermatology-facility encounter satisfies skin_check", () => {
    const skinId = makeProfile("Skin Check Test");

    // Due (overdue) before any evidence: 46yo, skin_check starts at 18y.
    expect(
      collectUpcoming(skinId, now).some((i) => i.key === "visit:skin_check")
    ).toBe(true);

    // A dermatology clinic in the shared registry, linked as the encounter's
    // facility (location) — "dermatology" lives in the facility NAME, not the
    // encounter type/reason.
    const clinicId = Number(
      db
        .prepare(
          "INSERT INTO providers (name, type, dedup_key) VALUES ('Cedar Dermatology Clinic', 'organization', 'cedar-dermatology')"
        )
        .run().lastInsertRowid
    );
    db.prepare(
      `INSERT INTO encounters (profile_id, date, type, reason, location_provider_id)
         VALUES (?, ?, 'Office Visit', 'Annual mole review', ?)`
    ).run(skinId, now, clinicId);

    expect(
      getInferredPreventiveSatisfactions(skinId).some(
        (s) => s.ruleKey === "skin_check"
      )
    ).toBe(true);
    expect(
      collectUpcoming(skinId, now).some((i) => i.key === "visit:skin_check")
    ).toBe(false);
  });

  it("an encounter whose notes name a full body skin exam satisfies skin_check", () => {
    const notesId = makeProfile("Skin Notes Test");
    expect(
      collectUpcoming(notesId, now).some((i) => i.key === "visit:skin_check")
    ).toBe(true);

    // The specific phrase lives in the NOTES; type/reason are generic. Bare "skin"
    // alone would not match — the whole phrase does.
    db.prepare(
      `INSERT INTO encounters (profile_id, date, type, reason, notes)
         VALUES (?, ?, 'Office Visit', 'Follow-up', 'Performed a full body skin exam; no concerning lesions.')`
    ).run(notesId, now);

    expect(
      collectUpcoming(notesId, now).some((i) => i.key === "visit:skin_check")
    ).toBe(false);
  });

  it("a generic encounter with only bare 'skin' in notes does NOT satisfy skin_check", () => {
    const genericId = makeProfile("Skin Generic Test");
    db.prepare(
      `INSERT INTO encounters (profile_id, date, type, reason, notes)
         VALUES (?, ?, 'Office Visit', 'Rash', 'Some dry skin noted on the arm.')`
    ).run(genericId, now);

    // "skin" alone is not one of the specific whole-word phrases, so the
    // conservative matcher (issue #86) still leaves skin_check due.
    expect(
      collectUpcoming(genericId, now).some((i) => i.key === "visit:skin_check")
    ).toBe(true);
  });
});

// Issue #1035 — the imported encounter TYPE CODE feeds the concept map's exact-code
// path, so a coded visit with a generic title satisfies its visit rule.
describe("preventive inference from a coded encounter (issue #1035)", () => {
  it("an imported 'Office Visit' carrying CPT 99396 satisfies adult_physical", () => {
    const codedId = makeProfile("Coded Encounter Test");

    // Overdue before the record: 46yo, no visit on file.
    expect(
      collectUpcoming(codedId, now).some(
        (i) => i.key === "visit:adult_physical"
      )
    ).toBe(true);

    // Epic's generic display + the CPT preventive-visit code (established, 40-64).
    // No text field matches an adult_physical name synonym — the CODE is the proof.
    db.prepare(
      `INSERT INTO encounters (profile_id, date, type, code, code_system, class_code)
         VALUES (?, ?, 'Office Visit', '99396', 'CPT', 'AMB')`
    ).run(codedId, now);

    expect(
      getInferredPreventiveSatisfactions(codedId).some(
        (s) => s.ruleKey === "adult_physical"
      )
    ).toBe(true);
    expect(
      collectUpcoming(codedId, now).some(
        (i) => i.key === "visit:adult_physical"
      )
    ).toBe(false);
  });

  it("a code-less generic encounter still satisfies nothing (conservatism unchanged)", () => {
    const plainId = makeProfile("Uncoded Encounter Test");
    db.prepare(
      `INSERT INTO encounters (profile_id, date, type)
         VALUES (?, ?, 'Office Visit')`
    ).run(plainId, now);
    expect(
      collectUpcoming(plainId, now).some(
        (i) => i.key === "visit:adult_physical"
      )
    ).toBe(true);
  });
});

// Issue #1037 — dental_procedures is a preventive-satisfaction source: a recorded
// completed cleaning/exam (CDT-coded or synonym-named) satisfies dental_cleaning.
describe("preventive inference from dental_procedures (issue #1037)", () => {
  it("a completed D1110 prophylaxis satisfies dental_cleaning by code", () => {
    const dentalId = makeProfile("Dental Inference Test");

    expect(
      collectUpcoming(dentalId, now).some(
        (i) => i.key === "visit:dental_cleaning"
      )
    ).toBe(true);

    // Generic name; the CDT code carries the meaning (the concept map's code path).
    db.prepare(
      `INSERT INTO dental_procedures (profile_id, name, status, cdt_code, procedure_date)
         VALUES (?, 'Prophy', 'completed', 'D1110', ?)`
    ).run(dentalId, now);

    expect(
      getInferredPreventiveSatisfactions(dentalId).some(
        (s) => s.ruleKey === "dental_cleaning"
      )
    ).toBe(true);
    expect(
      collectUpcoming(dentalId, now).some(
        (i) => i.key === "visit:dental_cleaning"
      )
    ).toBe(false);
  });

  it("a code-less 'Teeth cleaning' row satisfies via the whole-word name path", () => {
    const namedId = makeProfile("Dental Name Test");
    db.prepare(
      `INSERT INTO dental_procedures (profile_id, name, status, procedure_date)
         VALUES (?, 'Teeth cleaning', 'completed', ?)`
    ).run(namedId, now);
    expect(
      collectUpcoming(namedId, now).some(
        (i) => i.key === "visit:dental_cleaning"
      )
    ).toBe(false);
  });

  it("a planned cleaning is NOT evidence, and a completed filling matches nothing", () => {
    const plannedId = makeProfile("Dental Planned Test");
    // A booked-but-not-done cleaning (status gate) …
    db.prepare(
      `INSERT INTO dental_procedures (profile_id, name, status, cdt_code, procedure_date)
         VALUES (?, 'Adult prophylaxis', 'planned', 'D1110', ?)`
    ).run(plannedId, now);
    // … and a completed restorative row whose CDT code/name map to no rule.
    db.prepare(
      `INSERT INTO dental_procedures (profile_id, name, status, cdt_code, procedure_date)
         VALUES (?, 'Composite filling', 'completed', 'D2392', ?)`
    ).run(plannedId, now);

    expect(
      getInferredPreventiveSatisfactions(plannedId).some(
        (s) => s.ruleKey === "dental_cleaning"
      )
    ).toBe(false);
    expect(
      collectUpcoming(plannedId, now).some(
        (i) => i.key === "visit:dental_cleaning"
      )
    ).toBe(true);
  });
});
