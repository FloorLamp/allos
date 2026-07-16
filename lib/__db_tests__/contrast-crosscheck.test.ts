// DB INTEGRATION TIER — the contrast-safety cross-check builder (#701), per the #448
// findings-builder-test discipline.
//
// getContrastSafetyWarnings is a findings BUILDER: it GATHERS DB state (the profile's
// planned contrast studies from care_plan_items / appointments / future imaging_studies
// + the shared allergen/condition gather getIntakeSafetyContext) and hands it to the
// pure engine (crossCheckContrast). The pure tier (lib/__tests__/contrast-safety.test
// .ts) takes pre-gathered arrays and structurally can't see a gather bug (a
// completed-vs-planned study, an unfiltered allergen, the wrong CKD gate) — so this
// seeds a realistic fixture and asserts the END-TO-END finding.
//
// It also pins "one question, one computation": the SAME fixture yields the SAME
// finding on BOTH surfaces — the getContrastSafetyWarnings gather (the care-plan inline
// notice) and the Upcoming finding (collectUpcoming) — so they can't drift.
//
// Fixtures are 100% synthetic (a throwaway per-file DB via setup.ts). No AI, no network.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  getContrastSafetyWarnings,
  collectUpcoming,
  dismissFinding,
} from "@/lib/queries";
import { contrastTitle, contrastDetail } from "@/lib/contrast-safety";

function makeProfile(name: string): { profileId: number; todayStr: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  return { profileId, todayStr: today(profileId) };
}

function addCarePlanItem(
  profileId: number,
  description: string,
  status: string | null = "active"
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO care_plan_items (profile_id, description, status, planned_date)
         VALUES (?, ?, ?, ?)`
      )
      .run(profileId, description, status, "2099-01-01").lastInsertRowid
  );
}

function addAllergy(profileId: number, substance: string): void {
  db.prepare(
    `INSERT INTO allergies (profile_id, substance, status) VALUES (?, ?, 'active')`
  ).run(profileId, substance);
}

function addCondition(profileId: number, name: string): void {
  db.prepare(
    `INSERT INTO conditions (profile_id, name, status) VALUES (?, ?, 'active')`
  ).run(profileId, name);
}

describe("getContrastSafetyWarnings — planned contrast × allergy/CKD (#701)", () => {
  it("flags an iodinated-contrast allergy on both surfaces with the ACR note", () => {
    const { profileId, todayStr } = makeProfile("contrast-allergy");
    const cpId = addCarePlanItem(profileId, "CT abdomen with contrast");
    addAllergy(profileId, "Iodinated contrast media");

    // Surface 1: the gather.
    const warnings = getContrastSafetyWarnings(profileId, todayStr);
    expect(warnings).toHaveLength(1);
    const hit = warnings[0];
    expect(hit.source).toBe("careplan");
    expect(hit.sourceId).toBe(cpId);
    expect(hit.gate).toBe("allergy");
    expect(hit.contrastClass).toBe("iodinated");
    expect(contrastDetail(hit)).toContain("confirm premedication");
    expect(contrastDetail(hit)).toMatch(/Source: ACR/);

    // Surface 2: the Upcoming finding — SAME dedupeKey + title/detail (one computation).
    const upcoming = collectUpcoming(profileId, todayStr);
    const item = upcoming.find((i) => i.key === hit.dedupeKey);
    expect(item, "contrast finding present on Upcoming").toBeTruthy();
    expect(item!.domain).toBe("contrast");
    expect(item!.band).toBe("today"); // care-tier → reaches the attention hero
    expect(item!.title).toBe(contrastTitle(hit));
    expect(item!.detail).toBe(contrastDetail(hit));
  });

  it("flags a brand-name-only allergy record end-to-end (#829)", () => {
    const { profileId, todayStr } = makeProfile("contrast-brand");
    const cpId = addCarePlanItem(profileId, "CT abdomen with contrast");
    // A real-world record naming the brand, not the generic class term.
    addAllergy(profileId, "Reaction to Omnipaque");
    const warnings = getContrastSafetyWarnings(profileId, todayStr);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].source).toBe("careplan");
    expect(warnings[0].sourceId).toBe(cpId);
    expect(warnings[0].gate).toBe("allergy");
    expect(warnings[0].contrastClass).toBe("iodinated");
  });

  it("flags CKD against a planned iodinated study (contrast nephropathy)", () => {
    const { profileId, todayStr } = makeProfile("contrast-ckd");
    addCarePlanItem(profileId, "CT chest with IV contrast");
    addCondition(profileId, "Chronic kidney disease stage 3");
    const warnings = getContrastSafetyWarnings(profileId, todayStr);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].gate).toBe("renal");
    expect(warnings[0].note).toContain("contrast nephropathy");
  });

  it("dismissing the finding silences it on Upcoming (shared bus)", () => {
    const { profileId, todayStr } = makeProfile("contrast-dismiss");
    addCarePlanItem(profileId, "CT abdomen with contrast");
    addAllergy(profileId, "Iodine");
    const [hit] = getContrastSafetyWarnings(profileId, todayStr);
    expect(
      collectUpcoming(profileId, todayStr).some((i) => i.key === hit.dedupeKey)
    ).toBe(true);
    dismissFinding(profileId, hit.dedupeKey);
    expect(
      collectUpcoming(profileId, todayStr).some((i) => i.key === hit.dedupeKey)
    ).toBe(false);
  });

  it("triggers on a FUTURE structured imaging study with the contrast flag", () => {
    const { profileId, todayStr } = makeProfile("contrast-imaging-future");
    const imId = Number(
      db
        .prepare(
          `INSERT INTO imaging_studies (profile_id, modality, body_region, contrast, study_date)
           VALUES (?, 'ct', 'abdomen', 1, '2099-06-01')`
        )
        .run(profileId).lastInsertRowid
    );
    addAllergy(profileId, "Iodinated contrast");
    const warnings = getContrastSafetyWarnings(profileId, todayStr);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].source).toBe("imaging");
    expect(warnings[0].sourceId).toBe(imId);
  });
});

describe("getContrastSafetyWarnings — the negative cases (#448 guards)", () => {
  it("a non-contrast study never flags, even with an allergy on file", () => {
    const { profileId, todayStr } = makeProfile("contrast-noncontrast");
    addCarePlanItem(profileId, "CT chest without contrast");
    addCarePlanItem(profileId, "Colonoscopy screening");
    addAllergy(profileId, "Iodinated contrast");
    expect(getContrastSafetyWarnings(profileId, todayStr)).toEqual([]);
  });

  it("a planned contrast study with NO allergy / NO CKD gets nothing", () => {
    const { profileId, todayStr } = makeProfile("contrast-noallergy");
    addCarePlanItem(profileId, "CT abdomen with contrast");
    addAllergy(profileId, "Penicillin");
    addCondition(profileId, "Hypertension");
    expect(getContrastSafetyWarnings(profileId, todayStr)).toEqual([]);
  });

  it("a COMPLETED care-plan item is not a planned trigger", () => {
    const { profileId, todayStr } = makeProfile("contrast-completed");
    addCarePlanItem(profileId, "CT abdomen with contrast", "completed");
    addAllergy(profileId, "Iodinated contrast");
    expect(getContrastSafetyWarnings(profileId, todayStr)).toEqual([]);
  });

  it("a PAST imaging study (already done) is not a planned trigger", () => {
    const { profileId, todayStr } = makeProfile("contrast-imaging-past");
    db.prepare(
      `INSERT INTO imaging_studies (profile_id, modality, contrast, study_date)
       VALUES (?, 'ct', 1, '2000-01-01')`
    ).run(profileId);
    addAllergy(profileId, "Iodinated contrast");
    expect(getContrastSafetyWarnings(profileId, todayStr)).toEqual([]);
  });

  it("a resolved allergy does not screen (shared safety-context filter)", () => {
    const { profileId, todayStr } = makeProfile("contrast-resolved");
    addCarePlanItem(profileId, "CT abdomen with contrast");
    db.prepare(
      `INSERT INTO allergies (profile_id, substance, status) VALUES (?, 'Iodine', 'resolved')`
    ).run(profileId);
    expect(getContrastSafetyWarnings(profileId, todayStr)).toEqual([]);
  });

  it("scopes to the profile — another profile's allergy does not leak", () => {
    const a = makeProfile("contrast-scope-a");
    const b = makeProfile("contrast-scope-b");
    addCarePlanItem(a.profileId, "CT abdomen with contrast");
    addAllergy(b.profileId, "Iodinated contrast"); // allergy on B, study on A
    expect(getContrastSafetyWarnings(a.profileId, a.todayStr)).toEqual([]);
    expect(getContrastSafetyWarnings(b.profileId, b.todayStr)).toEqual([]);
  });
});
