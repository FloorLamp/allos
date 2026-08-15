import { describe, expect, it } from "vitest";
import type { InteractionHit } from "@/lib/drug-interactions";
import type { PgxHit } from "@/lib/pgx";
import type { OtotoxicHit } from "@/lib/ototoxic";
import type { DrugAllergyHit } from "@/lib/drug-allergy";
import {
  intakeWarningsForSurface,
  intakeWarningsForItem,
} from "@/lib/intake-warning-surface";

const items = [
  { id: 1, kind: "medication" as const },
  { id: 2, kind: "medication" as const },
  { id: 3, kind: "supplement" as const },
  { id: 4, kind: "supplement" as const },
];

function interaction(aId: number, bId: number): InteractionHit {
  return {
    aId,
    bId,
    aName: `Item ${aId}`,
    bName: `Item ${bId}`,
    severity: "moderate",
    mechanism: "Synthetic test interaction.",
    source: "Synthetic test source.",
    dedupeKey: `interaction:${aId}-${bId}`,
  };
}

const pgx: PgxHit = {
  variantId: 10,
  medId: 1,
  gene: "TEST1",
  phenotype: "poor",
  medName: "Item 1",
  severity: "moderate",
  guidance: "Synthetic test guidance.",
  source: "Synthetic test source.",
  dedupeKey: "pgx:1:test1:poor",
};

describe("intakeWarningsForSurface", () => {
  const hits = [interaction(1, 2), interaction(1, 3), interaction(3, 4)];

  it("keeps medication-only and cross-kind findings on Medications", () => {
    const result = intakeWarningsForSurface("medication", items, hits, [pgx]);

    expect(result.interactionWarnings.map((hit) => hit.dedupeKey)).toEqual([
      "interaction:1-2",
      "interaction:1-3",
    ]);
    expect(result.pgxWarnings).toEqual([pgx]);
  });

  it("keeps supplement-only and cross-kind findings on Supplements", () => {
    const result = intakeWarningsForSurface("supplement", items, hits, [pgx]);

    expect(result.interactionWarnings.map((hit) => hit.dedupeKey)).toEqual([
      "interaction:1-3",
      "interaction:3-4",
    ]);
    expect(result.pgxWarnings).toEqual([]);
  });

  it("drops findings whose referenced item is not present", () => {
    const result = intakeWarningsForSurface(
      "medication",
      items,
      [interaction(8, 9)],
      [{ ...pgx, medId: 9 }]
    );

    expect(result).toEqual({ interactionWarnings: [], pgxWarnings: [] });
  });
});

const ototoxic = {
  medId: 2,
  medName: "Item 2",
  entryKey: "test-class",
  category: "other",
  note: "Synthetic test note.",
  citation: "Synthetic test source.",
  dedupeKey: "ototoxic:2:test-class",
  baseline: null,
} as unknown as OtotoxicHit;

const allergy = {
  allergyId: 20,
  substance: "Test substance",
  reaction: null,
  medId: 1,
  medName: "Item 1",
  match: "ingredient",
  note: "Synthetic test note.",
  source: "Synthetic test source.",
  dedupeKey: "allergy:20:1",
} as unknown as DrugAllergyHit;

describe("intakeWarningsForItem (#2795)", () => {
  const all = {
    interactionWarnings: [interaction(1, 2), interaction(1, 3), interaction(3, 4)],
    pgxWarnings: [pgx],
    ototoxicWarnings: [ototoxic],
    allergyWarnings: [allergy],
  };

  it("keeps every finding the item is party to, of all four kinds", () => {
    const result = intakeWarningsForItem(1, all);

    expect(result.interactionWarnings.map((hit) => hit.dedupeKey)).toEqual([
      "interaction:1-2",
      "interaction:1-3",
    ]);
    expect(result.pgxWarnings).toEqual([pgx]);
    expect(result.allergyWarnings).toEqual([allergy]);
    // The ototoxic note names item 2, not item 1.
    expect(result.ototoxicWarnings).toEqual([]);
  });

  it("shows an interaction on BOTH partners' pages", () => {
    // The defect this fixes was a med being party to a flagged pair and its own page
    // saying nothing. Symmetry is the whole point: whichever partner you opened, the
    // pair is there.
    for (const id of [1, 2]) {
      expect(
        intakeWarningsForItem(id, all).interactionWarnings.map((h) => h.dedupeKey)
      ).toContain("interaction:1-2");
    }
  });

  it("keeps another item's findings off this item's page", () => {
    const result = intakeWarningsForItem(4, all);

    expect(result.interactionWarnings.map((hit) => hit.dedupeKey)).toEqual([
      "interaction:3-4",
    ]);
    expect(result.pgxWarnings).toEqual([]);
    expect(result.ototoxicWarnings).toEqual([]);
    expect(result.allergyWarnings).toEqual([]);
  });

  it("returns nothing for an item with no findings", () => {
    expect(intakeWarningsForItem(99, all)).toEqual({
      interactionWarnings: [],
      pgxWarnings: [],
      ototoxicWarnings: [],
      allergyWarnings: [],
    });
  });

  it("carries the SAME dedupeKeys the stack surfaces use, so a dismiss follows", () => {
    // Not a re-derivation: the keys are the gathered ones, which is what makes
    // dismissing on the detail page and dismissing on the list page the same act.
    expect(intakeWarningsForItem(1, all).pgxWarnings[0].dedupeKey).toBe(
      pgx.dedupeKey
    );
  });
});
