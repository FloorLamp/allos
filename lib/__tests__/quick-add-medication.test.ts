import { describe, it, expect } from "vitest";
import {
  quickAddMedicationFields,
  quickAddMedicationFormData,
} from "../quick-add-medication";

// Pure mapping for the OTC medication quick-add (#843, door C). These pin the field
// shape the client posts to `addSupplement`; the DB-level ROW PARITY with the full
// MedicationForm is proven in the action tier
// (lib/__action_tests__/quick-add-medication.actions.test.ts).

function toMap(pairs: [string, string][]): Record<string, string> {
  return Object.fromEntries(pairs);
}

describe("quickAddMedicationFields (#843)", () => {
  it("maps a PRN OTC med to the intake-form fields addSupplement reads", () => {
    const m = toMap(
      quickAddMedicationFields({
        name: "Ibuprofen",
        brand: "Advil",
        amount: "200 mg",
        asNeeded: true,
        minIntervalHours: 6,
        maxDailyCount: 4,
      })
    );
    expect(m.name).toBe("Ibuprofen");
    expect(m.kind).toBe("medication");
    expect(m.condition).toBe("daily");
    expect(m.brand).toBe("Advil");
    expect(m.as_needed).toBe("1");
    expect(m.min_interval_hours).toBe("6");
    expect(m.max_daily_count).toBe("4");
    expect(JSON.parse(m.doses)).toEqual([
      { amount: "200 mg", food_timing: "any", time_of_day: "" },
    ]);
    // Redose reminder is opt-in — not set unless the user opts in.
    expect(m.redose_notice).toBeUndefined();
  });

  it("omits blank/absent optional fields so addSupplement defaults apply", () => {
    const m = toMap(
      quickAddMedicationFields({
        name: "  Acetaminophen  ",
        amount: "",
        brand: "",
        asNeeded: false,
      })
    );
    expect(m.name).toBe("Acetaminophen"); // trimmed
    expect(m.brand).toBeUndefined();
    expect(m.as_needed).toBeUndefined();
    expect(m.min_interval_hours).toBeUndefined();
    expect(m.max_daily_count).toBeUndefined();
    // A single dose row with a null amount is always present.
    expect(JSON.parse(m.doses)).toEqual([
      { amount: null, food_timing: "any", time_of_day: "" },
    ]);
  });

  it("only emits redose_notice when opted in AND both numbers are confirmed", () => {
    const optedInBoth = toMap(
      quickAddMedicationFields({
        name: "Ibuprofen",
        asNeeded: true,
        minIntervalHours: 6,
        maxDailyCount: 4,
        redoseNotice: true,
      })
    );
    expect(optedInBoth.redose_notice).toBe("1");

    const optedInMissingMax = toMap(
      quickAddMedicationFields({
        name: "Ibuprofen",
        asNeeded: true,
        minIntervalHours: 6,
        redoseNotice: true,
      })
    );
    expect(optedInMissingMax.redose_notice).toBeUndefined();
    expect(optedInMissingMax.max_daily_count).toBeUndefined();
  });

  it("drops PRN interval/max entirely when not as-needed", () => {
    const m = toMap(
      quickAddMedicationFields({
        name: "Lisinopril",
        asNeeded: false,
        minIntervalHours: 6,
        maxDailyCount: 4,
        redoseNotice: true,
      })
    );
    expect(m.as_needed).toBeUndefined();
    expect(m.min_interval_hours).toBeUndefined();
    expect(m.max_daily_count).toBeUndefined();
    expect(m.redose_notice).toBeUndefined();
  });

  it("carries rxcui + serialized ingredient CUIs only when a code is present", () => {
    const withCode = toMap(
      quickAddMedicationFields({
        name: "Ibuprofen",
        asNeeded: true,
        rxcui: "5640",
        rxcuiIngredients: ["5640"],
      })
    );
    expect(withCode.rxcui).toBe("5640");
    expect(withCode.rxcui_ingredients).toBeTruthy();

    const noCode = toMap(
      quickAddMedicationFields({
        name: "Ibuprofen",
        asNeeded: true,
        rxcuiIngredients: ["5640"],
      })
    );
    expect(noCode.rxcui).toBeUndefined();
    expect(noCode.rxcui_ingredients).toBeUndefined();
  });

  it("builds a FormData with the same entries", () => {
    const fd = quickAddMedicationFormData({
      name: "Ibuprofen",
      amount: "200 mg",
      asNeeded: true,
      minIntervalHours: 6,
      maxDailyCount: 4,
    });
    expect(fd.get("name")).toBe("Ibuprofen");
    expect(fd.get("kind")).toBe("medication");
    expect(fd.get("as_needed")).toBe("1");
    expect(JSON.parse(String(fd.get("doses")))).toEqual([
      { amount: "200 mg", food_timing: "any", time_of_day: "" },
    ]);
  });
});
