// DB INTEGRATION TIER — risk-stratified retest & screening priority (issue #517),
// end-to-end through collectUpcoming per the #448 findings-builder convention. Each
// concrete case the issue names gets a seeded fixture that proves the risk layer's
// INPUT gather (family history / active conditions / occupational-immune attrs) +
// the cadence/priority/one-shot output, which the pure tier structurally can't see.

import { describe, it, expect, beforeEach } from "vitest";
import { db, today } from "@/lib/db";
import {
  setUserBirthdate,
  setUserSex,
  setRiskAttributes,
  EMPTY_RISK_ATTRIBUTES,
} from "@/lib/settings";
import { collectUpcoming } from "@/lib/queries";
import { shiftDateStr } from "@/lib/date";

function makeProfile(name: string, birthdate: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setUserBirthdate(id, birthdate);
  setUserSex(id, "male");
  return id;
}

function insertLab(
  profileId: number,
  name: string,
  date: string,
  canonical = name
): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num, panel)
     VALUES (?, ?, 'lab', ?, '100', 'mg/dL', ?, 100, 'Panel')`
  ).run(profileId, date, name, canonical);
}

let now: string;
beforeEach(() => {
  // A fixed adult "today" from any profile; the seeds date relative to it.
  now = today(1);
});

describe("issue #517 — cadence modulation & one-shots via collectUpcoming", () => {
  it("family history of heart disease brings a lipid retest due sooner and ranks + explains it", () => {
    const pid = makeProfile("Cardiac FH", "1980-01-01");
    // An LDL reading 200 days old: base lipid cadence is 365d (not yet due), so a
    // routine profile sees no retest — but the family-cardiac rule tightens it to
    // ~182d, bringing it due.
    insertLab(pid, "LDL Cholesterol", shiftDateStr(now, -200));

    // Baseline (no family history): not stale under the 365-day cadence.
    expect(
      collectUpcoming(pid, now).some(
        (i) => i.key === "biomarker:ldl cholesterol"
      )
    ).toBe(false);

    db.prepare(
      `INSERT INTO family_history (profile_id, relation, condition)
         VALUES (?, 'father', 'Coronary artery disease')`
    ).run(pid);

    const item = collectUpcoming(pid, now).find(
      (i) => i.key === "biomarker:ldl cholesterol"
    );
    expect(item, "lipid retest now due").toBeTruthy();
    expect(item!.title).toBe("Retest LDL Cholesterol");
    // Ranked up and explained in a calm line.
    expect(item!.priority).toBe(2);
    expect(item!.detail).toContain("Family history of heart disease");
    // The tightened cadence is reflected in the copy (365 → ~182d ≈ 6mo).
    expect(item!.detail).toContain("retest every 6mo");
  });

  it("healthcare worker / immunocompromised / dialysis brings a hepatitis-A immunity check due sooner", () => {
    for (const attr of [
      "healthcareWorker",
      "immunocompromised",
      "dialysis",
    ] as const) {
      const pid = makeProfile(`Immune ${attr}`, "1980-01-01");
      insertLab(pid, "Hepatitis A IgG Antibody", shiftDateStr(now, -200));

      // Routine: uncurated analyte on the flat 365-day clock → not yet due.
      expect(
        collectUpcoming(pid, now).some((i) => i.title.includes("Hepatitis A"))
      ).toBe(false);

      setRiskAttributes(pid, { ...EMPTY_RISK_ATTRIBUTES, [attr]: true });

      const item = collectUpcoming(pid, now).find((i) =>
        i.title.includes("Hepatitis A")
      );
      expect(item, `${attr} brings hep-A immunity due`).toBeTruthy();
      expect(item!.priority).toBeGreaterThan(0);
    }
  });

  it("pregnancy brings glucose (GDM) + ferritin (anemia) retests due sooner, ranked + explained (#521)", () => {
    const pid = makeProfile("Pregnant", "1994-01-01");
    setUserSex(pid, "female");
    // Glucose base cadence is 180d → a 150-day-old reading is not yet due; the
    // pregnancy GDM rule tightens it to ~90d, bringing it due.
    insertLab(pid, "Glucose", shiftDateStr(now, -150));
    // Ferritin base cadence is 365d → a 200-day-old reading is not yet due; the
    // pregnancy anemia rule tightens it to ~182d, bringing it due.
    insertLab(pid, "Ferritin", shiftDateStr(now, -200));

    // Baseline (not pregnant): neither is stale under its base cadence.
    const before = collectUpcoming(pid, now);
    expect(before.some((i) => i.key === "biomarker:glucose")).toBe(false);
    expect(before.some((i) => i.key === "biomarker:ferritin")).toBe(false);

    setRiskAttributes(pid, { ...EMPTY_RISK_ATTRIBUTES, pregnant: true });

    const after = collectUpcoming(pid, now);
    const glucose = after.find((i) => i.key === "biomarker:glucose");
    expect(glucose, "glucose retest now due").toBeTruthy();
    expect(glucose!.priority).toBe(2);
    expect(glucose!.detail).toContain(
      "Pregnancy — gestational diabetes screening"
    );
    const ferritin = after.find((i) => i.key === "biomarker:ferritin");
    expect(ferritin, "ferritin retest now due").toBeTruthy();
    expect(ferritin!.priority).toBe(2);
    expect(ferritin!.detail).toContain("Pregnancy — anemia screening");
  });

  it("a newborn bilirubin drawn in infancy is a one-shot, not a recurring retest", () => {
    // Born ~2 years ago; bilirubin drawn at ~1 month old (infant), now well past a
    // 365-day clock — a flat retest would nag, but the anchored one-shot suppresses it.
    const infantDob = shiftDateStr(now, -760);
    const pid = makeProfile("Newborn", infantDob);
    insertLab(pid, "Total Bilirubin", shiftDateStr(infantDob, 30));

    expect(
      collectUpcoming(pid, now).some((i) => i.title.includes("Bilirubin"))
    ).toBe(false);
  });

  it("the SAME analyte drawn as an adult still recurs (one-shot is age-at-reading gated)", () => {
    const pid = makeProfile("Adult Bilirubin", "1980-01-01");
    // Adult bilirubin 400 days old → a normal recurring LFT, still due for retest.
    insertLab(pid, "Total Bilirubin", shiftDateStr(now, -400));

    const item = collectUpcoming(pid, now).find((i) =>
      i.title.includes("Bilirubin")
    );
    expect(item, "adult bilirubin recurs").toBeTruthy();
    expect(item!.title).toBe("Retest Total Bilirubin");
  });

  it("does not modulate when the matching condition is RESOLVED, not active", () => {
    const pid = makeProfile("Resolved CKD", "1980-01-01");
    insertLab(pid, "Creatinine", shiftDateStr(now, -200));
    db.prepare(
      `INSERT INTO conditions (profile_id, name, status)
         VALUES (?, 'Chronic kidney disease', 'resolved')`
    ).run(pid);
    // A resolved condition is not an active risk factor → base 365-day cadence, so
    // a 200-day-old creatinine is not yet due.
    expect(
      collectUpcoming(pid, now).some((i) => i.key === "biomarker:creatinine")
    ).toBe(false);

    // An ACTIVE CKD condition tightens creatinine → now due.
    db.prepare(
      `INSERT INTO conditions (profile_id, name, status)
         VALUES (?, 'Chronic kidney disease stage 3', 'active')`
    ).run(pid);
    expect(
      collectUpcoming(pid, now).some((i) => i.key === "biomarker:creatinine")
    ).toBe(true);
  });
});
