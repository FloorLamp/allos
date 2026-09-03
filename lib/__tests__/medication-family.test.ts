import { describe, expect, it } from "vitest";
import {
  medicationFamilies,
  ingredientCuiKey,
  medicationNameKey,
  familyDisplayLabel,
  medDupSignalKey,
  medicationDuplicationNote,
  isIndistinguishableFamily,
  MED_DUP_PREFIX,
  type MedFamilyItem,
} from "@/lib/medication-family";
import { redoseNoticeDecision } from "@/lib/prn-redose";
import { dedupeKeyHasKnownPrefix } from "@/lib/rule-finding-prefixes";

// Pure-tier pins for the #1027 medication ingredient-family derivation (the #482
// identity convention for intake items) and the family-widened redose decision. The
// DB gather tier (lib/__db_tests__/prn-family.test.ts) covers the end-to-end
// two-ibuprofen fixture; here the identity function itself is pinned.

function item(over: Partial<MedFamilyItem> & { id: number }): MedFamilyItem {
  return { name: "Ibuprofen", rxcui: null, rxcuiIngredients: null, ...over };
}

describe("medicationFamilies (#1027 / #482)", () => {
  it("shared ingredient CUI ⇒ one family (two products resolving to one ingredient)", () => {
    const fams = medicationFamilies([
      item({
        id: 1,
        name: "Advil",
        rxcui: "999900",
        rxcuiIngredients: ["5640"],
      }),
      item({
        id: 2,
        name: "Rx Pain Reliever 800",
        rxcui: "999901",
        rxcuiIngredients: ["5640"],
      }),
    ]);
    expect(fams).toHaveLength(1);
    expect(fams[0].members.map((m) => m.id)).toEqual([1, 2]);
    expect(fams[0].familyKey).toBe("cui:5640");
  });

  it("product-level rxcui stands in as a one-element ingredient set", () => {
    // One item confirmed AT the ingredient ("ibuprofen", CUI 5640), the other a
    // product whose cached ingredients contain 5640.
    const fams = medicationFamilies([
      item({ id: 1, name: "Plain", rxcui: "5640" }),
      item({
        id: 2,
        name: "Branded",
        rxcui: "999901",
        rxcuiIngredients: ["5640"],
      }),
    ]);
    expect(fams).toHaveLength(1);
  });

  it("name fallback: a resolved item bridges to a name-only sibling through the generic", () => {
    const fams = medicationFamilies([
      item({
        id: 1,
        name: "Ibuprofen",
        rxcui: "5640",
        rxcuiIngredients: ["5640"],
      }),
      item({ id: 2, name: "Ibuprofen 800 mg tablet", rxcui: null }),
    ]);
    expect(fams).toHaveLength(1);
    // CUI key wins as the family key when any member carries one.
    expect(fams[0].familyKey).toBe("cui:5640");
  });

  it("a brand name collapses to its generic (Advil ≡ Ibuprofen)", () => {
    const fams = medicationFamilies([
      item({ id: 1, name: "Advil" }),
      item({ id: 2, name: "Ibuprofen 200 mg" }),
    ]);
    expect(fams).toHaveLength(1);
    expect(fams[0].familyKey).toBe("name:ibuprofen");
  });

  it("a combination product's ingredient SET is its identity — not merged with a single-ingredient item", () => {
    const fams = medicationFamilies([
      item({
        id: 1,
        name: "Plain Single",
        rxcui: null,
        rxcuiIngredients: ["5640"],
      }),
      item({
        id: 2,
        name: "Cold Combo",
        rxcui: "999902",
        rxcuiIngredients: ["5640", "1234"],
      }),
    ]);
    expect(fams).toHaveLength(2);
  });

  it("different drugs stay apart; no resolution ⇒ own family", () => {
    const fams = medicationFamilies([
      item({ id: 1, name: "Ibuprofen" }),
      item({ id: 2, name: "Acetaminophen" }),
    ]);
    expect(fams).toHaveLength(2);
    expect(
      ingredientCuiKey({ rxcui: null, rxcuiIngredients: null })
    ).toBeNull();
    expect(medicationNameKey("")).toBeNull();
  });

  it("family display label + dup key shape", () => {
    const members = [
      item({ id: 1, name: "Advil" }),
      item({ id: 2, name: "Ibuprofen 800 mg" }),
    ];
    expect(familyDisplayLabel(members)).toBe("Ibuprofen");
    const key = medDupSignalKey(medicationFamilies(members)[0].familyKey);
    expect(key.startsWith(MED_DUP_PREFIX)).toBe(true);
    // The prefix is registered (#448) so the finding is guardable/dismissable.
    expect(dedupeKeyHasKnownPrefix(key)).toBe(true);
  });
});

// #3069 — the duplication note's distinguishability split. An INDISTINGUISHABLE
// family (one name key, no strength telling any two members apart) is duplicate
// RECORDS and says so; every other family keeps the #1027 therapeutic-duplication
// copy byte-for-byte, reassurance included.
describe("medicationDuplicationNote / isIndistinguishableFamily (#3069 / #3125)", () => {
  const EXISTING_EVIDENCE =
    "Informational — tracking an OTC and a prescription strength separately " +
    "is often deliberate; this note only makes the shared ingredient visible.";

  it("one name key + no strengths ⇒ the duplicate-records copy, no 'often deliberate' reassurance", () => {
    const members = [
      item({ id: 1, name: "albuterol" }),
      item({ id: 2, name: "albuterol" }),
      item({ id: 3, name: "albuterol" }),
    ];
    expect(isIndistinguishableFamily(members)).toBe(true);
    const copy = medicationDuplicationNote(members);
    expect(copy.title).toBe("Albuterol is recorded 3 times");
    expect(copy.detail).toBe(
      "Most likely one medication imported more than once. Their doses " +
        "already count as one toward the redose window, so nothing is " +
        "over-counted."
    );
    for (const text of [copy.title, copy.detail, copy.evidence]) {
      expect(text).not.toContain("often deliberate");
      expect(text).not.toContain("albuterol + albuterol");
    }
  });

  it("different strengths (the OTC-plus-Rx classic) ⇒ today's copy, byte for byte", () => {
    const members = [
      item({ id: 1, name: "Ibuprofen 200 mg" }),
      item({ id: 2, name: "Ibuprofen 800 mg" }),
    ];
    expect(isIndistinguishableFamily(members)).toBe(false);
    expect(
      isIndistinguishableFamily([
        item({ id: 3, name: "Epinephrine 1 mg/mL IV injection" }),
        item({ id: 4, name: "Epinephrine 1 mg/mL IM injection" }),
      ])
    ).toBe(false);
    expect(medicationDuplicationNote(members)).toEqual({
      title: "Ibuprofen appears in 2 active medications",
      detail:
        "Ibuprofen 200 mg + Ibuprofen 800 mg share the same active " +
        "ingredient, so their doses count together toward the redose window " +
        "and daily max.",
      evidence: EXISTING_EVIDENCE,
    });
  });

  it("one member with a strength, one without ⇒ cannot be proven indistinguishable — existing copy", () => {
    const members = [
      item({ id: 1, name: "Ibuprofen 200 mg" }),
      item({ id: 2, name: "Ibuprofen" }),
    ];
    expect(isIndistinguishableFamily(members)).toBe(false);
    const copy = medicationDuplicationNote(members);
    expect(copy.title).toBe("Ibuprofen appears in 2 active medications");
    expect(copy.evidence).toBe(EXISTING_EVIDENCE);
  });

  it("every member stating the SAME strength ⇒ duplicate records", () => {
    const members = [
      item({ id: 1, name: "albuterol 2.5 MG/3ML nebulizer solution" }),
      item({ id: 2, name: "Albuterol 2.5 mg/3 mL" }),
    ];
    expect(isIndistinguishableFamily(members)).toBe(true);
    expect(medicationDuplicationNote(members).title).toBe(
      "Albuterol is recorded 2 times"
    );
  });

  it("the same stated delivery form stays indistinguishable", () => {
    const members = [
      item({ id: 1, name: "Albuterol 2.5 mg/3 mL nebulizer solution" }),
      item({ id: 2, name: "albuterol (2.5 MG/3ML) solution for nebulization" }),
    ];
    expect(isIndistinguishableFamily(members)).toBe(true);
    expect(medicationDuplicationNote(members).title).toBe(
      "Albuterol is recorded 2 times"
    );
  });

  it("different stated delivery routes keep the cautious therapeutic-duplication copy", () => {
    const members = [
      item({ id: 1, name: "Albuterol 2.5 mg HFA inhaler" }),
      item({ id: 2, name: "Albuterol 2.5 mg nebulizer solution" }),
    ];
    expect(isIndistinguishableFamily(members)).toBe(false);
    expect(medicationDuplicationNote(members)).toEqual({
      title: "Albuterol appears in 2 active medications",
      detail:
        "Albuterol 2.5 mg HFA inhaler + Albuterol 2.5 mg nebulizer solution " +
        "share the same active ingredient, so their doses count together toward " +
        "the redose window and daily max.",
      evidence: EXISTING_EVIDENCE,
    });
  });

  it("two provably different concentrations stay distinguishable even with a numerator-only sibling (pairwise, not first-vs-rest)", () => {
    const members = [
      item({ id: 1, name: "Amoxicillin 400 mg" }),
      item({ id: 2, name: "Amoxicillin 400 MG/5ML" }),
      item({ id: 3, name: "Amoxicillin 400 MG/10ML" }),
    ];
    expect(isIndistinguishableFamily(members)).toBe(false);
    expect(medicationDuplicationNote(members).title).toBe(
      "Amoxicillin appears in 3 active medications"
    );
  });

  it("different name keys (the observed Albuterol Sulfate beside albuterol) ⇒ existing copy", () => {
    const members = [
      item({ id: 1, name: "Albuterol Sulfate" }),
      item({ id: 2, name: "albuterol" }),
    ];
    expect(isIndistinguishableFamily(members)).toBe(false);
    expect(medicationDuplicationNote(members).evidence).toBe(EXISTING_EVIDENCE);
  });
});

// The #1027 decision cases: the redose decision consuming FAMILY-derived inputs.
// The decision engine itself is unchanged — the safety math widens at the gather —
// so these pin that family inputs produce the protective answers.
describe("redoseNoticeDecision over family-derived inputs (#1027)", () => {
  const base = {
    minIntervalHours: 6,
    maxDailyCount: 3,
    notifiedAdministrationId: null,
    now: new Date("2026-07-19T12:00:00Z"),
    tickMinutes: 60,
  };

  it("a sibling's dose an hour ago holds the notice (not-yet, no false GO)", () => {
    // The Rx item's own last dose was 8h ago, but the OTC sibling dosed at 11:00 —
    // the family latest arms the clock.
    const d = redoseNoticeDecision({
      ...base,
      latestAdministrationId: 77, // the sibling's ledger row
      latestGivenAt: new Date("2026-07-19T11:00:00Z"),
      countInWindow: 2,
    });
    expect(d.kind).toBe("not-yet");
  });

  it("the family count at the most conservative max suppresses the notice", () => {
    const d = redoseNoticeDecision({
      ...base,
      latestAdministrationId: 78,
      latestGivenAt: new Date("2026-07-19T04:00:00Z"), // interval elapsed
      countInWindow: 3, // combined across items = min confirmed max
    });
    expect(d.kind).toBe("suppressed-max");
  });

  it("an unconfirmed sibling's logged dose still counts into the family math", () => {
    // The sibling has NO confirmed interval/max (it gets no notice of its own), but
    // its administration is a fact: it both arms the clock and joins the count.
    const d = redoseNoticeDecision({
      ...base,
      latestAdministrationId: 79, // the unconfirmed sibling's row
      latestGivenAt: new Date("2026-07-19T05:00:00Z"),
      countInWindow: 1,
    });
    expect(d.kind).toBe("fire");
    if (d.kind === "fire") {
      expect(d.administrationId).toBe(79);
      expect(d.countInWindow).toBe(1);
    }
  });
});
