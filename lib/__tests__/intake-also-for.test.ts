import { describe, expect, it } from "vitest";
import {
  alsoForBasis,
  alsoForBasisRefusal,
  alsoForDoseSeeds,
  alsoForEligible,
  alsoForReceipt,
  alsoForRefusalMessage,
  alsoForRefusalRefreshes,
  alsoForScheduleLabel,
  alsoForWritten,
  anyDoseLiveOn,
  decodeAlsoForBasis,
  encodeAlsoForBasis,
  sourcePlanRows,
  travellingDoseRows,
  resolveAlsoForDose,
  type AlsoForCandidateFacts,
  type AlsoForDose,
  type AlsoForNotes,
  type AlsoForRefusal,
  type AlsoForSchedule,
} from "../intake-also-for";
import type { PediatricFormContext } from "../prn-dosing";

// The pure half of "Also for" (#5230): who is offered, what amount the copy may write
// for THEM, what part of a source's schedule a new person inherits, and — after the
// 2026-09-09 rulings — what the offer SAYS instead of what it used to silently withhold.

const IBUPROFEN = {
  name: "Ibuprofen",
  rxcui: null,
  rxcuiIngredients: null,
};

const BOTTLE = { name: "Ibuprofen", strength: "200 mg" };

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

describe("the recipient's own dose", () => {
  it("takes an adult's amount from the label, never from the bottle", () => {
    const dose = resolveAlsoForDose({
      label: IBUPROFEN,
      pediatric: { ...childContext(), ageMonths: 480 },
    });
    expect(dose.kind).toBe("amount");
    // The label's low adult figure, not the bottle's "200 mg" strength.
    expect(dose).toMatchObject({ kind: "amount", amount: "200 mg" });
  });

  it("takes a child's amount from their own weight band", () => {
    const dose = resolveAlsoForDose({
      label: IBUPROFEN,
      pediatric: childContext(),
    });
    expect(dose.kind).toBe("amount");
    if (dose.kind !== "amount") return;
    expect(dose.amount).not.toBe("200 mg");
    expect(dose.basis).toContain("lb label band");
  });

  it("lands dose-less, with the band's own reason, on a stale weight", () => {
    const dose = resolveAlsoForDose({
      label: IBUPROFEN,
      pediatric: childContext({ weightDate: "2025-01-01" }),
    });
    expect(dose.kind).toBe("none");
    if (dose.kind !== "none") return;
    expect(dose.reason).toMatch(/weight/i);
  });

  it("lands dose-less on a missing weight rather than guessing", () => {
    expect(
      resolveAlsoForDose({
        label: IBUPROFEN,
        pediatric: childContext({ weightKg: null, weightDate: null }),
      })
    ).toMatchObject({ kind: "none" });
  });

  it("withholds the offer for a child when the label has no children's chart", () => {
    const dose = resolveAlsoForDose({
      label: { name: "Aspirin", rxcui: null, rxcuiIngredients: null },
      pediatric: childContext(),
    });
    expect(dose.kind).toBe("withheld");
  });

  it("withholds the offer at the label's own hard age gate", () => {
    const dose = resolveAlsoForDose({
      label: IBUPROFEN,
      pediatric: childContext({ ageMonths: 2, weightKg: 5 }),
    });
    expect(dose.kind).toBe("withheld");
  });

  it("states nothing for a product with no curated label", () => {
    expect(
      resolveAlsoForDose({
        label: {
          name: "Household Vitamin D3 (test)",
          rxcui: null,
          rxcuiIngredients: null,
        },
        pediatric: null,
      })
    ).toMatchObject({ kind: "none" });
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

// ── THE TWO FACTS THIS FEATURE OWNS ─────────────────────────────────────────────
//
// INVERTED, NOT DELETED (the non-author review, 2026-09-09). The allergy case and the
// duplicate case below are the only coverage of what both falsifying passes measured,
// so they stay — asserting the opposite of what they used to. A shrimp-allergic person
// IS offered the krill-oil bottle and an ibuprofen-800 person IS offered the 200 mg
// bottle; the receipt is where anything gets said, and the receipt tests are further
// down.
describe("eligibility — two facts, and neither of them is clinical", () => {
  const base: AlsoForCandidateFacts = {
    profileId: 7,
    name: "Ada",
    isMember: false,
    declined: false,
  };

  it("offers every writable non-member who has not declined", () => {
    expect(alsoForEligible(base)).toBe(true);
  });

  it("does not offer someone already on the bottle", () => {
    expect(alsoForEligible({ ...base, isMember: true })).toBe(false);
  });

  it("does not offer someone the bottle was declined for", () => {
    expect(alsoForEligible({ ...base, declined: true })).toBe(false);
  });

  // The gate this replaces is gone from the type itself: there is no `allergen`, no
  // `hasUnpooledDuplicate` and no `canWrite` to set, so a future round cannot quietly
  // re-derive one here. Write access is enforced at the page and the action; allergy
  // and product identity reach the person as receipt text.
  it("has no field for a clinical or identity verdict at all", () => {
    expect(Object.keys(base).sort()).toEqual([
      "declined",
      "isMember",
      "name",
      "profileId",
    ]);
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
      pool: BOTTLE,
      sourceItemId: 11,
      sourceIdentity: SOURCE_IDENTITY,
      schedule: schedule(),
      targetProfileId: 7,
      targetDay: "2026-09-09",
      dose: { kind: "amount", amount: "200 mg", basis: "adult" },
      ...over,
    });
  const moved = (
    over: Partial<Parameters<typeof alsoForBasis>[0]>
  ): AlsoForRefusal | null => alsoForBasisRefusal(basis(), basis(over));

  it("stands for an unchanged offer", () => {
    expect(moved({})).toBeNull();
  });

  // EVERY refusal is a NAMED fact. One `STALE` string for all of them is what let a
  // silent over-block present itself as "reload and try again".
  it.each([
    [
      "the recipient's day rolls over",
      { targetDay: "2026-09-10" },
      "day-rolled",
    ],
    [
      "the bottle is re-labelled",
      { pool: { ...BOTTLE, strength: "400 mg" } },
      "product-changed",
    ],
    [
      "the bottle is renamed",
      { pool: { ...BOTTLE, name: "Advil" } },
      "product-changed",
    ],
    [
      "the source's schedule changes",
      { schedule: schedule({ obligation: "may" }) },
      "source-changed",
    ],
    ["another member is chosen", { sourceItemId: 12 }, "no-offer"],
    [
      "the recipient's dose works out differently",
      { dose: { kind: "none", reason: "stale weight" } as AlsoForDose },
      "dose-changed",
    ],
  ])("says %s", (_label, over, reason) => {
    expect(moved(over)).toBe(reason);
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
  ])("says source-changed when the source's %s changes", (_label, over) => {
    expect(moved({ sourceIdentity: { ...SOURCE_IDENTITY, ...over } })).toBe(
      "source-changed"
    );
  });

  it("round-trips through the wire and refuses anything else", () => {
    expect(decodeAlsoForBasis(encodeAlsoForBasis(basis()))).toEqual(basis());
    expect(decodeAlsoForBasis("")).toBeNull();
    expect(decodeAlsoForBasis("not json")).toBeNull();
    expect(decodeAlsoForBasis(JSON.stringify({ v: 2 }))).toBeNull();
  });
});

// ── A REFUSAL THAT REFRESHES INTO A WORKING OFFER ───────────────────────────────
//
// Round two measured a card whose every tap answered "reload the cabinet and try
// again" over a state that was deterministic rather than stale, so the person was told
// to do the one thing that could never help. No message may say that again.
describe("every refusal names its fact, and none of them says reload", () => {
  const REASONS: AlsoForRefusal[] = [
    "no-offer",
    "no-bottle",
    "source-gone",
    "already-member",
    "declined",
    "day-rolled",
    "product-changed",
    "source-changed",
    "dose-changed",
    "age-gated",
    "create-failed",
  ];

  it.each(REASONS)("%s reads as a sentence about that fact", (reason) => {
    const message = alsoForRefusalMessage(reason, "Ada");
    expect(message.length).toBeGreaterThan(0);
    expect(message.toLowerCase()).not.toContain("reload");
  });

  // A midnight crossing is the case that has to refresh: the offer refuses, the card
  // re-reads the new day's basis, and the next tap works. So those reasons SAY "tap
  // again" — and the ones a retry cannot fix must not.
  it.each<[AlsoForRefusal, boolean]>([
    ["day-rolled", true],
    ["product-changed", true],
    ["source-changed", true],
    ["dose-changed", true],
  ])("%s refreshes and invites another tap", (reason) => {
    expect(alsoForRefusalRefreshes(reason)).toBe(true);
    expect(alsoForRefusalMessage(reason, "Ada")).toContain("tap again");
  });

  it.each<AlsoForRefusal>([
    "already-member",
    "age-gated",
    "declined",
    "no-offer",
    "no-bottle",
  ])("%s does not invite a tap that cannot work", (reason) => {
    expect(alsoForRefusalMessage(reason, "Ada")).not.toContain("tap again");
  });
});

// ── THREE QUESTIONS ABOUT A DOSE ROW ────────────────────────────────────────────
describe("which rows travel, whose plan it is, and whether a dose is live", () => {
  const row = (start: string | null, end: string | null) => ({
    amount: "40 mg",
    time_of_day: "08:00",
    food_timing: "any" as const,
    weekdays: null,
    start_date: start,
    end_date: end,
  });

  it("travels every row whose window has not closed in the RECIPIENT's day", () => {
    expect(
      travellingDoseRows(
        [
          row("2026-08-01", "2026-08-10"),
          row("2026-08-11", null),
          row("2026-10-01", "2026-10-07"),
        ],
        "2026-09-09"
      )
    ).toHaveLength(2);
  });

  // The two days can disagree by one, and they are different questions: what travels is
  // the recipient's, what the label says is the source's.
  it("answers the source's own plan in the SOURCE's day", () => {
    const doses = [row(null, "2026-09-09")];
    expect(sourcePlanRows(doses, "2026-09-09")).toHaveLength(1);
    expect(travellingDoseRows(doses, "2026-09-10")).toHaveLength(0);
  });

  it("says a wholly elapsed taper has nothing left to hand on", () => {
    expect(travellingDoseRows([row(null, "2026-08-10")], "2026-09-09")).toEqual(
      []
    );
  });

  // "Is a dose live" is doseOnDay's question, not the travel filter's. A step that
  // starts next month TRAVELS and is NOT a dose the person has.
  it("does not call a future step a live dose", () => {
    const future = [
      {
        amount: "10 mg",
        time_of_day: "20:00",
        food_timing: "any" as const,
        weekdays: null,
        start_date: "2026-10-01",
        end_date: "2026-10-07",
      },
    ];
    expect(anyDoseLiveOn(future, "2026-09-09")).toBe(false);
    expect(anyDoseLiveOn(future, "2026-10-02")).toBe(true);
  });
});

describe("a receipt may only claim what was written, and only what is live", () => {
  const amount: AlsoForDose = {
    kind: "amount",
    amount: "200 mg",
    basis: "from the adult label dose",
  };
  const seed = (start: string | null) => ({
    amount: "200 mg",
    time_of_day: "08:00",
    food_timing: "any" as const,
    weekdays: null,
    start_date: start,
    end_date: null,
  });

  it("keeps a derived amount when a live row carries it", () => {
    expect(alsoForWritten(amount, [seed(null)], "2026-09-09")).toEqual({
      kind: "dose",
      amount: "200 mg",
      basis: "from the adult label dose",
    });
  });

  it("states no dose when the schedule wrote no row to carry it", () => {
    const written = alsoForWritten(amount, [], "2026-09-09");
    expect(written.kind).toBe("none");
    expect(receipt(written)).toContain("no dose yet");
    expect(receipt(written)).not.toContain("200 mg");
  });

  // The attack: a source whose only dose row starts next month. The row TRAVELS, and
  // the receipt must not claim a dose the person has today.
  it("names the amount without claiming a live dose for a future step", () => {
    const written = alsoForWritten(amount, [seed("2026-10-01")], "2026-09-09");
    expect(written.kind).toBe("pending");
    expect(receipt(written)).toContain("nothing due yet");
  });

  function receipt(written: ReturnType<typeof alsoForWritten>): string {
    return alsoForReceipt("Ada", written, {
      allergen: null,
      productMatched: true,
    });
  }
});

// ── THE RECEIPT IS WHERE THE RETIRED GATES NOW SPEAK ────────────────────────────
describe("the receipt", () => {
  const clean: AlsoForNotes = { allergen: null, productMatched: true };

  it("names the person, the amount and where it came from", () => {
    expect(
      alsoForReceipt(
        "Ada",
        {
          kind: "dose",
          amount: "160 mg",
          basis: "from the 24–35 lb label band",
        },
        clean
      )
    ).toBe("Added for Ada · 160 mg from the 24–35 lb label band");
  });

  it("says there is no dose yet, and why", () => {
    expect(
      alsoForReceipt(
        "Ada",
        { kind: "none", reason: "set the amount on the new row" },
        clean
      )
    ).toBe("Added for Ada · no dose yet — set the amount on the new row");
  });

  // The shrimp/krill case both passes measured. The chip is offered, the tap succeeds,
  // and this line is the ONLY place in the app that can ever say shrimp for a
  // supplement — getIntakeSafetyContext screens medications only.
  it("names a cross-reactive allergen hit the ordinary warning path cannot", () => {
    expect(
      alsoForReceipt(
        "Ada",
        { kind: "dose", amount: "1 g", basis: "from the adult label dose" },
        {
          allergen: { allergen: "Shrimp", viaCrossReactivity: "krill" },
          productMatched: true,
        }
      )
    ).toBe(
      "Added for Ada · 1 g from the adult label dose · Ada has a Shrimp allergy recorded, and this is krill"
    );
  });

  it("names a direct allergen hit without inventing a cross-reaction", () => {
    expect(
      alsoForReceipt(
        "Ada",
        { kind: "none", reason: "no label" },
        {
          allergen: { allergen: "Fish" },
          productMatched: true,
        }
      )
    ).toContain("Ada has a Fish allergy recorded");
  });

  // A bottle carries no code, so the duplicate question cannot be asked at all — and
  // silence would read like a clean check.
  it("says the duplicate question could not be asked", () => {
    expect(
      alsoForReceipt(
        "Ada",
        { kind: "dose", amount: "200 mg", basis: "from the adult label dose" },
        { allergen: null, productMatched: false }
      )
    ).toContain("we couldn’t check whether Ada already has this");
  });
});
