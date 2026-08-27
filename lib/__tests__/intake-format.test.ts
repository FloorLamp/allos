import { describe, it, expect } from "vitest";
import { plainBody } from "@/lib/notifications/rich-text";
import {
  renderWindowMessage,
  renderMergedIntakeMessage,
  intakeWindowNoun,
  intakeItemNoun,
  type StackOfferToken,
  type WindowDose,
} from "../notifications/intake-format";
import { offerCallback } from "../notifications/callback-data";
import { renderPostWorkoutFinishMessage } from "../notifications/workout-presence";
import type { IntakeItemKind } from "../types";
import type { AdherenceSummary } from "../intake-adherence";
import type {
  FoodTiming,
  IntakeItem,
  IntakeDose,
  IntakeObligation,
} from "../types";

// The renderer takes the profile's age and the stack-offer mint (#3282); every case
// below is about the message, so both are fixed here. OFFER stands in for a
// notify_offers row id — it is the smallest member dose id only so each stack gets a
// distinct, stable token the assertions can name.
const OFFER: StackOfferToken = (doseIds) =>
  offerCallback("stacktake", 1, Math.min(...doseIds));
const renderWindow = (
  profileId: number,
  window: Parameters<typeof renderWindowMessage>[1],
  date: string,
  entries: WindowDose[]
) => renderWindowMessage(profileId, window, date, entries, null, OFFER);
const renderMerged = (
  profileId: number,
  parts: Parameters<typeof renderMergedIntakeMessage>[1],
  date: string
) => renderMergedIntakeMessage(profileId, parts, date, null, OFFER);

function item(
  id: number,
  name: string,
  obligation: IntakeObligation = "should",
  kind: IntakeItemKind = "supplement",
  product: string | null = null,
  stack: string | null = null
): IntakeItem {
  return {
    id,
    name,
    notes: null,
    active: 1,
    created_at: "2026-07-05",
    condition: "daily",
    obligation,
    brand: null,
    product,
    situation: null,
    situation_id: null,
    pause_situation: null,
    pause_situation_id: null,
    stack,
    critical: 0,
    escalate_after_min: null,
    escalate_chat_id: null,
    quantity_on_hand: null,
    qty_per_dose: 1,
    supply_id: null,
    last_fill_size: null,
    kind,
    prescriber: null,
    pharmacy: null,
    rx_number: null,
    rx: 0,
    min_interval_hours: null,
    max_daily_count: null,
    max_daily_amount_mg: null,
    redose_notice: 0,
    rxcui: null,
    rxcui_ingredients: null,
    document_id: null,
    source: null,
    source_name: null,
    provider_id: null,
    source_record_id: null,
    indication_condition_id: null,
    cadence_kind: "daily",
    cadence_weekdays: null,
    cadence_interval_days: null,
    cadence_anchor_date: null,
  };
}

function dose(
  id: number,
  itemId: number,
  amount: string | null,
  foodTiming: FoodTiming = "any"
): IntakeDose {
  return {
    id,
    item_id: itemId,
    amount,
    time_of_day: "morning",
    food_timing: foodTiming,
    sort: 0,
    retired: 0,
    created_at: null,
    updated_at: null,
    weekdays: null,
    start_date: null,
    end_date: null,
  };
}

// No percentage by default so tests opt into the adherence tail.
const NONE: AdherenceSummary = {
  pct: null,
  takenDays: 0,
  partialDays: 0,
  skippedDays: 0,
  excusedDays: 0,
  applicableDays: 0,
};

function entry(opts: {
  doseId: number;
  itemId: number;
  name: string;
  amount?: string | null;
  taken?: boolean;
  skipped?: boolean;
  obligation?: IntakeObligation;
  food?: FoodTiming;
  kind?: IntakeItemKind;
  product?: string | null;
  stack?: string | null;
  adherence?: Partial<AdherenceSummary>;
}): WindowDose {
  return {
    dose: dose(
      opts.doseId,
      opts.itemId,
      opts.amount ?? null,
      opts.food ?? "any"
    ),
    item: item(
      opts.itemId,
      opts.name,
      opts.obligation ?? "should",
      opts.kind ?? "supplement",
      opts.product ?? null,
      opts.stack ?? null
    ),
    taken: opts.taken ?? false,
    skipped: opts.skipped ?? false,
    adherence: { ...NONE, ...opts.adherence },
  };
}

describe("renderWindowMessage", () => {
  const DATE = "2026-07-05";

  // #2858 review pass 2, R1. A ✅ button WRITES a dose, so two buttons in one
  // message reading alike over two different dose tokens is a wrong-subject tap.
  // The curated map aliases these two names onto "CoQ10" on purpose, so the pair
  // must keep its full names — resolved over the message's own pending set.
  it("never labels two take buttons alike in one message", () => {
    const msg = renderWindow(1, "Morning", DATE, [
      entry({ doseId: 10, itemId: 1, name: "Coenzyme Q10", amount: "200 mg" }),
      entry({ doseId: 11, itemId: 2, name: "Ubiquinone", amount: "200 mg" }),
    ]);
    const takes = msg.actions!.filter((a) => a.data?.startsWith("take:"));
    expect(takes.map((a) => a.label)).toEqual([
      "✅ Coenzyme Q10",
      "✅ Ubiquinone",
    ]);
    expect(new Set(takes.map((a) => a.label)).size).toBe(takes.length);
  });

  it("still shortens a take button with nothing to collide with", () => {
    const msg = renderWindow(1, "Morning", DATE, [
      entry({ doseId: 10, itemId: 1, name: "Coenzyme Q10", amount: "200 mg" }),
    ]);
    expect(msg.actions!.find((a) => a.data?.startsWith("take:"))!.label).toBe(
      "✅ CoQ10"
    );
  });

  it("keeps a medication formulation beside its scheduled dose", () => {
    const msg = renderWindow(1, "Morning", DATE, [
      entry({
        doseId: 10,
        itemId: 1,
        name: "Acetaminophen",
        amount: "160 mg",
        kind: "medication",
        product: "Children's oral suspension (160 mg / 5 mL)",
      }),
    ]);
    expect(msg.body).toContain("Acetaminophen — 160 mg / 5 mL");
  });

  it("lists pending doses with taps and no already-taken section when nothing is taken", () => {
    const msg = renderWindow(1, "Morning", DATE, [
      entry({
        doseId: 10,
        itemId: 1,
        name: "Vitamin D",
        amount: "2000 IU",
        obligation: "must",
      }),
      entry({ doseId: 11, itemId: 2, name: "Magnesium", amount: "400 mg" }),
    ]);
    expect(msg.title).toBe("💊 Morning supplements");
    expect(msg.body).toBe("🔴 Vitamin D — 2000 IU\n• Magnesium — 400 mg");
    // With ≥2 pending, an "All" tap leads; each pending dose then gets a paired
    // ✅ take + ⏭️ skip (same `row` group so they sit side by side). #232
    expect(msg.actions).toEqual([
      { label: "✅ All (2)", data: "all:1:Morning:2026-07-05" },
      { label: "✅ Vitamin D", data: "take:1:10:1:2026-07-05", row: "dose:10" },
      { label: "⏭️ Skip", data: "skip:1:10:1:2026-07-05", row: "dose:10" },
      { label: "✅ Magnesium", data: "take:1:11:2:2026-07-05", row: "dose:11" },
      { label: "⏭️ Skip", data: "skip:1:11:2:2026-07-05", row: "dose:11" },
    ]);
  });

  it("omits the All button when only one dose is pending", () => {
    const msg = renderWindow(1, "Morning", DATE, [
      entry({ doseId: 10, itemId: 1, name: "Vitamin D", amount: "2000 IU" }),
      entry({ doseId: 11, itemId: 2, name: "Magnesium", taken: true }),
    ]);
    // Only the single pending dose's ✅ take + ⏭️ skip — no redundant "All".
    expect(msg.actions).toEqual([
      { label: "✅ Vitamin D", data: "take:1:10:1:2026-07-05", row: "dose:10" },
      { label: "⏭️ Skip", data: "skip:1:10:1:2026-07-05", row: "dose:10" },
    ]);
  });

  it("reflects what was already taken this session: taken doses shown after pending, no tap for taken", () => {
    const msg = renderWindow(2, "Evening", DATE, [
      entry({
        doseId: 10,
        itemId: 1,
        name: "Vitamin D",
        amount: "2000 IU",
        taken: true,
      }),
      entry({ doseId: 11, itemId: 2, name: "Magnesium", amount: "400 mg" }),
    ]);
    expect(msg.title).toBe("💊 Evening supplements");
    // pending first, taken (✅) after
    expect(msg.body).toBe("• Magnesium — 400 mg\n✅ Vitamin D — 2000 IU");
    // only the pending dose gets buttons (✅ take + ⏭️ skip)
    expect(msg.actions).toEqual([
      { label: "✅ Magnesium", data: "take:2:11:2:2026-07-05", row: "dose:11" },
      { label: "⏭️ Skip", data: "skip:2:11:2:2026-07-05", row: "dose:11" },
    ]);
  });

  it("shows a completion summary (not a bare 'all done') once every dose is taken", () => {
    const msg = renderWindow(1, "Morning", DATE, [
      entry({
        doseId: 10,
        itemId: 1,
        name: "Vitamin D",
        amount: "2000 IU",
        taken: true,
      }),
      entry({
        doseId: 11,
        itemId: 2,
        name: "Magnesium",
        amount: "400 mg",
        taken: true,
      }),
      entry({ doseId: 12, itemId: 3, name: "Omega-3", taken: true }),
    ]);
    expect(msg.title).toBe("💊 Morning supplements — all 3 taken ✅");
    expect(msg.body).toBe(
      "✅ Magnesium — 400 mg\n✅ Omega-3\n✅ Vitamin D — 2000 IU"
    );
    // no buttons on a completed session
    expect(msg.actions).toBeUndefined();
  });

  it("appends the take-with (food) condition on pending lines only", () => {
    const msg = renderWindow(1, "Morning", DATE, [
      entry({
        doseId: 10,
        itemId: 1,
        name: "Vitamin D",
        amount: "2000 IU",
        food: "with_fat",
      }),
      entry({
        doseId: 11,
        itemId: 2,
        name: "Zinc",
        food: "empty_stomach",
        taken: true,
      }),
    ]);
    // pending shows the condition, taken drops it (guidance for taking is moot)
    expect(msg.body).toBe("• Vitamin D — 2000 IU · with fat\n✅ Zinc");
  });

  it("omits the take-with note when the dose is 'any' food timing", () => {
    const msg = renderWindow(1, "Morning", DATE, [
      entry({ doseId: 10, itemId: 1, name: "Creatine", food: "any" }),
    ]);
    expect(msg.body).toBe("• Creatine");
  });

  it("carries a food–drug guidance note on a matching pending med (#154), pending only", () => {
    const msg = renderWindow(1, "Evening", DATE, [
      // A statin pending → grapefruit guidance appended to the tail.
      entry({ doseId: 10, itemId: 1, name: "Simvastatin", amount: "40 mg" }),
      // A taken statin dose drops the guidance (moot once taken).
      entry({
        doseId: 11,
        itemId: 2,
        name: "Simvastatin",
        amount: "40 mg",
        taken: true,
      }),
    ]);
    expect(msg.body).toContain("⚠️");
    expect(plainBody(msg.body).toLowerCase()).toContain("grapefruit");
    // The taken line (after the pending one) carries no guidance.
    const lines = plainBody(msg.body).split("\n");
    expect(lines[0]).toContain("⚠️");
    expect(lines[1].startsWith("✅ Simvastatin — 40 mg")).toBe(true);
    expect(lines[1]).not.toContain("⚠️");
  });

  // #1936: the "🔥 12d" note is gone. A reminder is the last place to carry a run —
  // the message that arrives when you have NOT yet taken today's dose should not
  // also tell you what you stand to lose. The percentage says it without the cliff.
  it("appends the adherence percentage and no flame", () => {
    const msg = renderWindow(1, "Morning", DATE, [
      entry({
        doseId: 10,
        itemId: 1,
        name: "Vitamin D",
        amount: "2000 IU",
        obligation: "must",
        food: "with_fat",
        adherence: { pct: 93 },
      }),
      entry({
        doseId: 11,
        itemId: 2,
        name: "Magnesium",
        adherence: { pct: 50 },
      }),
    ]);
    // The em dash introduces the FIRST qualifier a line actually has (#2391): the
    // Magnesium row carries no amount, so its percentage leads the tail instead of
    // arriving after a `·` with nothing in front of it.
    expect(msg.body).toBe(
      "🔴 Vitamin D — 2000 IU · with fat · 93%\n• Magnesium — 50%"
    );
    expect(msg.body).not.toContain("🔥");
  });

  it("shows the percentage (but not food) on the completion summary", () => {
    const msg = renderWindow(1, "Bedtime", DATE, [
      entry({
        doseId: 10,
        itemId: 1,
        name: "Magnesium",
        amount: "400 mg",
        food: "with_food",
        taken: true,
        adherence: { pct: 100 },
      }),
    ]);
    expect(msg.title).toBe("💊 Bedtime supplements — all 1 taken ✅");
    expect(msg.body).toBe("✅ Magnesium — 400 mg · 100%");
  });

  it("sorts pending by priority then name, keeping buttons aligned with the lines", () => {
    const msg = renderWindow(1, "Morning", DATE, [
      entry({ doseId: 10, itemId: 1, name: "Zinc", obligation: "may" }),
      entry({ doseId: 11, itemId: 2, name: "Creatine", obligation: "must" }),
      entry({ doseId: 12, itemId: 3, name: "Iron", obligation: "should" }),
    ]);
    expect(msg.body).toBe("🔴 Creatine\n• Iron\n• Zinc");
    // Buttons follow the sorted lines; each dose contributes ✅ then ⏭️. #232
    expect(msg.actions?.map((a) => a.label)).toEqual([
      "✅ All (3)",
      "✅ Creatine",
      "⏭️ Skip",
      "✅ Iron",
      "⏭️ Skip",
      "✅ Zinc",
      "⏭️ Skip",
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
    const msg = renderWindow(1, "Morning", DATE, [
      entry({ doseId: 10, itemId: 1, name: "Lisinopril", kind: "medication" }),
    ]);
    expect(msg.title).toBe("💊 Morning medications");
  });

  it("titles a mixed window 'supplements & meds' (#380)", () => {
    const msg = renderWindow(1, "Morning", DATE, [
      entry({ doseId: 10, itemId: 1, name: "Lisinopril", kind: "medication" }),
      entry({ doseId: 11, itemId: 2, name: "Vitamin D", kind: "supplement" }),
    ]);
    expect(msg.title).toBe("💊 Morning supplements & meds");
  });

  it("uses the kinded noun on the completion summary too (#380)", () => {
    const msg = renderWindow(1, "Evening", DATE, [
      entry({
        doseId: 10,
        itemId: 1,
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

// ── #3098: the reminder clusters by stack and offers per-stack one-taps ──────
describe("stack clustering and one-taps (#3098)", () => {
  const DATE = "2026-07-05";

  it("orders body lines by the shared dose-day comparator — stack members cluster", () => {
    const msg = renderWindow(1, "Morning", DATE, [
      entry({ doseId: 14, itemId: 4, name: "Ashwagandha" }),
      entry({ doseId: 12, itemId: 2, name: "Magnesium", stack: "AM stack" }),
      entry({ doseId: 10, itemId: 1, name: "Zinc", obligation: "must" }),
      entry({ doseId: 11, itemId: 3, name: "Creatine", stack: "AM stack" }),
    ]);
    // Obligation first (#297), then STACK — members sit together, unstacked last.
    expect(msg.body).toBe(
      ["🔴 Zinc", "• Creatine", "• Magnesium", "• Ashwagandha"].join("\n")
    );
  });

  it("offers one button per ≥2-member stack when the slot holds other doses, All stays", () => {
    const msg = renderWindow(1, "Morning", DATE, [
      entry({ doseId: 11, itemId: 1, name: "Creatine", stack: "AM stack" }),
      entry({ doseId: 12, itemId: 2, name: "Magnesium", stack: "AM stack" }),
      entry({ doseId: 13, itemId: 3, name: "Glycine", stack: "Longevity" }),
      entry({ doseId: 14, itemId: 4, name: "NMN", stack: "Longevity" }),
      entry({ doseId: 15, itemId: 5, name: "Zinc" }),
    ]);
    const labels = msg.actions!.map((a) => a.label);
    expect(labels[0]).toBe("✅ All (5)");
    expect(labels).toContain("✅ AM stack (2)");
    expect(labels).toContain("✅ Longevity (2)");
    // One offer minted per stack, and the token names it — the member ids are the
    // stored bundle's business, an upper bound the handler re-derives against fresh
    // state (#3282).
    const am = msg.actions!.find((a) => a.label === "✅ AM stack (2)")!;
    expect(am.data).toBe("stacktake:1:11");
    const lon = msg.actions!.find((a) => a.label === "✅ Longevity (2)")!;
    expect(lon.data).toBe("stacktake:1:13");
    // Stack buttons sit above the per-dose rows.
    expect(labels.indexOf("✅ AM stack (2)")).toBeLessThan(
      labels.indexOf("✅ Creatine")
    );
  });

  it("relabels the All button when one stack IS the whole pending set — no duplicate sibling", () => {
    const msg = renderWindow(1, "Bedtime", DATE, [
      entry({ doseId: 11, itemId: 1, name: "Collagen", stack: "Sleep stack" }),
      entry({ doseId: 12, itemId: 2, name: "Magnesium", stack: "Sleep stack" }),
    ]);
    const labels = msg.actions!.map((a) => a.label);
    expect(labels[0]).toBe("✅ Sleep stack (2)");
    // Same all: token, same handler — only the label changed.
    expect(msg.actions![0].data).toBe("all:1:Bedtime:2026-07-05");
    expect(labels.filter((l) => l.includes("Sleep stack"))).toHaveLength(1);
    expect(msg.actions!.some((a) => a.data?.startsWith("stacktake:"))).toBe(
      false
    );
  });

  it("a resolved member leaves the rest of the stack as the whole pending set", () => {
    const msg = renderWindow(1, "Bedtime", DATE, [
      entry({ doseId: 11, itemId: 1, name: "Collagen", stack: "Sleep stack" }),
      entry({ doseId: 12, itemId: 2, name: "Magnesium", stack: "Sleep stack" }),
      entry({
        doseId: 13,
        itemId: 3,
        name: "Ashwagandha",
        stack: "Sleep stack",
        taken: true,
      }),
    ]);
    // Two still-pending members of one stack = the whole pending set.
    expect(msg.actions![0].label).toBe("✅ Sleep stack (2)");
    expect(msg.actions![0].data).toBe("all:1:Bedtime:2026-07-05");
  });

  it("a one-member stack earns no button — the chip stays page furniture", () => {
    const msg = renderWindow(1, "Morning", DATE, [
      entry({ doseId: 11, itemId: 1, name: "Creatine", stack: "AM stack" }),
      entry({ doseId: 12, itemId: 2, name: "Zinc" }),
    ]);
    const labels = msg.actions!.map((a) => a.label);
    expect(labels[0]).toBe("✅ All (2)");
    expect(labels.some((l) => l.includes("AM stack"))).toBe(false);
    expect(msg.actions!.some((a) => a.data?.startsWith("stacktake:"))).toBe(
      false
    );
  });

  // THE AMPUTATION #3282 REMOVES, WITH THE FIXTURE THAT REACHED IT. Six 8-digit dose
  // ids spelled out cost `stacktake:1:2026-07-05:` + 53 more bytes — 76 in all, so the
  // pre-#3282 renderer dropped this person's button entirely (measured on origin/main:
  // present at 6-digit ids, absent at 7 and 8, so the discriminator is bytes and not
  // the stack rule). This case is RED there and green here, which is the whole change.
  it("a stack too big to spell out still gets its button — the token names an offer", () => {
    const members = Array.from({ length: 6 }, (_, i) =>
      entry({
        doseId: 90000000 + i,
        itemId: 30 + i,
        name: `Member ${i}`,
        stack: "Big stack",
      })
    );
    const msg = renderWindow(1, "Morning", DATE, [
      ...members,
      entry({ doseId: 15, itemId: 5, name: "Zinc" }),
    ]);
    const big = msg.actions!.find((a) => a.label === "✅ Big stack (6)")!;
    expect(big.data).toBe("stacktake:1:90000000");
    expect(new TextEncoder().encode(big.data!).length).toBeLessThan(64);
    const labels = msg.actions!.map((a) => a.label);
    expect(labels[0]).toBe("✅ All (7)");
    expect(labels).toContain("✅ Zinc");
  });

  // THE DROP RULE, STILL LOAD-BEARING. No offer id this app can mint reaches 64 bytes,
  // so the only way to witness the rule is to hand the renderer a token that does not
  // fit — which the injected mint makes possible, and which is why the fit is CHECKED
  // rather than assumed. Delete `callbackDataFits` from doseSessionActions and this
  // dies: the button goes, never a shortened one, because an offer may never name less
  // than the tap would write (#2460).
  it("drops — never truncates — a stack button whose token does not fit", () => {
    const msg = renderWindowMessage(
      1,
      "Morning",
      DATE,
      [
        entry({ doseId: 11, itemId: 1, name: "Creatine", stack: "Big stack" }),
        entry({ doseId: 12, itemId: 2, name: "Magnesium", stack: "Big stack" }),
        entry({ doseId: 15, itemId: 5, name: "Zinc" }),
      ],
      null,
      () => `stacktake:1:${"9".repeat(54)}`
    );
    const labels = msg.actions!.map((a) => a.label);
    expect(labels.some((l) => l.includes("Big stack"))).toBe(false);
    expect(labels[0]).toBe("✅ All (3)");
    expect(labels).toContain("✅ Zinc");
  });

  it("keeps the slot word on a merged message's renamed All so two stay tellable apart (#531)", () => {
    const slotOf = (slot: "Morning" | "Bedtime", doses: WindowDose[]) => ({
      slot,
      entries: doses,
    });
    const msg = renderMerged(
      1,
      [
        slotOf("Morning", [
          entry({ doseId: 11, itemId: 1, name: "Creatine", stack: "AM stack" }),
          entry({ doseId: 12, itemId: 2, name: "Zinc", stack: "AM stack" }),
        ]),
        slotOf("Bedtime", [
          entry({
            doseId: 13,
            itemId: 3,
            name: "Collagen",
            stack: "Sleep stack",
          }),
          entry({
            doseId: 14,
            itemId: 4,
            name: "Magnesium",
            stack: "Sleep stack",
          }),
        ]),
      ],
      DATE
    );
    const labels = (msg.actions ?? []).map((a) => a.label);
    expect(labels).toContain("✅ AM stack Morning (2)");
    expect(labels).toContain("✅ Sleep stack Bedtime (2)");
  });
});

// The post-workout finish reminder renders the SAME dose-button contract from the
// SAME WindowDose shape as the slot reminder above, so its ✅ buttons are pinned
// here beside them rather than through a duplicate fixture builder elsewhere.
describe("renderPostWorkoutFinishMessage take buttons", () => {
  const DATE = "2026-07-05";

  // #2858 review pass 2, R1: a ✅ button writes a dose, so two alike in one
  // message is a wrong-subject tap.
  it("never labels two take buttons alike in one message", () => {
    const msg = renderPostWorkoutFinishMessage(1, DATE, [
      entry({ doseId: 10, itemId: 1, name: "Coenzyme Q10", amount: "200 mg" }),
      entry({ doseId: 11, itemId: 2, name: "Ubiquinone", amount: "200 mg" }),
    ]);
    const takes = msg!.actions!.filter((a) => a.data?.startsWith("take:"));
    expect(takes.map((a) => a.label)).toEqual([
      "✅ Coenzyme Q10",
      "✅ Ubiquinone",
    ]);
  });

  it("still shortens a take button with nothing to collide with", () => {
    const msg = renderPostWorkoutFinishMessage(1, DATE, [
      entry({ doseId: 10, itemId: 1, name: "Coenzyme Q10", amount: "200 mg" }),
    ]);
    expect(msg!.actions!.find((a) => a.data?.startsWith("take:"))!.label).toBe(
      "✅ CoQ10"
    );
  });
});
