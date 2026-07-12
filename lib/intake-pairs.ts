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

// The findings-bus namespace for the "keep apart" bucket warnings (issue #435), so
// the /medicine dismiss action guards the whole domain with one prefix check.
export const KEEP_APART_PREFIX = "keep-apart:";

// The stable suppression/identity key for a keep-apart warning:
// `keep-apart:<loId>-<hiId>` over the two item ids (already stored a_id < b_id).
// Id-keyed (ids never recycle, #203), so a rename never re-attaches a stale dismissal
// to a different pair, and deleting the pair drops the row it keyed on.
export function keepApartSignalKey(aId: number, bId: number): string {
  const [lo, hi] = aId <= bId ? [aId, bId] : [bId, aId];
  return `${KEEP_APART_PREFIX}${lo}-${hi}`;
}

// One "keep apart" bucket warning, carrying its dedupeKey so the page can route it
// through the shared findings-suppression bus (#435) — dismissible like every other
// finding — alongside the preformatted line.
export interface KeepApartWarning {
  key: string;
  text: string;
}

// "Keep apart" bucket warnings (issue #313, extracted from the medicine page).
// A `separate`-relation pair is a clinical rule that both supplements should NOT
// be taken at the same time; this raises the warning when BOTH members have a
// due dose in the same time bucket (`itemIdsInBucket`). Pure over the pair table
// + the ids present in the bucket, so a dose-reminder push can raise the identical
// warning. Returns one keyed warning per offending pair, in the pairs' order (#435).
export function separatePairWarnings(
  itemIdsInBucket: Iterable<number>,
  pairs: SupplementPair[]
): KeepApartWarning[] {
  const ids = new Set(itemIdsInBucket);
  return pairs
    .filter(
      (p) => p.relation === "separate" && ids.has(p.a_id) && ids.has(p.b_id)
    )
    .map((p) => ({
      key: keepApartSignalKey(p.a_id, p.b_id),
      text: `Keep apart: ${p.a_name} and ${p.b_name}${p.note ? ` — ${p.note}` : ""}`,
    }));
}
