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
