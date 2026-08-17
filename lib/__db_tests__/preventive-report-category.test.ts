// DB INTEGRATION TIER (issue #3025) — the record-category gate in front of the
// inferred-satisfaction stream.
//
// THE OWNER REPORT this pins: a "Cervical cancer screening" overdue nudge fired for a
// profile whose Pap cytology from 2024-09-20 had been imported the day before. The Pap
// was not misfiled and its name matched the concept map exactly; it landed as
// `category = 'report'`, and the gate in front of the matcher was an ALLOWLIST of four
// categories nobody had extended, so the row was dropped before any matching ran.
//
// WHICH DIRECTION EACH ASSERTION GUARDS. This is a SAFETY-SIGNAL surface: admitting a
// category can only ever make a screening nudge QUIETER, so the "still nudges" cases
// below are not decoration — they are the half that proves the fix did not buy silence
// on the observed case by buying it everywhere. Every quieting assertion here is paired
// with a control profile that must still be told.
//
// The pure half — every category classified, with its reason, on both sides — is in
// lib/__tests__/medical-categories.test.ts. This exercises the real gather.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { db, today } from "@/lib/db";
import {
  setProfileBirthdate,
  setProfileSex,
  setTimezone,
  getProfileSetting,
  setProfileSetting,
} from "@/lib/settings";
import {
  assessProfilePreventive,
  getInferredPreventiveSatisfactions,
} from "@/lib/queries";
import { runPreventive } from "@/lib/notifications/preventive";

// The night the report came from, frozen: the assessment's answer is a function of
// "today", and 2026-08-16 is the day the nudge actually fired.
const NOW = new Date("2026-08-16T12:00:00Z");
const TODAY = "2026-08-16";
// The imported Pap, and the HPV labs that were the only thing being counted.
const PAP_DATE = "2024-09-20";
const HPV_DATE = "2023-03-27";
// PAP_DATE + the cervical rule's 36-month interval.
const NEXT_DUE = "2027-09-20";
// The instant every fixture row was WRITTEN (SQLite `datetime('now')` shape, UTC): the
// day the owner's import ran. Stated rather than left to the wall clock so the fixtures
// are stable, and so the "dated today, imported today" case below is exactly that.
const IMPORTED_AT = `${TODAY} 10:56:00`;

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

// A 34-year-old female on 2026-08-16: inside the cervical rule's 21–65 band, which is
// what made the rule actionable the moment the import wrote `sex` onto the profile.
function femaleProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, "UTC");
  setProfileBirthdate(id, "1992-01-01");
  setProfileSex(id, "female");
  return id;
}

function addRecord(
  profileId: number,
  category: string,
  name: string,
  date: string,
  opts: {
    value?: string | null;
    loinc?: string | null;
    // WHEN THE ROW WAS WRITTEN. Defaults to the observed night's import — every fixture
    // here was imported on 2026-08-16, which is what the owner reported.
    createdAt?: string;
  } = {}
): void {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, canonical_name, value, value_num, loinc, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  ).run(
    profileId,
    date,
    category,
    name,
    name,
    opts.value ?? null,
    opts.loinc ?? null,
    opts.createdAt ?? IMPORTED_AT
  );
}

// The two HPV genotype labs the assessor WAS counting — the reason its newest counted
// satisfaction was 2023-03-27 and the rule read five months overdue.
function addHpvLabs(profileId: number): void {
  addRecord(profileId, "lab", "HPV Genotype 16", HPV_DATE, {
    value: "Negative",
    loinc: "59263-4",
  });
  addRecord(profileId, "lab", "HPV Genotype 18/45", HPV_DATE, {
    value: "Negative",
    loinc: "75694-0",
  });
}

// The imported Pap exactly as the CCDA filed it: category `report`, a narrative read
// with NO value (so the #686 qualitative bridge has nothing to judge) and a cytology
// LOINC that is not in the cervical concept's HPV LOINC set. Its NAME is the whole of
// the evidence, and it matches.
function addPapReport(profileId: number, date = PAP_DATE): void {
  addRecord(profileId, "report", "Cytology, Gyn-PAP Test (AP)", date, {
    value: null,
    loinc: "33717-0",
  });
}

function assessment(profileId: number, key: string) {
  return assessProfilePreventive(profileId, TODAY).assessments.find(
    (a) => a.key === key
  );
}

function isActionable(profileId: number, key: string): boolean {
  return assessProfilePreventive(profileId, TODAY).actionable.some(
    (a) => a.key === key
  );
}

describe("preventive satisfaction: the record-category gate (#3025)", () => {
  it("a `report` Pap satisfies cervical screening on its own date", () => {
    const p = femaleProfile("Pap Report");
    addPapReport(p);

    expect(getInferredPreventiveSatisfactions(p)).toContainEqual({
      ruleKey: "cervical_cancer",
      date: PAP_DATE,
    });
  });

  it("the observed profile is NOT overdue on 2026-08-16 and comes due 2027-09-20", () => {
    const p = femaleProfile("Pap Report Plus HPV");
    addHpvLabs(p);
    addPapReport(p);

    // The clock the assessor now reads is the Pap's, not the HPV labs'.
    const a = assessment(p, "cervical_cancer");
    expect(a?.lastDate).toBe(PAP_DATE);
    expect(a?.nextDueDate).toBe(NEXT_DUE);
    expect(isActionable(p, "cervical_cancer")).toBe(false);
  });

  it("CONTROL — the same profile WITHOUT the Pap is still told it is overdue", () => {
    // The half that keeps this fix from being silence. Same demographics, same HPV
    // labs, no cytology on file: the newest counted satisfaction is 2023-03-27, due
    // was 2026-03-27, and the nudge is right to fire.
    const p = femaleProfile("HPV Only");
    addHpvLabs(p);

    const a = assessment(p, "cervical_cancer");
    expect(a?.lastDate).toBe(HPV_DATE);
    expect(isActionable(p, "cervical_cancer")).toBe(true);
  });

  it("CONTROL — a Pap too long ago still comes due", () => {
    // A `report` Pap is not a permanent exemption: four years back is past the
    // 36-month interval and its grace, so the rule is actionable again.
    const p = femaleProfile("Old Pap Report");
    addPapReport(p, "2022-01-10");

    const a = assessment(p, "cervical_cancer");
    expect(a?.lastDate).toBe("2022-01-10");
    expect(isActionable(p, "cervical_cancer")).toBe(true);
  });

  it("the categories ruled out as never-a-screening-result still satisfy nothing", () => {
    // Each is filed with the SAME name that satisfies as a `report`, so the only thing
    // under test is the category. A regression here would mean the denylist had become
    // an admit-everything.
    for (const category of [
      "genomics",
      "scan",
      "prescription",
      "derived",
      "reference",
      "assessment",
    ]) {
      const p = femaleProfile(`Ruled Out ${category}`);
      // The HPV labs give the rule a real history, so it is genuinely OVERDUE rather
      // than merely un-evidenced (#1433's `setup` slice) — the category under test is
      // then the only thing that could quiet it.
      addHpvLabs(p);
      addRecord(p, category, "Cytology, Gyn-PAP Test (AP)", PAP_DATE);
      expect(
        getInferredPreventiveSatisfactions(p).some(
          (s) => s.ruleKey === "cervical_cancer" && s.date === PAP_DATE
        ),
        category
      ).toBe(false);
      expect(isActionable(p, "cervical_cancer"), category).toBe(true);
    }
  });

  it("a `report` named for a CONVERSATION satisfies no mental-health screening", () => {
    // The quiet direction of the same admission, and the worse one. The concept map's
    // behavioural-health needles ("counseling", "psychotherapy") were written for the
    // VISIT stream (#997); once `report` was admitted they met DOCUMENT TITLES, and a
    // dietitian's filed note satisfied BOTH depression and anxiety screening for a year.
    const p = femaleProfile("Counseling Note");
    // A genuinely overdue pair: instrument scores from 2024-01-10 against annual rules.
    addRecord(p, "instrument", "PHQ-9", "2024-01-10", { value: "4" });
    addRecord(p, "instrument", "GAD-7", "2024-01-10", { value: "3" });
    addRecord(p, "report", "Nutrition Counseling Note", "2026-05-01");

    const sats = getInferredPreventiveSatisfactions(p);
    for (const key of ["depression_screening", "anxiety_screening"]) {
      expect(
        sats.some((s) => s.ruleKey === key && s.date === "2026-05-01"),
        key
      ).toBe(false);
      expect(assessment(p, key)?.lastDate, key).toBe("2024-01-10");
      expect(isActionable(p, key), key).toBe(true);
    }
  });

  it("CONTROL — the same word as a completed mental-health VISIT still satisfies (#997)", () => {
    // The half that keeps the shape rule from being a deletion: a person in active
    // behavioural-health care must not be nagged to get screened.
    const p = femaleProfile("Counseling Visit");
    addRecord(p, "instrument", "PHQ-9", "2024-01-10", { value: "4" });
    addRecord(p, "instrument", "GAD-7", "2024-01-10", { value: "3" });
    db.prepare(
      `INSERT INTO appointments (profile_id, date, title, kind, status)
         VALUES (?, '2026-05-01', 'Counseling session', 'mental_health', 'completed')`
    ).run(p);

    const sats = getInferredPreventiveSatisfactions(p);
    for (const key of ["depression_screening", "anxiety_screening"]) {
      expect(
        sats.some((s) => s.ruleKey === key && s.date === "2026-05-01"),
        key
      ).toBe(true);
      expect(isActionable(p, key), key).toBe(false);
    }
  });

  it("a `report` that RECORDS A REFUSAL of its own subject does not satisfy it", () => {
    // "Screening mammogram declined by patient" is the record of a refusal. Reading it
    // as the mammogram is a missed cancer screening.
    const p = femaleProfile("Mammogram Declined");
    setProfileBirthdate(p, "1975-01-01"); // 51 — inside the 40–74 band
    // A real history, so the rule is genuinely OVERDUE (biennial, last done 2023) rather
    // than merely un-evidenced — the refusal is then the only thing that could quiet it.
    addRecord(p, "report", "Mammogram, Screening Bilateral", "2023-01-10");
    addRecord(
      p,
      "report",
      "Screening mammogram declined by patient",
      "2026-05-01"
    );

    expect(
      getInferredPreventiveSatisfactions(p).some(
        (s) => s.ruleKey === "mammography" && s.date === "2026-05-01"
      )
    ).toBe(false);
    expect(assessment(p, "mammography")?.lastDate).toBe("2023-01-10");
    expect(isActionable(p, "mammography")).toBe(true);
  });

  it("CONTROL — the mammography REPORT itself satisfies", () => {
    const p = femaleProfile("Mammogram Report");
    setProfileBirthdate(p, "1975-01-01");
    addRecord(p, "report", "Mammogram, Screening Bilateral", "2023-01-10");
    addRecord(p, "report", "Mammogram, Screening Bilateral", "2026-05-01");

    expect(getInferredPreventiveSatisfactions(p)).toContainEqual({
      ruleKey: "mammography",
      date: "2026-05-01",
    });
    expect(assessment(p, "mammography")?.lastDate).toBe("2026-05-01");
    expect(isActionable(p, "mammography")).toBe(false);
  });

  it("a refusal of an ANCILLARY leaves the Pap beside it counting", () => {
    // The direction that matters more, and the one a whole-title guard got wrong: a real
    // Pap on file stopped counting because the patient declined a CO-TEST, and the rule
    // fell back three years and went actionable. That is the harm this issue was filed
    // to remove, reproduced by its own fix.
    const p = femaleProfile("Pap Co Test Declined");
    addHpvLabs(p);
    addRecord(
      p,
      "report",
      "Pap smear — patient declined HPV co-test",
      PAP_DATE
    );

    expect(getInferredPreventiveSatisfactions(p)).toContainEqual({
      ruleKey: "cervical_cancer",
      date: PAP_DATE,
    });
    expect(assessment(p, "cervical_cancer")?.lastDate).toBe(PAP_DATE);
    expect(isActionable(p, "cervical_cancer")).toBe(false);
  });

  it("a LAB keeps its canonical identity whatever its printed name says", () => {
    // Every clinical observation is document-shaped, so a prose guard placed in front of
    // the canonical path took a lab out of its screening for a phrase printed beside the
    // analyte — a regression against main on a safety signal.
    const p = femaleProfile("Lipid Fasting Not Done");
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, canonical_name, value, value_num, created_at)
       VALUES (?, '2026-05-01', 'lab', ?, 'LDL Cholesterol', '96', 96, ?)`
    ).run(p, "Lipid panel — fasting not done", IMPORTED_AT);

    expect(getInferredPreventiveSatisfactions(p)).toContainEqual({
      ruleKey: "lipid_screening",
      date: "2026-05-01",
    });
    expect(isActionable(p, "lipid_screening")).toBe(false);
  });

  it("a `report` that ORDERS a screening does not silence it", () => {
    // An order, a referral, a reminder, a consent form and a leaflet are documents ABOUT
    // a screening that has not happened. Counting one silenced mammography for two years.
    const p = femaleProfile("Mammogram Ordered");
    setProfileBirthdate(p, "1975-01-01");
    addRecord(p, "report", "Mammogram, Screening Bilateral", "2023-01-10");
    addRecord(p, "report", "Order for screening mammogram", "2026-05-01");

    expect(
      getInferredPreventiveSatisfactions(p).some(
        (s) => s.ruleKey === "mammography" && s.date === "2026-05-01"
      )
    ).toBe(false);
    const a = assessment(p, "mammography");
    expect(a?.lastDate).toBe("2023-01-10");
    expect(a?.nextDueDate).toBe("2025-01-10");
    expect(isActionable(p, "mammography")).toBe(true);
  });

  it("a report DATED TODAY and imported today still satisfies — no date guess here", () => {
    // A screening mammogram whose result letter is photographed the afternoon of the
    // exam. A draft of this PR declined it, on the theory that a row dated its own import
    // day carries the `document_date ?? today(profileId)` fallback rather than a fact —
    // and that decline was PERMANENT (both sides are fixed at import, so it never
    // recovered) and timezone-dependent. The mammogram simply never existed. The rule is
    // gone; see the comment in lib/queries/upcoming/preventive.ts for what closing this
    // properly needs.
    const p = femaleProfile("Same Day Mammogram");
    setProfileBirthdate(p, "1975-01-01");
    addRecord(p, "report", "Mammogram, Screening Bilateral", TODAY, {
      createdAt: IMPORTED_AT,
    });

    expect(getInferredPreventiveSatisfactions(p)).toContainEqual({
      ruleKey: "mammography",
      date: TODAY,
    });
    expect(assessment(p, "mammography")?.lastDate).toBe(TODAY);
    expect(isActionable(p, "mammography")).toBe(false);
  });

  it("no nudge is sent for a satisfied rule, and the stale episode marker is cleared", () => {
    // The self-healing half the issue predicts: the marker written on 2026-08-16 by the
    // wrong nudge is retired by the not-due path on the next run, so the genuine 2027
    // nudge is not suppressed by this episode's leftover.
    const p = femaleProfile("Marker Self Heal");
    addHpvLabs(p);
    addPapReport(p);
    setProfileSetting(p, "notify_last_preventive_cervical_cancer", TODAY);

    expect(today(p)).toBe(TODAY);
    return runPreventive(p, "Marker Self Heal", TODAY).then(({ failed }) => {
      expect(failed).toBe(false);
      expect(
        getProfileSetting(p, "notify_last_preventive_cervical_cancer")
      ).toBeUndefined();
    });
  });

  it("CONTROL — an unsatisfied rule KEEPS its episode marker", () => {
    // The same run, one fixture apart: with no Pap on file the rule is still actionable,
    // so the marker must survive (it is what stops a second nudge tonight).
    const p = femaleProfile("Marker Held");
    addHpvLabs(p);
    setProfileSetting(p, "notify_last_preventive_cervical_cancer", TODAY);

    return runPreventive(p, "Marker Held", TODAY).then(() => {
      expect(
        getProfileSetting(p, "notify_last_preventive_cervical_cancer")
      ).toBe(TODAY);
    });
  });
});
