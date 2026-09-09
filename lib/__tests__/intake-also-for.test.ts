import { describe, expect, it } from "vitest";
import {
  alsoForBasis,
  alsoForDoseSeeds,
  alsoForEligible,
  alsoForReceipt,
  alsoForScheduleLabel,
  alsoForWrittenDose,
  inForceDoseRows,
  resolveAlsoForDose,
  sameIntakeProduct,
  type AlsoForCandidateFacts,
  type AlsoForDose,
  type AlsoForSchedule,
} from "../intake-also-for";
import type { PediatricFormContext } from "../prn-dosing";

// The pure half of "Also for" (#5230): who is offered, what amount the copy may write
// for THEM, and what part of a source's schedule a new person actually inherits.

const IBUPROFEN = {
  name: "Ibuprofen",
  strength: "200 mg",
  rxcui: null,
  rxcuiIngredients: null,
};

function childContext(
  overrides: Partial<PediatricFormContext> = {}
): PediatricFormContext {
  return {
    ageMonths: 60, // 5 years
    weightKg: 18,
    weightDate: "2026-09-01",
    weightUnit: "kg",
    today: "2026-09-09",
    ...overrides,
  };
}

const schedule = (over: Partial<AlsoForSchedule> = {}): AlsoForSchedule => ({
  condition: "daily",
  obligation: "should",
  situation: null,
  cadence_kind: "daily",
  cadence_weekdays: null,
  cadence_interval_days: null,
  cadence_anchor_date: null,
  doses: [
    {
      amount: "400 mg",
      time_of_day: "08:00",
      food_timing: "any",
      weekdays: null,
      start_date: null,
      end_date: null,
    },
  ],
  ...over,
});

describe("product identity (#4717)", () => {
  it("matches on RxCUI when both sides carry one, ignoring the printed name", () => {
    expect(
      sameIntakeProduct(
        { ...IBUPROFEN, rxcui: "5640" },
        {
          name: "Advil",
          strength: "200 mg",
          rxcui: "5640",
          rxcuiIngredients: null,
        }
      )
    ).toBe(true);
  });

  // The dose-amount-as-strength category error (a "400 mg" dose row is two 200 mg
  // tablets) is what let a person already tracking ibuprofen be handed a second
  // active ibuprofen item. An item has no strength column, so the honest question is
  // identity alone — and it can only ever withhold.
  it("ignores strength, because an item's dose amount is not a product strength", () => {
    expect(
      sameIntakeProduct(IBUPROFEN, { ...IBUPROFEN, strength: "800 mg" })
    ).toBe(true);
    expect(sameIntakeProduct(IBUPROFEN, { ...IBUPROFEN, strength: null })).toBe(
      true
    );
    expect(
      sameIntakeProduct(IBUPROFEN, {
        name: "Loratadine",
        strength: "200 mg",
        rxcui: null,
        rxcuiIngredients: null,
      })
    ).toBe(false);
  });
});

describe("the recipient's own dose", () => {
  it("takes an adult's amount from the label, never from the bottle", () => {
    const dose = resolveAlsoForDose({
      identity: IBUPROFEN,
      pediatric: { ...childContext(), ageMonths: 480 },
    });
    expect(dose.kind).toBe("amount");
    // The label's low adult figure, not the bottle's "200 mg" strength.
    expect(dose).toMatchObject({ kind: "amount", amount: "200 mg" });
  });

  it("takes a child's amount from their own weight band", () => {
    const dose = resolveAlsoForDose({
      identity: IBUPROFEN,
      pediatric: childContext(),
    });
    expect(dose.kind).toBe("amount");
    if (dose.kind !== "amount") return;
    expect(dose.amount).not.toBe("200 mg");
    expect(dose.basis).toContain("lb label band");
  });

  it("lands dose-less, with the band's own reason, on a stale weight", () => {
    const dose = resolveAlsoForDose({
      identity: IBUPROFEN,
      pediatric: childContext({ weightDate: "2025-01-01" }),
    });
    expect(dose.kind).toBe("none");
    if (dose.kind !== "none") return;
    expect(dose.reason).toMatch(/weight/i);
  });

  it("lands dose-less on a missing weight rather than guessing", () => {
    expect(
      resolveAlsoForDose({
        identity: IBUPROFEN,
        pediatric: childContext({ weightKg: null, weightDate: null }),
      })
    ).toMatchObject({ kind: "none" });
  });

  it("withholds the offer for a child when the label has no children's chart", () => {
    const dose = resolveAlsoForDose({
      identity: { name: "Aspirin", rxcui: null, rxcuiIngredients: null },
      pediatric: childContext(),
    });
    expect(dose.kind).toBe("withheld");
  });

  it("withholds the offer at the label's own hard age gate", () => {
    const dose = resolveAlsoForDose({
      identity: IBUPROFEN,
      pediatric: childContext({ ageMonths: 2, weightKg: 5 }),
    });
    expect(dose.kind).toBe("withheld");
  });

  it("states nothing for a product with no curated label", () => {
    expect(
      resolveAlsoForDose({
        identity: {
          name: "Household Vitamin D3 (test)",
          rxcui: null,
          rxcuiIngredients: null,
        },
        pediatric: null,
      })
    ).toMatchObject({ kind: "none" });
  });
});

describe("eligibility — an offer, not a warning", () => {
  const base: AlsoForCandidateFacts = {
    profileId: 7,
    name: "Ada",
    canWrite: true,
    isMember: false,
    hasUnpooledDuplicate: false,
    allergen: null,
    dose: {
      kind: "amount",
      amount: "200 mg",
      basis: "from the adult label dose",
    },
  };

  it("offers a writable non-member with a derivable dose", () => {
    expect(alsoForEligible(base)).toBe(true);
  });

  it("offers a writable non-member whose dose is merely omissible", () => {
    expect(
      alsoForEligible({ ...base, dose: { kind: "none", reason: "no label" } })
    ).toBe(true);
  });

  it("does not offer a person the caller cannot write", () => {
    expect(alsoForEligible({ ...base, canWrite: false })).toBe(false);
  });

  it("does not offer someone already on the bottle", () => {
    expect(alsoForEligible({ ...base, isMember: true })).toBe(false);
  });

  it("does not offer someone who already keeps the same product unpooled", () => {
    expect(alsoForEligible({ ...base, hasUnpooledDuplicate: true })).toBe(
      false
    );
  });

  it("does not offer someone with a recorded allergen conflict", () => {
    expect(alsoForEligible({ ...base, allergen: "Ibuprofen" })).toBe(false);
  });

  it("does not offer someone the product's life stage refuses", () => {
    expect(
      alsoForEligible({
        ...base,
        dose: { kind: "withheld", reason: "no children's chart" },
      })
    ).toBe(false);
  });
});

describe("the schedule a new person inherits", () => {
  const today = "2026-09-09";
  const amount: AlsoForDose = {
    kind: "amount",
    amount: "160 mg",
    basis: "from the 24–35 lb label band",
  };

  it("copies the times and the food rule, with the RECIPIENT's amount", () => {
    const seeds = alsoForDoseSeeds(
      [
        {
          amount: "400 mg",
          time_of_day: "08:00",
          food_timing: "with_food",
          weekdays: "1,3,5",
          start_date: null,
          end_date: null,
        },
      ],
      amount,
      today
    );
    expect(seeds).toEqual([
      {
        amount: "160 mg",
        time_of_day: "08:00",
        food_timing: "with_food",
        weekdays: "1,3,5",
        start_date: null,
        end_date: null,
      },
    ]);
  });

  it("writes ZERO rows when no amount is derivable — never a blank placeholder", () => {
    expect(
      alsoForDoseSeeds(schedule().doses, { kind: "none", reason: "x" }, today)
    ).toEqual([]);
  });

  it("drops an elapsed taper step and the already-open start it carried", () => {
    const seeds = alsoForDoseSeeds(
      [
        {
          amount: "40 mg",
          time_of_day: "08:00",
          food_timing: "any",
          weekdays: null,
          start_date: "2026-08-01",
          end_date: "2026-08-10",
        },
        {
          amount: "20 mg",
          time_of_day: "08:00",
          food_timing: "any",
          weekdays: null,
          start_date: "2026-08-11",
          end_date: null,
        },
      ],
      amount,
      today
    );
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({ start_date: null, end_date: null });
  });

  it("keeps a step that has not started yet, both bounds intact", () => {
    const seeds = alsoForDoseSeeds(
      [
        {
          amount: "10 mg",
          time_of_day: "20:00",
          food_timing: "any",
          weekdays: null,
          start_date: "2026-10-01",
          end_date: "2026-10-07",
        },
      ],
      amount,
      today
    );
    expect(seeds[0]).toMatchObject({
      start_date: "2026-10-01",
      end_date: "2026-10-07",
    });
  });
});

describe("the offer names the plan it will copy", () => {
  it("labels a plain daily schedule by its times", () => {
    expect(alsoForScheduleLabel(schedule())).toBe("Daily · 08:00");
  });

  it("labels an as-needed member as as-needed", () => {
    expect(alsoForScheduleLabel(schedule({ obligation: "may" }))).toBe(
      "As needed · 08:00"
    );
  });

  it("labels an interval member by its rhythm", () => {
    expect(
      alsoForScheduleLabel(
        schedule({ cadence_kind: "interval", cadence_interval_days: 3 })
      )
    ).toBe("Every 3 days · 08:00");
  });

  it("says plainly when a member keeps no dose times", () => {
    expect(alsoForScheduleLabel(schedule({ doses: [] }))).toBe(
      "Daily · no dose times"
    );
  });
});

describe("a stale offer cannot be tapped into a different plan", () => {
  const SOURCE_IDENTITY = {
    kind: "medication",
    rxcui: "5640",
    rxcuiIngredients: null,
    brand: "Advil",
    product: "200 mg tablet",
  };
  const basis = (over: Partial<Parameters<typeof alsoForBasis>[0]> = {}) =>
    alsoForBasis({
      product: IBUPROFEN,
      sourceItemId: 11,
      sourceIdentity: SOURCE_IDENTITY,
      schedule: schedule(),
      targetProfileId: 7,
      dose: { kind: "amount", amount: "200 mg", basis: "adult" },
      ...over,
    });

  it("is stable for an unchanged offer", () => {
    expect(basis()).toBe(basis());
  });

  it("changes when the source's schedule changes", () => {
    expect(basis()).not.toBe(
      basis({ schedule: schedule({ obligation: "may" }) })
    );
  });

  it("changes when another member is chosen as the source", () => {
    expect(basis()).not.toBe(basis({ sourceItemId: 12 }));
  });

  it("changes when the recipient's dose basis changes", () => {
    expect(basis()).not.toBe(
      basis({ dose: { kind: "none", reason: "stale weight" } })
    );
  });

  it("changes when the bottle's product changes", () => {
    expect(basis()).not.toBe(
      basis({ product: { ...IBUPROFEN, strength: "400 mg" } })
    );
  });

  // EVERY field the copy carries off the source row. A mid-flight edit of any of them
  // lands different facts on the recipient than the card named — and a kind flip also
  // decides whether a medication course opens at all (#5576).
  it.each([
    ["kind", { kind: "supplement" }],
    ["RxNorm identity", { rxcui: "11289" }],
    ["cached ingredients", { rxcuiIngredients: ["11289"] }],
    ["brand", { brand: "Motrin" }],
    ["product", { product: "warfarin 5 mg tablet" }],
  ])("changes when the source's %s changes", (_label, over) => {
    expect(basis()).not.toBe(
      basis({ sourceIdentity: { ...SOURCE_IDENTITY, ...over } })
    );
  });
});

describe("a receipt may only claim what was written", () => {
  const amount: AlsoForDose = {
    kind: "amount",
    amount: "200 mg",
    basis: "from the adult label dose",
  };

  it("keeps a derived amount when rows carry it", () => {
    expect(
      alsoForWrittenDose(amount, [
        {
          amount: "200 mg",
          time_of_day: "08:00",
          food_timing: "any",
          weekdays: null,
          start_date: null,
          end_date: null,
        },
      ])
    ).toEqual(amount);
  });

  it("states no dose when the schedule wrote no row to carry it", () => {
    const written = alsoForWrittenDose(amount, []);
    expect(written.kind).toBe("none");
    expect(alsoForReceipt("Ada", written)).toContain("no dose yet");
    expect(alsoForReceipt("Ada", written)).not.toContain("200 mg");
  });
});

describe("only the dose rows still in force are inherited", () => {
  const row = (start: string | null, end: string | null) => ({
    amount: "40 mg",
    time_of_day: "08:00",
    food_timing: "any" as const,
    weekdays: null,
    start_date: start,
    end_date: end,
  });

  it("drops a closed window and keeps an open or future one", () => {
    expect(
      inForceDoseRows(
        [
          row("2026-08-01", "2026-08-10"),
          row("2026-08-11", null),
          row("2026-10-01", "2026-10-07"),
        ],
        "2026-09-09"
      )
    ).toHaveLength(2);
  });

  it("says a wholly elapsed taper has nothing left to hand on", () => {
    expect(
      inForceDoseRows([row(null, "2026-08-10")], "2026-09-09")
    ).toEqual([]);
  });
});

describe("the receipt", () => {
  it("names the person, the amount and where it came from", () => {
    expect(
      alsoForReceipt("Ada", {
        kind: "amount",
        amount: "160 mg",
        basis: "from the 24–35 lb label band",
      })
    ).toBe("Added for Ada · 160 mg from the 24–35 lb label band");
  });

  it("says there is no dose yet, and why", () => {
    expect(
      alsoForReceipt("Ada", {
        kind: "none",
        reason: "set the amount on the new row",
      })
    ).toBe("Added for Ada · no dose yet — set the amount on the new row");
  });
});
