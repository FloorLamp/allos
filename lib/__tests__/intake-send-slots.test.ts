// Issue #1154: the send-slot model — the PreWorkout pseudo-slot's membership
// (doseSendSlot), its minute (preWorkoutSlotMinute), the merged one-per-tick render
// (renderMergedIntakeMessage), and the callback plumbing that keeps a merged
// message's buttons working (parseAllCallback / keyboardDoseFootprint).
// Plus the #1156 notification priority floor's pure pieces.

import { describe, it, expect } from "vitest";
import {
  doseSendSlot,
  notifiableWindowDoses,
  renderWindowMessage,
  renderMergedIntakeMessage,
  INTAKE_SLOT_LABELS,
  type WindowDose,
} from "../notifications/supplement-format";
import { preWorkoutSlotMinute } from "../notifications/schedule";
import {
  parseAllCallback,
  keyboardDoseFootprint,
} from "../notifications/callback-data";
import {
  accruesMisses,
  escalatesOnMiss,
  isPrn,
  isPushedIntake,
  type TimeBucket,
} from "../supplement-schedule";
import { escalationWindowPhrase } from "../notifications/escalation";
import type { AdherenceSummary } from "../supplement-adherence";
import type {
  Supplement,
  SupplementCondition,
  SupplementDose,
  SupplementKind,
  IntakeObligation,
} from "../types";

function supp(
  id: number,
  name: string,
  obligation: IntakeObligation = "should",
  kind: SupplementKind = "supplement",
  condition: SupplementCondition = "daily"
): Supplement {
  return {
    id,
    name,
    notes: null,
    active: 1,
    created_at: "2026-07-05",
    condition,
    obligation,
    brand: null,
    product: null,
    situation: null,
    situation_id: null,
    pause_situation: null,
    pause_situation_id: null,
    stack: null,
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
  supplementId: number,
  amount: string | null
): SupplementDose {
  return {
    id,
    item_id: supplementId,
    amount,
    time_of_day: "morning",
    food_timing: "any",
    sort: 0,
    retired: 0,
    created_at: null,
    updated_at: null,
    weekdays: null,
    start_date: null,
    end_date: null,
  };
}

const NONE: AdherenceSummary = {
  pct: null,
  takenDays: 0,
  partialDays: 0,
  skippedDays: 0,
  applicableDays: 0,
};

function entry(
  s: Supplement,
  d: SupplementDose,
  state: { taken?: boolean; skipped?: boolean } = {}
): WindowDose {
  return {
    dose: d,
    supp: s,
    taken: state.taken ?? false,
    skipped: state.skipped ?? false,
    adherence: NONE,
  };
}

// ---- doseSendSlot (#1154 Fix A) --------------------------------------------

describe("doseSendSlot", () => {
  const cases: [SupplementCondition, TimeBucket, boolean, string][] = [
    // anytime + pre_workout OPTS INTO the workout-relative pseudo-slot…
    ["pre_workout", "Anytime", true, "PreWorkout"],
    // …but only when a cadence/hour is inferable — else today's Morning fold.
    ["pre_workout", "Anytime", false, "Morning"],
    // An EXPLICIT bucket is honored (the recorded design call).
    ["pre_workout", "Morning", true, "Morning"],
    ["pre_workout", "Evening", true, "Evening"],
    // Non-pre_workout conditions never move.
    ["daily", "Anytime", true, "Morning"],
    ["post_workout", "Anytime", true, "Morning"],
    ["rest_day", "Anytime", true, "Morning"],
    ["daily", "Before sleep", true, "Bedtime"],
  ];
  it.each(cases)(
    "%s + %s (workoutTimed=%s) → %s",
    (cond, bucket, timed, want) => {
      expect(doseSendSlot(cond, bucket, timed)).toBe(want);
    }
  );
});

describe("preWorkoutSlotMinute", () => {
  it("fires one hour before the inferred training time (18:00 → 17:00)", () => {
    expect(preWorkoutSlotMinute(18 * 60)).toBe(17 * 60);
  });
  it("wraps at midnight (00:30 → 23:30)", () => {
    expect(preWorkoutSlotMinute(30)).toBe(23 * 60 + 30);
  });
});

// ---- The shared push predicate (pure pieces, #1156 → #1505) ----------------

describe("isPushedIntake (#1505)", () => {
  it("excludes exactly `may`, and reads obligation ALONE", () => {
    expect(isPushedIntake({ obligation: "may" })).toBe(false);
    expect(isPushedIntake({ obligation: "should" })).toBe(true);
    expect(isPushedIntake({ obligation: "must" })).toBe(true);
  });

  it("no longer consults kind at all — a `may` MEDICATION is not pushed either", () => {
    // The pre-#1505 predicate carved medications out because `kind` was doing
    // pushability's job. Obligation does that now, and a medication is pushed
    // because it defaults to `must` (and can only leave must through an explicit
    // consequence-stating confirm) — not because of what it is.
    expect(isPushedIntake({ obligation: "may" })).toBe(false);
    expect(isPushedIntake({ obligation: "must" })).toBe(true);
  });
});

describe("the obligation semantics table (#1505)", () => {
  it("send / count / escalate differ exactly where the model says they do", () => {
    const rows: {
      obligation: IntakeObligation;
      pushed: boolean;
      counts: boolean;
      escalates: boolean;
    }[] = [
      { obligation: "must", pushed: true, counts: true, escalates: true },
      { obligation: "should", pushed: true, counts: true, escalates: false },
      { obligation: "may", pushed: false, counts: false, escalates: false },
    ];
    for (const r of rows) {
      expect(isPushedIntake({ obligation: r.obligation })).toBe(r.pushed);
      expect(accruesMisses({ obligation: r.obligation })).toBe(r.counts);
      expect(escalatesOnMiss({ obligation: r.obligation })).toBe(r.escalates);
      // `may` IS the PRN shape — the flag it absorbed.
      expect(isPrn({ obligation: r.obligation })).toBe(r.obligation === "may");
    }
  });
});

describe("notifiableWindowDoses (#1156/#1505)", () => {
  it("drops `may`, keeps must and should — of either kind", () => {
    const entries = [
      entry(supp(1, "Ashwagandha", "may"), dose(11, 1, "300 mg")),
      entry(supp(2, "Creatine", "should"), dose(12, 2, "5 g")),
      entry(
        supp(3, "Levothyroxine", "must", "medication"),
        dose(13, 3, "50 mcg")
      ),
      entry(supp(4, "Vitamin D", "must"), dose(14, 4, "1000 IU")),
    ];
    expect(notifiableWindowDoses(entries).map((e) => e.supp.name)).toEqual([
      "Creatine",
      "Levothyroxine",
      "Vitamin D",
    ]);
  });

  it("an all-`may` slot filters to empty → the builder sends nothing (intended, not a bug)", () => {
    const entries = [
      entry(supp(1, "Beta-Alanine", "may"), dose(11, 1, "3 g")),
      entry(supp(2, "Citrulline", "may"), dose(12, 2, "6 g")),
    ];
    expect(notifiableWindowDoses(entries)).toEqual([]);
  });
});

// ---- merged render (#1154 one-per-hour) ------------------------------------

describe("renderMergedIntakeMessage", () => {
  const s1 = supp(1, "Vitamin D");
  const d1 = dose(11, 1, "1000 IU");
  const s2 = supp(2, "Magnesium");
  const d2 = dose(12, 2, "200 mg");
  const preSupp = supp(3, "Creatine", "should", "supplement", "pre_workout");
  const preDose = dose(13, 3, "5 g");

  it("a single slot renders EXACTLY the classic window message", () => {
    const parts = [{ slot: "Morning" as const, entries: [entry(s1, d1)] }];
    expect(renderMergedIntakeMessage(1, parts, "2026-07-20")).toEqual(
      renderWindowMessage(1, "Morning", "2026-07-20", [entry(s1, d1)])
    );
  });

  it("two slots merge into ONE message with per-slot sections and slot-labelled All buttons", () => {
    const parts = [
      {
        slot: "Morning" as const,
        entries: [entry(s1, d1), entry(s2, d2)],
      },
      { slot: "PreWorkout" as const, entries: [entry(preSupp, preDose)] },
    ];
    const msg = renderMergedIntakeMessage(7, parts, "2026-07-20");
    expect(msg.title).toBe("💊 Morning & Pre-workout supplements");
    expect(msg.body).toContain("Morning:");
    expect(msg.body).toContain("Pre-workout:");
    expect(msg.body).toContain("Vitamin D");
    expect(msg.body).toContain("Creatine");
    expect(msg.kind).toBe("dose");
    // Per-slot All (Morning has 2 pending → gets one, labelled with the slot so
    // two All buttons stay tellable apart — #531); PreWorkout has 1 → none.
    const allButtons = (msg.actions ?? []).filter((a) =>
      a.data?.startsWith("all:")
    );
    expect(allButtons).toHaveLength(1);
    expect(allButtons[0].label).toBe("✅ All Morning (2)");
    expect(allButtons[0].data).toBe("all:7:Morning:2026-07-20");
    // Every pending dose keeps its take/skip pair.
    const takes = (msg.actions ?? []).filter((a) =>
      a.data?.startsWith("take:")
    );
    expect(takes).toHaveLength(3);
  });

  it("the PreWorkout single-slot title uses the human label", () => {
    const msg = renderMergedIntakeMessage(
      1,
      [{ slot: "PreWorkout", entries: [entry(preSupp, preDose)] }],
      "2026-07-20"
    );
    expect(msg.title).toBe("💊 Pre-workout supplements");
    expect(INTAKE_SLOT_LABELS.PreWorkout).toBe("Pre-workout");
  });

  it("a fully-resolved merged set renders the completion summary (no buttons)", () => {
    const parts = [
      { slot: "Morning" as const, entries: [entry(s1, d1, { taken: true })] },
      {
        slot: "Midday" as const,
        entries: [entry(s2, d2, { skipped: true })],
      },
    ];
    const msg = renderMergedIntakeMessage(1, parts, "2026-07-20");
    expect(msg.actions ?? []).toEqual([]);
    expect(msg.title).toContain("all done");
  });
});

// ---- callback plumbing for merged messages ---------------------------------

describe("parseAllCallback with the PreWorkout slot", () => {
  it("accepts the pseudo-slot", () => {
    expect(parseAllCallback("all:7:PreWorkout:2026-07-20")).toEqual({
      profileId: 7,
      window: "PreWorkout",
      date: "2026-07-20",
    });
  });
  it("still rejects an unknown slot", () => {
    expect(parseAllCallback("all:7:Never:2026-07-20")).toBeNull();
  });
});

describe("keyboardDoseFootprint", () => {
  it("harvests dose ids from take/skip buttons and slots from All tokens", () => {
    const rows = [
      [
        {
          text: "✅ All Morning (2)",
          callback_data: "all:7:Morning:2026-07-20",
        },
      ],
      [
        { text: "✅ Vitamin D", callback_data: "take:7:11:1:2026-07-20" },
        { text: "⏭️ Skip", callback_data: "skip:7:11:1:2026-07-20" },
      ],
      [{ text: "✅ Creatine", callback_data: "take:7:13:3:2026-07-20" }],
      [{ text: "Open", url: "https://example.com" }],
    ];
    expect(keyboardDoseFootprint(rows)).toEqual({
      doseIds: [11, 13],
      slots: ["Morning"],
    });
  });
});

describe("escalationWindowPhrase (#1154 — PreWorkout keeps its safety net)", () => {
  it("names the pseudo-slot readably", () => {
    expect(escalationWindowPhrase("PreWorkout")).toBe("pre-workout");
    expect(escalationWindowPhrase("Morning")).toBe("morning");
  });
});
