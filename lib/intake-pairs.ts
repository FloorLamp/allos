import type { SupplementPair } from "./types";

// Canonical ordering for an intake-item "take together / keep apart" pair
// (intake_item_pairs). The relation is direction-independent, so a pair is stored
// with a_id < b_id — the schema enforces it with CHECK (a_id < b_id) and dedups
// both directions with UNIQUE(a_id, b_id, relation) (migration 011, issue #97).
// Every write path normalizes through this ONE helper before insert so the reversed
// duplicate can never be created and the CHECK is never tripped.
//
// Pure (no DB/network) so it lives in lib/ and is unit-tested; the callers
// (app/(app)/medicine/actions.reconcilePairs, scripts/seed) are formatters over it.
export function orderIntakePair(x: number, y: number): [number, number] {
  return x < y ? [x, y] : [y, x];
}

// "Keep apart" bucket warnings (issue #313, extracted from the medicine page).
// A `separate`-relation pair is a clinical rule that both supplements should NOT
// be taken at the same time; this raises the warning when BOTH members have a
// due dose in the same time bucket (`itemIdsInBucket`). Pure over the pair table
// + the ids present in the bucket, so a dose-reminder push can raise the identical
// warning. Returns one preformatted line per offending pair, in the pairs' order.
export function separatePairWarnings(
  itemIdsInBucket: Iterable<number>,
  pairs: SupplementPair[]
): string[] {
  const ids = new Set(itemIdsInBucket);
  return pairs
    .filter(
      (p) => p.relation === "separate" && ids.has(p.a_id) && ids.has(p.b_id)
    )
    .map(
      (p) =>
        `Keep apart: ${p.a_name} and ${p.b_name}${p.note ? ` — ${p.note}` : ""}`
    );
}
