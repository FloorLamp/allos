import { describe, expect, it } from "vitest";
import {
  brandOptionsFor,
  dosageOptionsFor,
  intakeKindAffordances,
} from "@/lib/intake-kind-affordances";
import { WORKOUT_CONDITIONS } from "@/lib/intake-schedule";

// REPLACES lib/__tests__/intake-form-split.test.ts.
//
// That test guarded #846's real guarantee — a medication is never offered the
// supplement-shaped affordances that taught the user wrong (SUPPLEMENT_BRANDS and its
// "e.g. Thorne" placeholder, a Stack field, workout-relative scheduling, dose
// suggestions from the supplement catalog) — by scanning two form FILES for each
// other's tokens. #3216 merges those files, so the file boundary is gone; the
// guarantee is not.
//
// Here it is asserted as what it always was: a property of the DERIVED KIND. This is
// strictly stronger than the text scan, which passed for any file that avoided the
// words and failed for any file that merely mentioned them in a comment.

describe("intake affordances by derived kind (#846 → #3216)", () => {
  const med = intakeKindAffordances("medication");
  const supp = intakeKindAffordances("supplement");

  it("a medication is never offered a supplement's suggestion lists", () => {
    // The two lists #846 caught, at their ONE call site each.
    expect(
      brandOptionsFor("medication", {
        medicationBrands: ["Advil"],
        supplementBrands: ["Thorne"],
      })
    ).toEqual(["Advil"]);
    expect(
      dosageOptionsFor("medication", {
        otcStrengths: ["200 mg"],
        catalogDosages: ["5000 IU"],
      })
    ).toEqual(["200 mg"]);
  });

  it("a supplement is never offered a medication's suggestion lists", () => {
    expect(
      brandOptionsFor("supplement", {
        medicationBrands: ["Advil"],
        supplementBrands: ["Thorne"],
      })
    ).toEqual(["Thorne"]);
    expect(
      dosageOptionsFor("supplement", {
        otcStrengths: ["200 mg"],
        catalogDosages: ["5000 IU"],
      })
    ).toEqual(["5000 IU"]);
  });

  it("workout-relative scheduling is a supplement concept only", () => {
    for (const c of WORKOUT_CONDITIONS) {
      expect(med.conditions).not.toContain(c);
      expect(supp.conditions).toContain(c);
    }
  });

  it("the stack and the label composition belong to a supplement", () => {
    expect(med.stack).toBe(false);
    expect(med.composition).toBe(false);
    expect(supp.stack).toBe(true);
    expect(supp.composition).toBe(true);
  });

  it("prescribing, redose and pediatric dosing belong to a medication", () => {
    expect(med.prescription).toBe(true);
    expect(med.redose).toBe(true);
    expect(med.pediatric).toBe(true);
    expect(med.indication).toBe(true);
    expect(supp.prescription).toBe(false);
    expect(supp.redose).toBe(false);
    expect(supp.pediatric).toBe(false);
    expect(supp.indication).toBe(false);
  });

  it("each kind's placeholders teach its own field", () => {
    // The exact wording is not the point; that the two differ is. A shared
    // placeholder is precisely the failure #846 was filed about.
    expect(med.namePlaceholder).not.toBe(supp.namePlaceholder);
    expect(med.brandPlaceholder).not.toBe(supp.brandPlaceholder);
  });

  it("a medication defaults to the obligation that carries a safety net", () => {
    expect(med.defaultObligation).toBe("must");
    expect(supp.defaultObligation).toBe("should");
  });

  it("standing the workout logger down withdraws the new choices but keeps a stored one", () => {
    const off = intakeKindAffordances("supplement", {
      activityScheduleAvailable: false,
    });
    for (const c of WORKOUT_CONDITIONS) expect(off.conditions).not.toContain(c);
    const editing = intakeKindAffordances("supplement", {
      activityScheduleAvailable: false,
      storedCondition: "post_workout",
    });
    expect(editing.conditions).toContain("post_workout");
    expect(editing.conditions).not.toContain("pre_workout");
  });
});
