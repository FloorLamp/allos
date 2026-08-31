import { describe, expect, it } from "vitest";
import {
  emptyIntakeItemFormState,
  intakeItemFields,
  intakeItemFormData,
  type IntakeItemFormState,
} from "@/lib/intake-form-fields";

// The one write mapping (#3216), and the invariant the merge is most likely to break
// silently: THE FORM POSTS WHOLE. The merged form shows one editor at a time, so a
// value seeded into a fact whose editor was never opened must still reach the action.
// It does, structurally: this mapping is a pure function of the state and is never
// told which editor was open.

function med(over: Partial<IntakeItemFormState> = {}): IntakeItemFormState {
  return { ...emptyIntakeItemFormState("medication"), ...over };
}

function value(state: IntakeItemFormState, key: string): string | null {
  const hit = intakeItemFields(state).find(([k]) => k === key);
  return hit ? hit[1] : null;
}

describe("intake form field mapping (#3216)", () => {
  it("posts every seeded fact, whatever the person opened", () => {
    // The two-tap path: a pick seeded these, the person opened NO editor, pressed Add.
    const state = med({
      name: "Ibuprofen",
      brand: "Advil",
      obligation: "may",
      minIntervalHours: "6",
      maxDailyCount: "4",
      notes: "half a tablet on bad days",
      doses: [
        {
          amount: "200 mg",
          time_of_day: "",
          food_timing: "with_food",
          weekdays: [],
          start_date: "",
          end_date: "",
        },
      ],
    });
    expect(value(state, "name")).toBe("Ibuprofen");
    expect(value(state, "brand")).toBe("Advil");
    expect(value(state, "min_interval_hours")).toBe("6");
    expect(value(state, "max_daily_count")).toBe("4");
    expect(value(state, "notes")).toBe("half a tablet on bad days");
    expect(JSON.parse(value(state, "doses") ?? "[]")[0]).toMatchObject({
      amount: "200 mg",
      food_timing: "with_food",
    });
  });

  it("writes a CLEARED optional as a blank rather than omitting it", () => {
    // Omission and blank are the same to the action for a new item, but not for an
    // edit: clearing a note has to reach the action as an empty string or the old
    // note survives a save that looked like it removed it.
    const state = med({ id: 12, notes: "" });
    expect(value(state, "notes")).toBe("");
  });

  it("the redose trio is a PRN medication's only, so a flip cannot leave one armed", () => {
    const scheduled = med({
      obligation: "must",
      minIntervalHours: "6",
      maxDailyCount: "4",
      redoseNotice: true,
    });
    expect(value(scheduled, "min_interval_hours")).toBeNull();
    expect(value(scheduled, "max_daily_count")).toBeNull();
    expect(value(scheduled, "redose_notice")).toBeNull();
  });

  it("the redose opt-in needs BOTH confirmed numbers", () => {
    const half = med({
      obligation: "may",
      minIntervalHours: "6",
      redoseNotice: true,
    });
    expect(value(half, "redose_notice")).toBeNull();
    const both = med({
      obligation: "may",
      minIntervalHours: "6",
      maxDailyCount: "4",
      redoseNotice: true,
    });
    expect(value(both, "redose_notice")).toBe("1");
  });

  it("keeps kind-specific fields apart while posting shared child rows", () => {
    const supp: IntakeItemFormState = {
      ...emptyIntakeItemFormState("supplement"),
      prescriber: "Dr. Rivera",
      rx: true,
      stack: "D3 + K2",
    };
    expect(value(supp, "prescriber")).toBeNull();
    expect(value(supp, "rx")).toBeNull();
    // The stack stays supplement-only; composition and purpose rows belong to either
    // kind so an edit can preserve, change, or clear them after a flip (#3649).
    expect(value(supp, "stack")).toBe("D3 + K2");
    expect(value(supp, "ingredients")).toBe("[]");
    const flipped = med({
      ingredients: [{ name: "Zinc", amount: "5 mg" }],
      purposes: [{ kind: "goal", goalKey: "immunity" }],
    });
    expect(value(flipped, "stack")).toBeNull();
    expect(JSON.parse(value(flipped, "ingredients")!)).toEqual(
      flipped.ingredients
    );
    expect(JSON.parse(value(flipped, "purposes")!)).toEqual(flipped.purposes);
  });

  it("the situation only rides along while the condition is situational", () => {
    expect(
      value(med({ condition: "daily", situation: "Illness" }), "situation")
    ).toBe("");
    expect(
      value(
        med({ condition: "situational", situation: "Illness" }),
        "situation"
      )
    ).toBe("Illness");
  });

  it("ingredient CUIs are coupled to the code, so a cleared code strands nothing", () => {
    const withCode = med({ rxcui: "1234", rxcuiIngredients: ["5678"] });
    expect(value(withCode, "rxcui_ingredients")).toContain("5678");
    const cleared = med({ rxcui: "", rxcuiIngredients: ["5678"] });
    expect(value(cleared, "rxcui_ingredients")).toBe("");
  });

  it("escalation numbers ride only for a critical item", () => {
    expect(
      value(
        med({ critical: false, escalateAfterMin: "120" }),
        "escalate_after_min"
      )
    ).toBeNull();
    expect(
      value(
        med({ critical: true, escalateAfterMin: "120" }),
        "escalate_after_min"
      )
    ).toBe("120");
  });

  it("qty per dose never reaches the action as zero", () => {
    // Days-of-supply divides by it.
    expect(value(med({ qtyPerDose: "" }), "qty_per_dose")).toBe("1");
  });

  it("an id is posted only when there is one to update", () => {
    expect(value(med(), "id")).toBeNull();
    expect(value(med({ id: 7 }), "id")).toBe("7");
    // The stop date is an edit-only concept — a course cannot be retired before it
    // is opened.
    expect(value(med({ endDate: "2026-08-19" }), "end_date")).toBeNull();
    expect(value(med({ id: 7, endDate: "2026-08-19" }), "end_date")).toBe(
      "2026-08-19"
    );
  });

  it("the FormData carries exactly the mapped entries", () => {
    const state = med({ name: "Ibuprofen" });
    const fd = intakeItemFormData(state);
    for (const [k, v] of intakeItemFields(state)) expect(fd.get(k)).toBe(v);
  });
});
