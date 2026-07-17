// DB INTEGRATION TIER (issue #686). getInferredPreventiveSatisfactions now folds a
// QUALITATIVE screening RESULT into the preventive satisfaction stream via the shared
// classifier (keyed by concept), so it advances the matching screening rule's cadence
// — the screening counterpart of titerImmuneStatus. The pure resolver is unit-tested
// in lib/__tests__; this exercises the real GATHER: the current-qualitative-result
// read, the classifier, the concept→rule map, and the merge into the ONE assessor that
// every surface (Upcoming, the nudge) consumes. Pins the acceptance end-to-end: an HPV
// result advances cervical-cancer; an HIV result satisfies HIV screening; a control
// profile without the result stays due; a hep-B surface ANTIBODY (immunity) does not
// satisfy the hep-B infection screen.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { setUserBirthdate, setUserSex } from "@/lib/settings";
import {
  collectUpcoming,
  getInferredPreventiveSatisfactions,
} from "@/lib/queries";

// A ~40-year-old female: past the cervical-cancer entry age (21) and the HIV/hep-B
// screening entry ages, so those screenings are due with no history.
function femaleProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setUserBirthdate(id, "1986-01-01");
  setUserSex(id, "female");
  return id;
}

function addQualResult(
  p: number,
  name: string,
  value: string,
  loinc: string | null,
  date: string
): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, canonical_name, value, value_num, loinc)
     VALUES (?, ?, 'lab', ?, ?, ?, NULL, ?)`
  ).run(p, date, name, name, value, loinc);
}

function screeningDue(p: number, now: string, ruleKey: string): boolean {
  return collectUpcoming(p, now).some((i) => i.key === `screening:${ruleKey}`);
}

describe("preventive screening-result gather (#686)", () => {
  it("a recent HPV RESULT (by LOINC) advances cervical-cancer screening", () => {
    const p = femaleProfile("HPV Result");
    const now = today(p);
    // Control: with no cervical history, the screening is due.
    expect(screeningDue(p, now, "cervical_cancer")).toBe(true);

    // An Epic-style HPV result carrying only the LOINC (name the #86 inference misses).
    addQualResult(p, "HPV, High Risk", "Not Detected", "30167-1", now);

    // The gather now emits the satisfaction, and the screening is no longer due.
    const sats = getInferredPreventiveSatisfactions(p);
    expect(sats).toContainEqual({ ruleKey: "cervical_cancer", date: now });
    expect(screeningDue(p, now, "cervical_cancer")).toBe(false);
  });

  it("an HIV RESULT satisfies HIV screening (no concept-map entry existed before)", () => {
    const p = femaleProfile("HIV Result");
    const now = today(p);
    expect(screeningDue(p, now, "hiv_screening")).toBe(true);

    addQualResult(p, "HIV 1/2 Antibody", "Non-Reactive", "56888-1", now);

    expect(getInferredPreventiveSatisfactions(p)).toContainEqual({
      ruleKey: "hiv_screening",
      date: now,
    });
    expect(screeningDue(p, now, "hiv_screening")).toBe(false);
  });

  it("a POSITIVE result advances the cadence too (being tested is the event)", () => {
    const p = femaleProfile("HIV Positive");
    const now = today(p);
    addQualResult(p, "HIV 1/2 Antibody", "Reactive", "56888-1", now);
    expect(getInferredPreventiveSatisfactions(p)).toContainEqual({
      ruleKey: "hiv_screening",
      date: now,
    });
    expect(screeningDue(p, now, "hiv_screening")).toBe(false);
  });

  it("a hep-B SURFACE ANTIBODY (immunity) does NOT satisfy the hep-B infection screen", () => {
    const p = femaleProfile("Anti-HBs Immune");
    const now = today(p);
    // Positive surface ANTIBODY is immunity, not an HBsAg infection screen — the
    // gather must not emit a hepatitis_b satisfaction from it. (hepatitis_b screening
    // is risk-gated and inert for a normal profile, so this is asserted on the gather
    // directly rather than via the due set.)
    addQualResult(p, "Hepatitis B Surface Antibody", "Positive", null, now);
    expect(
      getInferredPreventiveSatisfactions(p).some(
        (s) => s.ruleKey === "hepatitis_b"
      )
    ).toBe(false);
    // A HBsAg (antigen) result, by contrast, DOES satisfy hepatitis_b.
    addQualResult(p, "Hepatitis B Surface Antigen", "Negative", "5196-1", now);
    expect(getInferredPreventiveSatisfactions(p)).toContainEqual({
      ruleKey: "hepatitis_b",
      date: now,
    });
  });

  it("an unmapped concept (Chlamydia — no catalog rule) satisfies nothing", () => {
    const p = femaleProfile("Chlamydia Result");
    const now = today(p);
    addQualResult(p, "Chlamydia trachomatis NAAT", "Detected", "21613-5", now);
    // No catalog screening rule for chlamydia → no satisfaction of any rule from it.
    const sats = getInferredPreventiveSatisfactions(p);
    expect(sats.some((s) => s.date === now)).toBe(false);
  });
});
