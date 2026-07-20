import { describe, expect, it } from "vitest";
import type { InteractionHit } from "@/lib/drug-interactions";
import type { PgxHit } from "@/lib/pgx";
import { intakeWarningsForSurface } from "@/lib/intake-warning-surface";

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
