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
  setSmokingHistory,
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

  it("elevates a due vaccine for a healthcare worker (immunization arm, #553)", () => {
    const pid = makeProfile("HCW", "1985-01-01");
    // No influenza dose this season → the annual vaccine reads `due`.
    // Baseline (no risk factor): the item surfaces but carries no priority.
    const before = collectUpcoming(pid, now).find(
      (i) => i.key === "immunization:influenza"
    );
    expect(before, "influenza due at baseline").toBeTruthy();
    expect(before!.priority ?? 0).toBe(0);

    setRiskAttributes(pid, {
      ...EMPTY_RISK_ATTRIBUTES,
      healthcareWorker: true,
    });

    const after = collectUpcoming(pid, now).find(
      (i) => i.key === "immunization:influenza"
    );
    expect(after, "influenza still due").toBeTruthy();
    expect(after!.priority).toBe(2);
    expect(after!.detail).toContain("Healthcare worker");
  });

  it("elevates pneumococcal for an immunocompromised older adult (#553)", () => {
    // 66-year-old: the adult pneumococcal vaccine (from 65) with no record reads
    // `due`; the immunocompromised factor ranks it up.
    const pid = makeProfile("Immuno 66", shiftDateStr(now, -66 * 365));
    setRiskAttributes(pid, {
      ...EMPTY_RISK_ATTRIBUTES,
      immunocompromised: true,
    });
    const item = collectUpcoming(pid, now).find(
      (i) => i.key === "immunization:pneumo_adult"
    );
    expect(item, "adult pneumococcal due").toBeTruthy();
    expect(item!.priority).toBe(2);
    expect(item!.detail).toContain("Immunocompromised");
  });

  it("the SAME RiskFactors gather elevates BOTH a biomarker retest and an immunization (#553 end-to-end)", () => {
    // One profile, two risk factors: family cardiac history (biomarker arm) +
    // healthcare worker (immunization arm). A single getRiskFactors gather must
    // reach BOTH engines — the invariant #517 violated by wiring only retest +
    // screening and leaving immunizations out.
    const pid = makeProfile("Multi-domain", "1980-01-01");
    insertLab(pid, "LDL Cholesterol", shiftDateStr(now, -200));
    db.prepare(
      `INSERT INTO family_history (profile_id, relation, condition)
         VALUES (?, 'father', 'Coronary artery disease')`
    ).run(pid);
    setRiskAttributes(pid, {
      ...EMPTY_RISK_ATTRIBUTES,
      healthcareWorker: true,
    });

    const items = collectUpcoming(pid, now);
    const lipid = items.find((i) => i.key === "biomarker:ldl cholesterol");
    const flu = items.find((i) => i.key === "immunization:influenza");
    expect(lipid?.priority ?? 0, "lipid retest ranked up").toBeGreaterThan(0);
    expect(flu?.priority ?? 0, "influenza ranked up").toBeGreaterThan(0);
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

// Substrate 3 (#707) — visit-kind cadence modulation end-to-end through
// collectUpcoming, per the #448 findings-builder convention: a seeded diabetes
// condition / current-smoking status must bring a recurring VISIT due sooner with
// its cited reason, which the pure tier can't see (it needs the DB gather of the
// last-visit satisfaction + the risk factors).
function recordVisit(profileId: number, ruleKey: string, date: string): void {
  db.prepare(
    `INSERT INTO preventive_events (profile_id, rule_key, date, source)
       VALUES (?, ?, ?, 'manual')`
  ).run(profileId, ruleKey, date);
}

function activeDiabetes(profileId: number): void {
  db.prepare(
    `INSERT INTO conditions (profile_id, name, status)
       VALUES (?, 'Type 2 diabetes', 'active')`
  ).run(profileId);
}

describe("issue #699/#706 — visit cadence modulation via collectUpcoming", () => {
  it("diabetes brings a vision_exam done ~14mo ago due, with the ADA reason (#699)", () => {
    const pid = makeProfile("Diabetic eyes", "1980-01-01");
    // Base vision cadence 24mo → a 14mo-old exam is up-to-date (no item).
    recordVisit(pid, "vision_exam", shiftDateStr(now, -420));
    expect(
      collectUpcoming(pid, now).some((i) => i.key === "visit:vision_exam")
    ).toBe(false);

    // Active diabetes halves the cadence to ~12mo → now due, with the reason line.
    activeDiabetes(pid);
    const item = collectUpcoming(pid, now).find(
      (i) => i.key === "visit:vision_exam"
    );
    expect(item, "vision exam now due").toBeTruthy();
    expect(item!.priority).toBe(2);
    expect(item!.detail).toContain(
      "Diabetes on file — annual dilated eye exam recommended (ADA)"
    );
  });

  it("family history of glaucoma brings a vision_exam due sooner, with the AAO reason (#699)", () => {
    const pid = makeProfile("Glaucoma FH", "1980-01-01");
    recordVisit(pid, "vision_exam", shiftDateStr(now, -420));
    expect(
      collectUpcoming(pid, now).some((i) => i.key === "visit:vision_exam")
    ).toBe(false);

    db.prepare(
      `INSERT INTO family_history (profile_id, relation, condition)
         VALUES (?, 'mother', 'Open-angle glaucoma')`
    ).run(pid);
    const item = collectUpcoming(pid, now).find(
      (i) => i.key === "visit:vision_exam"
    );
    expect(item, "vision exam now due").toBeTruthy();
    expect(item!.detail).toContain("Family history of glaucoma");
  });

  it("diabetes brings a dental_cleaning done ~4mo ago due, with the periodontal reason (#706)", () => {
    const pid = makeProfile("Diabetic gums", "1980-01-01");
    // Base dental cadence 6mo → a 4mo-old cleaning is up-to-date (no item).
    recordVisit(pid, "dental_cleaning", shiftDateStr(now, -120));
    expect(
      collectUpcoming(pid, now).some((i) => i.key === "visit:dental_cleaning")
    ).toBe(false);

    activeDiabetes(pid);
    const item = collectUpcoming(pid, now).find(
      (i) => i.key === "visit:dental_cleaning"
    );
    expect(item, "dental cleaning now due").toBeTruthy();
    expect(item!.priority).toBe(2);
    expect(item!.detail).toContain("periodontal disease risk is higher");
  });

  it("current smoking brings a dental_cleaning due sooner, with the smoking reason (#706)", () => {
    const pid = makeProfile("Smoker gums", "1980-01-01");
    recordVisit(pid, "dental_cleaning", shiftDateStr(now, -120));
    expect(
      collectUpcoming(pid, now).some((i) => i.key === "visit:dental_cleaning")
    ).toBe(false);

    setSmokingHistory(
      pid,
      { status: "current", packYears: null, quitYear: null },
      "manual"
    );
    const item = collectUpcoming(pid, now).find(
      (i) => i.key === "visit:dental_cleaning"
    );
    expect(item, "dental cleaning now due").toBeTruthy();
    expect(item!.detail).toContain(
      "Current smoking — elevated periodontal risk"
    );
  });
});

// #711 — hereditary-risk variants drive SCREENING cadence end-to-end through
// collectUpcoming, per the #448 findings-builder convention: a stored pathogenic
// `hereditary-risk` variant (#709) in a curated gene must bring the relevant
// screening due SOONER with its cited reason — AND a predictive-only variant
// (APOE ε4) or a VUS must produce a stored record with ZERO cadence effect and ZERO
// risk text (the product constraint the exclusion-disciplined gene table enforces).
import { getGenomicVariants } from "@/lib/queries";

function insertVariant(
  profileId: number,
  gene: string,
  significance: string | null,
  resultType = "hereditary-risk"
): void {
  db.prepare(
    `INSERT INTO genomic_variants
       (profile_id, gene, significance, result_type, interpretation)
     VALUES (?, ?, ?, ?, ?)`
  ).run(profileId, gene, significance, resultType, "Reported by lab");
}

function femaleProfile(name: string, ageYears: number): number {
  const pid = makeProfile(name, shiftDateStr(now, -ageYears * 365));
  setUserSex(pid, "female");
  return pid;
}

describe("issue #711 — hereditary-risk screening cadence via collectUpcoming", () => {
  it("a pathogenic BRCA1 variant brings mammography due sooner, with the NCCN reason", () => {
    const pid = femaleProfile("BRCA carrier", 45);
    // Base mammography cadence 24mo → an ~18mo-old exam is up-to-date (no item).
    recordVisit(pid, "mammography", shiftDateStr(now, -540));
    expect(
      collectUpcoming(pid, now).some((i) => i.key === "screening:mammography")
    ).toBe(false);

    insertVariant(pid, "BRCA1", "pathogenic");

    const item = collectUpcoming(pid, now).find(
      (i) => i.key === "screening:mammography"
    );
    expect(item, "mammography now due").toBeTruthy();
    expect(item!.priority).toBe(3);
    expect(item!.detail).toContain("BRCA pathogenic variant on file");
    expect(item!.detail).toContain("breast MRI");
  });

  it("a pathogenic Lynch (MSH2) variant brings colorectal screening due sooner", () => {
    const pid = makeProfile("Lynch carrier", shiftDateStr(now, -50 * 365));
    // Base colorectal cadence 120mo → a ~64mo-old colonoscopy is up-to-date.
    recordVisit(pid, "colorectal_cancer", shiftDateStr(now, -1950));
    expect(
      collectUpcoming(pid, now).some(
        (i) => i.key === "screening:colorectal_cancer"
      )
    ).toBe(false);

    insertVariant(pid, "MSH2", "likely-pathogenic");

    const item = collectUpcoming(pid, now).find(
      (i) => i.key === "screening:colorectal_cancer"
    );
    expect(item, "colorectal screening now due").toBeTruthy();
    expect(item!.priority).toBe(3);
    expect(item!.detail).toContain("Lynch syndrome variant on file");
  });

  it("a pathogenic FH (LDLR) variant brings lipid screening due sooner", () => {
    const pid = makeProfile("FH carrier", shiftDateStr(now, -45 * 365));
    // Base lipid cadence 60mo → a ~35mo-old panel is up-to-date.
    recordVisit(pid, "lipid_screening", shiftDateStr(now, -1050));
    expect(
      collectUpcoming(pid, now).some(
        (i) => i.key === "screening:lipid_screening"
      )
    ).toBe(false);

    insertVariant(pid, "LDLR", "pathogenic");

    const item = collectUpcoming(pid, now).find(
      (i) => i.key === "screening:lipid_screening"
    );
    expect(item, "lipid screening now due").toBeTruthy();
    expect(item!.detail).toContain(
      "Familial hypercholesterolemia variant on file"
    );
  });

  it("an APOE ε4 (predictive-only) variant is stored but drives NO cadence and NO risk text", () => {
    const pid = femaleProfile("APOE carrier", 45);
    // Same setup as the BRCA case — mammography positioned so a 0.5 multiplier WOULD
    // bring it due. A pathogenic APOE hereditary-risk result must NOT.
    recordVisit(pid, "mammography", shiftDateStr(now, -540));
    insertVariant(pid, "APOE", "pathogenic");

    // Stored factually (the record exists).
    const stored = getGenomicVariants(pid);
    expect(stored.some((v) => v.gene === "APOE")).toBe(true);

    const items = collectUpcoming(pid, now);
    // No cadence effect: mammography stays up-to-date, absent from Upcoming.
    expect(items.some((i) => i.key === "screening:mammography")).toBe(false);
    // No risk text anywhere: nothing mentions APOE / ε4 / Alzheimer's.
    for (const i of items) {
      const text = `${i.title} ${i.detail ?? ""}`.toLowerCase();
      expect(text).not.toContain("apoe");
      expect(text).not.toContain("ε4");
      expect(text).not.toContain("alzheimer");
    }
  });

  it("a VUS BRCA1 variant does NOT drive cadence (only pathogenic/likely-pathogenic do)", () => {
    const pid = femaleProfile("BRCA VUS", 45);
    recordVisit(pid, "mammography", shiftDateStr(now, -540));
    insertVariant(pid, "BRCA1", "uncertain-significance");

    expect(
      collectUpcoming(pid, now).some((i) => i.key === "screening:mammography")
    ).toBe(false);
  });
});

// Issue #1030 — CODED conditions count: a condition imported with an ICD/SNOMED
// code but a terse display name ("DM2" + E11.9) must reach the risk layer through
// the code table (code-first, stem fallback) and tighten cadence end-to-end. The
// pure tier proves the matcher; only this tier sees the gather (conditions +
// family_history rows carrying code/code_system into getRiskFactors).
describe("issue #1030 — coded-terse conditions drive cadence via collectUpcoming", () => {
  function codedCondition(
    profileId: number,
    name: string,
    code: string,
    system = "ICD-10-CM"
  ): void {
    db.prepare(
      `INSERT INTO conditions (profile_id, name, status, code, code_system)
         VALUES (?, ?, 'active', ?, ?)`
    ).run(profileId, name, code, system);
  }

  it("'DM2' + E11.9 tightens the vision_exam cadence like verbose diabetes", () => {
    const pid = makeProfile("Coded diabetic eyes", "1980-01-01");
    recordVisit(pid, "vision_exam", shiftDateStr(now, -420));
    expect(
      collectUpcoming(pid, now).some((i) => i.key === "visit:vision_exam")
    ).toBe(false);

    // The stem match can't see "DM2"; the stored code carries the meaning.
    codedCondition(pid, "DM2", "E11.9");
    const item = collectUpcoming(pid, now).find(
      (i) => i.key === "visit:vision_exam"
    );
    expect(item, "vision exam now due via the coded condition").toBeTruthy();
    expect(item!.detail).toContain(
      "Diabetes on file — annual dilated eye exam recommended (ADA)"
    );
  });

  it("a coded-terse family cardiac row (I25.10) tightens the lipid retest", () => {
    const pid = makeProfile("Coded cardiac FH", "1980-01-01");
    insertLab(pid, "LDL Cholesterol", shiftDateStr(now, -200));
    expect(
      collectUpcoming(pid, now).some(
        (i) => i.key === "biomarker:ldl cholesterol"
      )
    ).toBe(false);

    db.prepare(
      `INSERT INTO family_history (profile_id, relation, condition, code, code_system)
         VALUES (?, 'father', 'CAD', 'I25.10', 'ICD-10-CM')`
    ).run(pid);
    const item = collectUpcoming(pid, now).find(
      (i) => i.key === "biomarker:ldl cholesterol"
    );
    expect(item, "lipid retest now due via the coded family row").toBeTruthy();
    expect(item!.detail).toContain("Family history of heart disease");
  });

  it("an unknown-code, unmatched-name condition changes nothing (exclusion discipline)", () => {
    const pid = makeProfile("Coded unknown", "1980-01-01");
    recordVisit(pid, "vision_exam", shiftDateStr(now, -420));
    codedCondition(pid, "Migraine", "G43.909");
    expect(
      collectUpcoming(pid, now).some((i) => i.key === "visit:vision_exam")
    ).toBe(false);
  });
});

// Issue #1039 — family_history reaches the SITE-specific screening cadence. A
// coded early-onset first-degree colorectal row tightens the colonoscopy cadence
// end-to-end (the structured gather threads code + onset_age, the pure tier can't
// see the family_history read). Synthetic ICD-10 codes + obviously-fictional names.
describe("issue #1039 — family site cancer + onset age via collectUpcoming", () => {
  function familyRow(
    profileId: number,
    condition: string,
    opts: {
      relation?: string;
      code?: string;
      system?: string;
      onsetAge?: number;
    } = {}
  ): void {
    db.prepare(
      `INSERT INTO family_history
         (profile_id, relation, condition, code, code_system, onset_age)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      profileId,
      opts.relation ?? null,
      condition,
      opts.code ?? null,
      opts.system ?? null,
      opts.onsetAge ?? null
    );
  }

  it("a coded early-onset colorectal family row brings colonoscopy due sooner + explains it", () => {
    const pid = makeProfile("Family CRC early", shiftDateStr(now, -55 * 365));
    // Base colorectal cadence 120mo → a ~64mo-old colonoscopy is up-to-date.
    recordVisit(pid, "colorectal_cancer", shiftDateStr(now, -1950));
    expect(
      collectUpcoming(pid, now).some(
        (i) => i.key === "screening:colorectal_cancer"
      )
    ).toBe(false);

    // Mother, colon cancer at 45 — coded terse ("CRC"), early onset (<60).
    familyRow(pid, "CRC", {
      relation: "Mother",
      code: "C18.9",
      system: "ICD-10-CM",
      onsetAge: 45,
    });

    const item = collectUpcoming(pid, now).find(
      (i) => i.key === "screening:colorectal_cancer"
    );
    expect(item, "colorectal screening now due").toBeTruthy();
    expect(item!.priority).toBe(3);
    expect(item!.detail).toContain("early-onset colorectal cancer");
  });

  it("a LATE-onset colorectal family row ranks but does NOT tighten cadence", () => {
    const pid = makeProfile("Family CRC late", shiftDateStr(now, -55 * 365));
    // Same ~64mo-old colonoscopy — up-to-date under the 120mo base.
    recordVisit(pid, "colorectal_cancer", shiftDateStr(now, -1950));
    familyRow(pid, "Colon cancer", {
      relation: "Father",
      code: "C18.9",
      system: "ICD-10-CM",
      onsetAge: 72,
    });
    // Standard family cadence: no tightening, so the screening stays up-to-date
    // and doesn't surface as due.
    expect(
      collectUpcoming(pid, now).some(
        (i) => i.key === "screening:colorectal_cancer"
      )
    ).toBe(false);
  });

  it("a name-only 'Lynch syndrome' family row drives the colorectal factor", () => {
    const pid = makeProfile("Family Lynch", shiftDateStr(now, -55 * 365));
    recordVisit(pid, "colorectal_cancer", shiftDateStr(now, -1950));
    familyRow(pid, "Lynch syndrome", { relation: "Mother", onsetAge: 40 });
    const item = collectUpcoming(pid, now).find(
      (i) => i.key === "screening:colorectal_cancer"
    );
    expect(item, "colorectal screening due via Lynch name match").toBeTruthy();
    expect(item!.detail).toContain("early-onset colorectal cancer");
  });
});
