// Pure slot-aware food-group ranking (issue #950) — DB-free so it's unit-tested
// (lib/__tests__). Blends two recency-decayed signals into ONE order used by BOTH
// surfaces (the web one-tap bar and the Telegram nudge — #221):
//   • OVERALL frecency, from the food_log daily counter (servings × recency decay) —
//     exactly the pre-#950 ranking, so a profile with no ledger data (pre-migration
//     history, a fresh profile) degrades to the old order with NO cliff.
//   • SLOT frecency, from the food_log_events ledger, counting only the taps whose
//     derived window matches the current window (each tap × recency decay).
//
// Blend is LEXICOGRAPHIC: slot weight leads, overall weight backfills, catalog order
// breaks the final tie. So a group eaten in THIS slot leads (fish at lunch), and
// groups with no slot signal keep their overall order among themselves — a cold slot
// (all slot weights 0) sorts purely by overall, reproducing today's ranking. Ranking
// is presentation-only; every catalog group still appears exactly once (#559 — context
// gates order, never what CAN be logged).

import { decayedWeight } from "./decay";

export interface FoodOccurrence {
  name: string;
  date: string;
  // Overall occurrences weight by servings; slot occurrences are one tap each
  // (default 1).
  weight?: number;
}

// Rank `curated` (the full food-group catalog slug list) by the blend. `slot` is the
// subset of ledger taps whose derived window is the current one; pass an empty array
// (or omit) for the no-window case, which collapses to pure overall frecency —
// byte-identical to the pre-#950 rankByRecentFrequency order for the same rows.
export function blendFoodOrder(
  curated: string[],
  overall: FoodOccurrence[],
  slot: FoodOccurrence[],
  today: string,
  halfLifeDays?: number
): string[] {
  const overallW = decayWeights(overall, today, halfLifeDays);
  const slotW = decayWeights(slot, today, halfLifeDays);
  return curated
    .map((name, i) => ({
      name,
      i,
      s: slotW.get(name) ?? 0,
      o: overallW.get(name) ?? 0,
    }))
    .sort((a, b) => b.s - a.s || b.o - a.o || a.i - b.i)
    .map((x) => x.name);
}

function decayWeights(
  occ: FoodOccurrence[],
  today: string,
  halfLifeDays?: number
): Map<string, number> {
  const w = new Map<string, number>();
  for (const o of occ) {
    const add = (o.weight ?? 1) * decayedWeight(o.date, today, halfLifeDays);
    w.set(o.name, (w.get(o.name) ?? 0) + add);
  }
  return w;
}
