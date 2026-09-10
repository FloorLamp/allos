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
  alsoForIdentity,
  alsoForAllergenNotes,
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

// A receipt with nothing to add: identity settled, no allergy hit. The duplicate clause
// still prints — it is unconditional.
const clean: AlsoForNotes = { allergens: [], identity: "name-only" };

function childContext(
  overrides: Partial<PediatricFormContext> = {}
): PediatricFormContext {
  return {
    ageMonths: 60, // 5 years
    weightKg: 18,
    weightDate: "2026-09-01",
    weightUnit: "kg",
    today: "2026-09-09",
    declinedDoseUpdates: [],
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

// ── WHAT THE BOTTLE IS, BEFORE WHAT IT DOSES (#5230 ruling 11) ─────────────────
//
// Six mutually exclusive states over two independent readings — the bottle's NAME and
// the source row's stored CODE. The shipped resolver was code-first with a name
// fallback, so a bottle named `Tylenol Extra Strength` over an ibuprofen-coded row
// handed a six-year-old 200 mg of ibuprofen (executed), and an uncoded `Aspirin` bottle
// quoted a Reye's refusal about a product nobody had named.
//
// THE BLOCK CARRIES CODED ROWS. The banked dose suite above is entirely `rxcui: null`,
// which is a claim about half the state space and the specific hole this round closes.
describe("what the bottle is, decided before what it doses", () => {
  const label = (
    name: string,
    rxcui: string | null = null,
    rxcuiIngredients: string[] | null = null
  ) => ({ name, rxcui, rxcuiIngredients });
  const source = { personName: "Mira", itemName: "Ibuprofen 200 mg" };
  const bigKid = (): PediatricFormContext => ({
    ageMonths: 72,
    weightKg: 22.7,
    weightDate: "2026-09-01",
    weightUnit: "kg",
    today: "2026-09-10",
    declinedDoseUpdates: [],
  });
  const grown = (): PediatricFormContext => ({ ...bigKid(), ageMonths: 480 });

  it.each([
    { id: "F1", l: label("Advil"), state: "name-only" },
    { id: "F3", l: label("Aspirin"), state: "name-only" },
    { id: "F6", l: label("Kirkland Ibuprofen 200 mg"), state: "no-product" },
    { id: "F9", l: label("Mira's painkillers"), state: "no-product" },
    { id: "F10", l: label("Aspirin", "197803"), state: "no-product" },
    { id: "F11", l: label("Advil", "723"), state: "no-product" },
    { id: "F14", l: label("Advil", "5640"), state: "agreement" },
    {
      id: "F15",
      l: label("Children's Motrin", "197803", ["5640"]),
      state: "agreement",
    },
    {
      id: "F16",
      l: label("Tylenol Extra Strength", "5640"),
      state: "mismatch",
    },
    { id: "F17", l: label("Mira's painkillers", "5640"), state: "coded-only" },
    {
      id: "F18",
      l: label("Advil Dual Action with Acetaminophen"),
      state: "plural",
    },
    {
      id: "F20",
      l: label("Advil Dual Action with Acetaminophen", "1191"),
      state: "plural",
    },
  ])("$id reads as $state", ({ l, state }) => {
    expect(alsoForIdentity(l).state).toBe(state);
  });

  // RULING 7'S DEFECT WITH THE NUMBER ON IT. Rules out the shipped code-first resolver,
  // which wrote 200 mg of ibuprofen under a bottle named Tylenol — for an adult AND for
  // a six-year-old.
  it("F16: a name and a code that disagree write no figure, at any age", () => {
    const l = label("Tylenol Extra Strength", "5640");
    for (const pediatric of [grown(), bigKid()]) {
      const dose = resolveAlsoForDose({ label: l, pediatric, source });
      expect(dose.kind).toBe("none");
    }
  });

  // Rules out running ruling 6's gate on the DISPUTED code: the shipped resolver
  // answered the child's question about the wrong product entirely.
  it("F16: the life-stage gate does not run under a mismatch", () => {
    const dose = resolveAlsoForDose({
      label: label("Children's Tylenol", "1191"),
      pediatric: bigKid(),
      source,
    });
    // Aspirin-coded: code-first, the shipped resolver refused with the Reye's sentence
    // about a product the bottle's own name never mentions.
    expect(dose.kind).toBe("none");
    expect(dose.kind === "none" && dose.reason).not.toMatch(
      /children's dosing chart/
    );
  });

  it("F16: the refusal names BOTH products", () => {
    const dose = resolveAlsoForDose({
      label: label("Tylenol Extra Strength", "5640"),
      pediatric: grown(),
      source,
    });
    expect(dose.kind === "none" && dose.reason).toContain("Acetaminophen");
    expect(dose.kind === "none" && dose.reason).toContain("Ibuprofen");
    expect(dose.kind === "none" && dose.reason).toContain("Mira");
  });

  // Rules out deriving a figure from ONE ingredient of a combination bottle — whether
  // the coded product is among the detected set (F19) or outside it entirely (F20,
  // where the shipped resolver would hand out 325 mg of ASPIRIN).
  it.each([
    { id: "F18", l: label("Advil Dual Action with Acetaminophen") },
    { id: "F19", l: label("Advil Dual Action with Acetaminophen", "5640") },
    { id: "F20", l: label("Advil Dual Action with Acetaminophen", "1191") },
  ])("$id: a name listing two medicines writes no figure", ({ l }) => {
    const dose = resolveAlsoForDose({ label: l, pediatric: grown(), source });
    expect(dose.kind).toBe("none");
    expect(dose.kind === "none" && dose.reason).toContain(
      "more than one medicine"
    );
  });

  // Rules out a plural refusal that also runs the age gate on one of the listed
  // products: a plural identity has nothing single to gate on.
  it("F18: the life-stage gate does not run under a plural name either", () => {
    expect(
      resolveAlsoForDose({
        label: label("Aspirin and acetaminophen rub"),
        pediatric: bigKid(),
        source,
      }).kind
    ).toBe("none");
  });

  // STATE E IS NOT A MISMATCH — there is only one identity, so nothing disagrees. Rules
  // out a spec that made an uncoded bottle dose-less: it would retire the one clinical
  // gate this door keeps, silently, for exactly the bottles most people own.
  it.each([
    { id: "F3", name: "Aspirin" },
    { id: "F4", name: "Bayer" },
  ])(
    "$id: an uncoded $name still withholds for a child, with the Reye's sentence",
    ({ name }) => {
      const dose = resolveAlsoForDose({
        label: label(name),
        pediatric: bigKid(),
        source,
      });
      expect(dose.kind).toBe("withheld");
      expect(dose.kind === "withheld" && dose.reason).toContain(
        "no children's dosing chart"
      );
    }
  );

  it("F1: an uncoded Advil still derives the adult label dose", () => {
    expect(
      resolveAlsoForDose({ label: label("Advil"), pediatric: grown(), source })
    ).toMatchObject({
      kind: "amount",
      amount: "200 mg",
      ingredient: "Ibuprofen",
    });
  });

  // THE DIVIDING PREDICATE IS "IS A CODE STORED", never "does the code resolve".
  // `ingredientCuiKey` falls back to the raw rxcui, so any stored code at all suppresses
  // the name fallback — F10 is the same bottle as F3 with an unrecognised code on the
  // row, and it lands dose-less. Rules out a state split on "resolvable code".
  it("F10: a stored code the dataset does not know suppresses the name fallback", () => {
    const dose = resolveAlsoForDose({
      label: label("Aspirin", "197803"),
      pediatric: bigKid(),
      source,
    });
    expect(dose.kind).toBe("none");
    expect(dose.kind === "none" && dose.reason).not.toMatch(/but .* item is/);
  });

  // Rules out the STRICT reading of state F, which would tell the owner of an ordinary
  // bottle that the app cannot confirm what it is — and suppress their allergy check —
  // because a code nobody recognises is sitting on the source's row.
  it.each([
    { id: "F10", l: label("Aspirin", "197803") },
    { id: "F11", l: label("Advil", "723") },
    { id: "F12", l: label("Tylenol Extra Strength", "723") },
    { id: "F13", l: label("Children's Motrin", "197803") },
  ])("$id declares no mismatch", ({ l }) => {
    expect(alsoForIdentity(l).state).toBe("no-product");
  });

  // Rules out "no known word is no signal" implemented as "no signal ⇒ dose-less"
  // (ruling 9): the code is a reading, and with nothing to disagree with it, it wins.
  it("F17: a name this app knows nothing about defers to the code, and the receipt names the coded product", () => {
    const dose = resolveAlsoForDose({
      label: label("Mira's painkillers", "5640"),
      pediatric: grown(),
      source,
    });
    expect(dose).toMatchObject({
      kind: "amount",
      amount: "200 mg",
      ingredient: "Ibuprofen",
    });
    const written = alsoForWritten(
      dose,
      [
        {
          amount: "200 mg",
          time_of_day: "08:00",
          food_timing: "any",
          weekdays: null,
          start_date: null,
          end_date: null,
        },
      ],
      "2026-09-10"
    );
    expect(alsoForReceipt("Ada", written, clean)).toContain("of Ibuprofen");
  });

  // State F names what the SOURCE's own row says, not a product nobody resolved
  // (ruling 10's second consequence, which belongs here rather than to the mismatch).
  it("F6: with no curated product either way, the receipt names the source's own row", () => {
    const dose = resolveAlsoForDose({
      label: label("Kirkland Ibuprofen 200 mg"),
      pediatric: grown(),
      source,
    });
    expect(dose.kind === "none" && dose.reason).toContain(
      "Mira's Ibuprofen 200 mg"
    );
  });
});

describe("the schedule a new person inherits", () => {
  const today = "2026-09-09";
  const amount: AlsoForDose = {
    kind: "amount",
    amount: "160 mg",
    basis: "from the 24–35 lb label band",
    ingredient: "Ibuprofen",
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
      dose: {
        kind: "amount",
        amount: "200 mg",
        basis: "adult",
        ingredient: "Ibuprofen",
      },
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
    ingredient: "Ibuprofen",
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
      ingredient: "Ibuprofen",
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
    return alsoForReceipt("Ada", written, clean);
  }
});

// ── THE RECEIPT IS WHERE THE RETIRED GATES NOW SPEAK ────────────────────────────
describe("the receipt", () => {
  it("names the person, the amount, the INGREDIENT and where it came from", () => {
    expect(
      alsoForReceipt(
        "Ada",
        {
          kind: "dose",
          amount: "160 mg",
          basis: "from the 24–35 lb label band",
          ingredient: "Ibuprofen",
        },
        clean
      )
    ).toContain(
      "Added for Ada · 160 mg of Ibuprofen from the 24–35 lb label band"
    );
  });

  // Ruling 10's third consequence. `Tylenol PM`, `Advil Cold & Sinus` and `Aleve-D`
  // each detect exactly ONE curated product (executed), so the plural rule never sees
  // them and the figure is that one ingredient's label dose, not the bottle's. Rules
  // out a receipt that keeps presenting a per-ingredient figure as the bottle's dose.
  it("names the ingredient on a pending dose too", () => {
    expect(
      alsoForReceipt(
        "Ada",
        {
          kind: "pending",
          amount: "200 mg",
          basis: "from the adult label dose",
          ingredient: "Ibuprofen",
        },
        clean
      )
    ).toContain(
      "200 mg of Ibuprofen from the adult label dose, nothing due yet"
    );
  });

  it("says there is no dose yet, and why", () => {
    expect(
      alsoForReceipt(
        "Ada",
        { kind: "none", reason: "set the amount on the new row" },
        clean
      )
    ).toContain("Added for Ada · no dose yet — set the amount on the new row");
  });

  // The shrimp/krill case both passes measured. The chip is offered, the tap succeeds,
  // and this line is the ONLY place in the app that can ever say shrimp for a
  // supplement — getIntakeSafetyContext screens medications only.
  it("names a cross-reactive allergen hit the ordinary warning path cannot", () => {
    expect(
      alsoForReceipt(
        "Ada",
        {
          kind: "dose",
          amount: "1 g",
          basis: "from the adult label dose",
          ingredient: "Ibuprofen",
        },
        {
          allergens: [{ allergen: "Shrimp", viaCrossReactivity: "krill" }],
          identity: "name-only",
        }
      )
    ).toContain("Ada has a Shrimp allergy recorded, and this is krill");
  });

  it("names a direct allergen hit without inventing a cross-reaction", () => {
    expect(
      alsoForReceipt(
        "Ada",
        { kind: "none", reason: "no label" },
        { allergens: [{ allergen: "Fish" }], identity: "name-only" }
      )
    ).toContain("Ada has a Fish allergy recorded");
  });

  // ONE CLAUSE PER DEDUPED HIT. Rules out a receipt that kept the single-hit shape and
  // states only the first of a person's recorded allergies on one bottle.
  it("states every hit, one clause each", () => {
    const line = alsoForReceipt(
      "Ada",
      { kind: "none", reason: "no label" },
      {
        allergens: [
          { allergen: "Soybean" },
          { allergen: "Shrimp", viaCrossReactivity: "krill" },
        ],
        identity: "no-product",
      }
    );
    expect(line).toContain("Ada has a Soybean allergy recorded");
    expect(line).toContain(
      "Ada has a Shrimp allergy recorded, and this is krill"
    );
  });

  // A bottle carries no code, so the duplicate question cannot be asked at all — and
  // silence would read like a clean check. UNCONDITIONAL: the flag that used to gate
  // this line could only ever be false.
  it("says the duplicate question could not be asked", () => {
    expect(
      alsoForReceipt(
        "Ada",
        {
          kind: "dose",
          amount: "200 mg",
          basis: "from the adult label dose",
          ingredient: "Ibuprofen",
        },
        clean
      )
    ).toContain("we couldn’t check whether Ada already has this");
  });

  // ── RULING 11: a disputed identity says which check could not run ──────────────
  //
  // Rules out a dose-less refusal that lands SILENTLY. Both states withhold the
  // life-stage gate, so both must say so; only the mismatch withholds the allergy
  // composition, so only the mismatch names allergies in the same sentence.
  it("says the children's check could not run under a plural name", () => {
    const line = alsoForReceipt(
      "Ada",
      {
        kind: "none",
        reason: "this bottle's name lists more than one medicine",
      },
      { allergens: [], identity: "plural" }
    );
    expect(line).toContain(
      "we couldn’t confirm what this bottle is, so we couldn’t check whether it’s for children"
    );
    expect(line).not.toContain("allergies");
  });

  it("says the allergy check could not run under a mismatch, in the same sentence", () => {
    expect(
      alsoForReceipt(
        "Ada",
        { kind: "none", reason: "the bottle is named Acetaminophen" },
        { allergens: [], identity: "mismatch" }
      )
    ).toContain(
      "so we couldn’t check whether it’s for children or against Ada’s allergies"
    );
  });

  // Rules out printing the identity clause on every receipt — an undisputed identity
  // WAS confirmed, and saying otherwise is a false statement about a check that ran.
  it("says nothing about the identity when the two readings agree", () => {
    for (const identity of [
      "agreement",
      "coded-only",
      "name-only",
      "no-product",
    ] as const) {
      expect(
        alsoForReceipt(
          "Ada",
          { kind: "none", reason: "no label" },
          { allergens: [], identity }
        )
      ).not.toContain("we couldn’t confirm what this bottle is");
    }
  });
});

// ── THE ALLERGY COMPOSITION: BOTH MATCHERS, DEDUPED ────────────────────────────
//
// Ruled by the PM on 2026-09-09 18:45 UTC. Neither matcher's silence is clearance and
// neither one alone reaches the whole cabinet, so the receipt states the UNION. Every
// row names the wrong implementation it rules out.
describe("the allergy composition", () => {
  const notes = (
    allergens: string[],
    name: string,
    rxcui: string | null = null
  ): { allergen: string; viaCrossReactivity?: string }[] =>
    alsoForAllergenNotes({
      label: { name, rxcui, rxcuiIngredients: null },
      allergens,
      records: allergens.map((substance) => ({
        substance,
        substanceCode: null,
        substanceCodeSystem: null,
      })),
    });

  // Rules out a code-only / drug-only composition: `crossCheckDrugAllergies` returns
  // nothing here, and a krill-oil supplement carries no RxCUI to run it on. This is
  // ruling 4's own case and the only place in the app a supplement's allergen is said.
  it("G1: shrimp → krill, which only the food matcher can say", () => {
    expect(notes(["Shrimp"], "Krill Oil 500 mg")).toEqual([
      { allergen: "Shrimp", viaCrossReactivity: "krill" },
    ]);
  });

  // Rules out a food-only composition: `allergenConflict` returns null on both — the
  // bottle's name shares no token with the recorded substance.
  it.each([
    {
      id: "G5",
      allergens: ["Penicillin"],
      name: "Amoxicillin 500 mg",
      rxcui: "723",
    },
    {
      id: "G6",
      allergens: ["Aspirin"],
      name: "Ibuprofen 200 mg",
      rxcui: "5640",
    },
  ])(
    "$id: $allergens → $name, which only the drug matcher can say",
    ({ allergens, name, rxcui }) => {
      expect(notes(allergens, name, rxcui)).toHaveLength(1);
      expect(notes(allergens, name, rxcui)[0].allergen).toBe(allergens[0]);
    }
  );

  // Rules out a code-only composition on the DRUG side too: this hit fires on the name.
  it("G7: an uncoded Advil still meets an ibuprofen allergy", () => {
    expect(notes(["Ibuprofen"], "Advil")).toEqual([{ allergen: "Ibuprofen" }]);
    expect(notes(["Ibuprofen"], "Advil", "5640")).toEqual([
      { allergen: "Ibuprofen" },
    ]);
  });

  // Rules out a composition that always states something.
  it("G9: no hit is no clause", () => {
    expect(notes(["Peanut"], "Vitamin D3 2000 IU")).toEqual([]);
  });

  // THE DEDUPE. Both matchers fire on the same allergy, and the drug hit fires on a NULL
  // code. Rules out keying drug hits on `allergyId` and food hits on the trigger string:
  // two key spaces that can never collide, so that union states one penicillin allergy
  // twice in one line (executed on the shipped code — UNION(2)).
  it("G4: one allergy both matchers find is ONE clause", () => {
    expect(notes(["Penicillin"], "Penicillin VK 500 mg")).toEqual([
      { allergen: "Penicillin" },
    ]);
  });

  // Rules out the CROSS-REACTIVE short-circuit: on the shipped matcher the krill hit is
  // dropped because Soybean appears in the name and the direct loop returned first.
  it("G2: a direct hit does not swallow a cross-reactive one", () => {
    expect(notes(["Shrimp", "Soybean"], "Krill Oil with Soybean Oil")).toEqual([
      { allergen: "Soybean" },
      { allergen: "Shrimp", viaCrossReactivity: "krill" },
    ]);
  });

  // Rules out a composition that keeps the single-hit shape and states only the first
  // of two allergies one bottle meets (executed: it drops to one clause). NOTE on the
  // spec's own G3 (`Peanut Soy Bar`): it cannot rule out the direct-loop short-circuit,
  // because "Soybean" does not token-match "Soy" and never hits that name at all. This
  // is G3 with a name both recorded allergens really match — and even here the DRUG
  // matcher supplies Soybean, so the food short-circuit's own control lives beside the
  // matcher, in supplement-safety.test.ts ("returns every direct hit, not just the
  // first"), where nothing masks it.
  it("G3′: two recorded allergens the same name matches are two clauses", () => {
    expect(notes(["Peanut", "Soybean"], "Peanut Soybean Bar")).toEqual([
      { allergen: "Peanut" },
      { allergen: "Soybean" },
    ]);
  });

  // Rules out keying a cross-reactive hit on its JOINED display string: "Shrimp, Crab"
  // is a pseudo-allergen `normalizeAllergenSubstance` returns unchanged, and it can
  // never compare equal to either half.
  it("G10: a cross-reactive hit keys on its unjoined triggers", () => {
    expect(notes(["Shrimp", "Crab"], "Krill Oil 500 mg")).toEqual([
      { allergen: "Shrimp, Crab", viaCrossReactivity: "krill" },
    ]);
    // Shrimp stated directly leaves only Crab for the cross-reactive clause; keying on
    // the joined string would restate shrimp.
    expect(notes(["Shrimp", "Crab"], "Shrimp Krill Oil")).toEqual([
      { allergen: "Shrimp" },
      { allergen: "Crab", viaCrossReactivity: "krill" },
    ]);
  });
});
