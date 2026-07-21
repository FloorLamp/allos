import { describe, it, expect } from "vitest";
import {
  renderWindowMessage,
  intakeWindowNoun,
  intakeItemNoun,
  type WindowDose,
} from "../notifications/supplement-format";
import type { SupplementKind } from "../types";
import type { AdherenceSummary } from "../supplement-adherence";
import type {
  FoodTiming,
  Supplement,
  SupplementDose,
  SupplementPriority,
} from "../types";

function supp(
  id: number,
  name: string,
  priority: SupplementPriority = "high",
  kind: SupplementKind = "supplement",
  product: string | null = null
): Supplement {
  return {
    id,
    name,
    notes: null,
    active: 1,
    created_at: "2026-07-05",
    condition: "daily",
    priority,
    brand: null,
    product,
    situation: null,
    situation_id: null,
    stack: null,
    critical: 0,
    escalate_after_min: null,
    escalate_chat_id: null,
    quantity_on_hand: null,
    qty_per_dose: 1,
    last_fill_size: null,
    kind,
    prescriber: null,
    pharmacy: null,
    rx_number: null,
    rx: 0,
    as_needed: 0,
    min_interval_hours: null,
    max_daily_count: null,
    redose_notice: 0,
    rxcui: null,
    rxcui_ingredients: null,
    document_id: null,
    source: null,
    provider_id: null,
    source_record_id: null,
    indication_condition_id: null,
  };
}

function dose(
  id: number,
  supplementId: number,
  amount: string | null,
  foodTiming: FoodTiming = "any"
): SupplementDose {
  return {
    id,
    item_id: supplementId,
    amount,
    time_of_day: "morning",
    food_timing: foodTiming,
    sort: 0,
    retired: 0,
    created_at: null,
    updated_at: null,
  };
}

// No streak / no percentage by default so tests opt into the adherence tail.
const NONE: AdherenceSummary = {
  streak: 0,
  pct: null,
  takenDays: 0,
  partialDays: 0,
  skippedDays: 0,
  applicableDays: 0,
};

function entry(opts: {
  doseId: number;
  suppId: number;
  name: string;
  amount?: string | null;
  taken?: boolean;
  skipped?: boolean;
  priority?: SupplementPriority;
  food?: FoodTiming;
  kind?: SupplementKind;
  product?: string | null;
  adherence?: Partial<AdherenceSummary>;
}): WindowDose {
  return {
    dose: dose(
      opts.doseId,
      opts.suppId,
      opts.amount ?? null,
      opts.food ?? "any"
    ),
    supp: supp(
      opts.suppId,
      opts.name,
      opts.priority ?? "high",
      opts.kind ?? "supplement",
      opts.product ?? null
    ),
    taken: opts.taken ?? false,
    skipped: opts.skipped ?? false,
    adherence: { ...NONE, ...opts.adherence },
  };
}

describe("renderWindowMessage", () => {
  const DATE = "2026-07-05";

  it("keeps a medication formulation beside its scheduled dose", () => {
    const msg = renderWindowMessage(1, "Morning", DATE, [
      entry({
        doseId: 10,
        suppId: 1,
        name: "Acetaminophen",
        amount: "160 mg",
        kind: "medication",
        product: "Children's oral suspension (160 mg / 5 mL)",
      }),
    ]);
    expect(msg.body).toContain("Acetaminophen — 160 mg / 5 mL");
  });

  it("lists pending doses with taps and no already-taken section when nothing is taken", () => {
    const msg = renderWindowMessage(1, "Morning", DATE, [
      entry({
        doseId: 10,
        suppId: 1,
        name: "Vitamin D",
        amount: "2000 IU",
        priority: "mandatory",
      }),
      entry({ doseId: 11, suppId: 2, name: "Magnesium", amount: "400 mg" }),
    ]);
    expect(msg.title).toBe("💊 Morning supplements");
    expect(msg.body).toBe("🔴 Vitamin D — 2000 IU\n• Magnesium — 400 mg");
    // With ≥2 pending, an "All" tap leads; each pending dose then gets a paired
    // ✅ take + ⏭ skip (same `row` group so they sit side by side). #232
    expect(msg.actions).toEqual([
      { label: "✅ All (2)", data: "all:1:Morning:2026-07-05" },
      { label: "✅ Vitamin D", data: "take:1:10:1:2026-07-05", row: "dose:10" },
      { label: "⏭ Skip", data: "skip:1:10:1:2026-07-05", row: "dose:10" },
      { label: "✅ Magnesium", data: "take:1:11:2:2026-07-05", row: "dose:11" },
      { label: "⏭ Skip", data: "skip:1:11:2:2026-07-05", row: "dose:11" },
    ]);
  });

  it("omits the All button when only one dose is pending", () => {
    const msg = renderWindowMessage(1, "Morning", DATE, [
      entry({ doseId: 10, suppId: 1, name: "Vitamin D", amount: "2000 IU" }),
      entry({ doseId: 11, suppId: 2, name: "Magnesium", taken: true }),
    ]);
    // Only the single pending dose's ✅ take + ⏭ skip — no redundant "All".
    expect(msg.actions).toEqual([
      { label: "✅ Vitamin D", data: "take:1:10:1:2026-07-05", row: "dose:10" },
      { label: "⏭ Skip", data: "skip:1:10:1:2026-07-05", row: "dose:10" },
    ]);
  });

  it("reflects what was already taken this session: taken doses shown after pending, no tap for taken", () => {
    const msg = renderWindowMessage(2, "Evening", DATE, [
      entry({
        doseId: 10,
        suppId: 1,
        name: "Vitamin D",
        amount: "2000 IU",
        taken: true,
      }),
      entry({ doseId: 11, suppId: 2, name: "Magnesium", amount: "400 mg" }),
    ]);
    expect(msg.title).toBe("💊 Evening supplements");
    // pending first, taken (✅) after
    expect(msg.body).toBe("• Magnesium — 400 mg\n✅ Vitamin D — 2000 IU");
    // only the pending dose gets buttons (✅ take + ⏭ skip)
    expect(msg.actions).toEqual([
      { label: "✅ Magnesium", data: "take:2:11:2:2026-07-05", row: "dose:11" },
      { label: "⏭ Skip", data: "skip:2:11:2:2026-07-05", row: "dose:11" },
    ]);
  });

  it("shows a completion summary (not a bare 'all done') once every dose is taken", () => {
    const msg = renderWindowMessage(1, "Morning", DATE, [
      entry({
        doseId: 10,
        suppId: 1,
        name: "Vitamin D",
        amount: "2000 IU",
        taken: true,
      }),
      entry({
        doseId: 11,
        suppId: 2,
        name: "Magnesium",
        amount: "400 mg",
        taken: true,
      }),
      entry({ doseId: 12, suppId: 3, name: "Omega-3", taken: true }),
    ]);
    expect(msg.title).toBe("💊 Morning supplements — all 3 taken ✅");
    expect(msg.body).toBe(
      "✅ Magnesium — 400 mg\n✅ Omega-3\n✅ Vitamin D — 2000 IU"
    );
    // no buttons on a completed session
    expect(msg.actions).toBeUndefined();
  });

  it("appends the take-with (food) condition on pending lines only", () => {
    const msg = renderWindowMessage(1, "Morning", DATE, [
      entry({
        doseId: 10,
        suppId: 1,
        name: "Vitamin D",
        amount: "2000 IU",
        food: "with_fat",
      }),
      entry({
        doseId: 11,
        suppId: 2,
        name: "Zinc",
        food: "empty_stomach",
        taken: true,
      }),
    ]);
    // pending shows the condition, taken drops it (guidance for taking is moot)
    expect(msg.body).toBe("• Vitamin D — 2000 IU · with fat\n✅ Zinc");
  });

  it("omits the take-with note when the dose is 'any' food timing", () => {
    const msg = renderWindowMessage(1, "Morning", DATE, [
      entry({ doseId: 10, suppId: 1, name: "Creatine", food: "any" }),
    ]);
    expect(msg.body).toBe("• Creatine");
  });

  it("carries a food–drug guidance note on a matching pending med (#154), pending only", () => {
    const msg = renderWindowMessage(1, "Evening", DATE, [
      // A statin pending → grapefruit guidance appended to the tail.
      entry({ doseId: 10, suppId: 1, name: "Simvastatin", amount: "40 mg" }),
      // A taken statin dose drops the guidance (moot once taken).
      entry({
        doseId: 11,
        suppId: 2,
        name: "Simvastatin",
        amount: "40 mg",
        taken: true,
      }),
    ]);
    expect(msg.body).toContain("⚠️");
    expect(msg.body.toLowerCase()).toContain("grapefruit");
    // The taken line (after the pending one) carries no guidance.
    const lines = msg.body.split("\n");
    expect(lines[0]).toContain("⚠️");
    expect(lines[1].startsWith("✅ Simvastatin — 40 mg")).toBe(true);
    expect(lines[1]).not.toContain("⚠️");
  });

  it("appends streak (only once ≥2) and adherence percentage", () => {
    const msg = renderWindowMessage(1, "Morning", DATE, [
      entry({
        doseId: 10,
        suppId: 1,
        name: "Vitamin D",
        amount: "2000 IU",
        priority: "mandatory",
        food: "with_fat",
        adherence: { streak: 12, pct: 93 },
      }),
      // streak of 1 is below the threshold → not shown, but pct still is
      entry({
        doseId: 11,
        suppId: 2,
        name: "Magnesium",
        adherence: { streak: 1, pct: 50 },
      }),
    ]);
    expect(msg.body).toBe(
      "🔴 Vitamin D — 2000 IU · with fat · 🔥 12d · 93%\n• Magnesium · 50%"
    );
  });

  it("shows streak + percentage (but not food) on the completion summary", () => {
    const msg = renderWindowMessage(1, "Bedtime", DATE, [
      entry({
        doseId: 10,
        suppId: 1,
        name: "Magnesium",
        amount: "400 mg",
        food: "with_food",
        taken: true,
        adherence: { streak: 7, pct: 100 },
      }),
    ]);
    expect(msg.title).toBe("💊 Bedtime supplements — all 1 taken ✅");
    expect(msg.body).toBe("✅ Magnesium — 400 mg · 🔥 7d · 100%");
  });

  it("sorts pending by priority then name, keeping buttons aligned with the lines", () => {
    const msg = renderWindowMessage(1, "Morning", DATE, [
      entry({ doseId: 10, suppId: 1, name: "Zinc", priority: "low" }),
      entry({ doseId: 11, suppId: 2, name: "Creatine", priority: "mandatory" }),
      entry({ doseId: 12, suppId: 3, name: "Iron", priority: "high" }),
    ]);
    expect(msg.body).toBe("🔴 Creatine\n• Iron\n• Zinc");
    // Buttons follow the sorted lines; each dose contributes ✅ then ⏭. #232
    expect(msg.actions?.map((a) => a.label)).toEqual([
      "✅ All (3)",
      "✅ Creatine",
      "⏭ Skip",
      "✅ Iron",
      "⏭ Skip",
      "✅ Zinc",
      "⏭ Skip",
    ]);
    // The take + skip for one dose share a `row` group; "All" stands alone.
    expect(msg.actions?.map((a) => a.row)).toEqual([
      undefined,
      "dose:11",
      "dose:11",
      "dose:12",
      "dose:12",
      "dose:10",
      "dose:10",
    ]);
  });

  it("titles a medications-only window 'medications', not 'supplements' (#380)", () => {
    const msg = renderWindowMessage(1, "Morning", DATE, [
      entry({ doseId: 10, suppId: 1, name: "Lisinopril", kind: "medication" }),
    ]);
    expect(msg.title).toBe("💊 Morning medications");
  });

  it("titles a mixed window 'supplements & meds' (#380)", () => {
    const msg = renderWindowMessage(1, "Morning", DATE, [
      entry({ doseId: 10, suppId: 1, name: "Lisinopril", kind: "medication" }),
      entry({ doseId: 11, suppId: 2, name: "Vitamin D", kind: "supplement" }),
    ]);
    expect(msg.title).toBe("💊 Morning supplements & meds");
  });

  it("uses the kinded noun on the completion summary too (#380)", () => {
    const msg = renderWindowMessage(1, "Evening", DATE, [
      entry({
        doseId: 10,
        suppId: 1,
        name: "Metformin",
        kind: "medication",
        taken: true,
      }),
    ]);
    expect(msg.title).toBe("💊 Evening medications — all 1 taken ✅");
  });
});

describe("intakeWindowNoun", () => {
  it("returns 'supplements' for supplement-only or empty windows", () => {
    expect(intakeWindowNoun([])).toBe("supplements");
    expect(intakeWindowNoun(["supplement", "supplement"])).toBe("supplements");
  });

  it("returns 'medications' when every item is a medication", () => {
    expect(intakeWindowNoun(["medication", "medication"])).toBe("medications");
  });

  it("returns 'supplements & meds' when both kinds are present", () => {
    expect(intakeWindowNoun(["medication", "supplement"])).toBe(
      "supplements & meds"
    );
  });
});

describe("intakeItemNoun (singular modifier)", () => {
  it("gives the singular adjectival form for the 'N ___ dose(s)' phrasing", () => {
    expect(intakeItemNoun([])).toBe("supplement");
    expect(intakeItemNoun(["supplement"])).toBe("supplement");
    expect(intakeItemNoun(["medication"])).toBe("medication");
    expect(intakeItemNoun(["medication", "supplement"])).toBe(
      "supplement & med"
    );
  });
});
