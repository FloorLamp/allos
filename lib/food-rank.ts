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
import { foodGroupBySlug } from "./food-groups";
import { clockDistanceMin } from "./food-slot";

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

// ---- Capped groups sort below floor groups (issue #1822 item 5) ----

// Whether a key names a CAPPED food group — the catalog's `limit` tier, the groups the
// app's advice is "less of this" about (alcohol, added sugar, fried food, …). A
// non-catalog key (the reserved `__protein__` pseudo-group) is never capped, and neither
// is a retired/unknown slug: the refusal degrades to "not capped", so an unrecognized key
// keeps its earned rank rather than being silently demoted.
export function isCappedFoodGroup(key: string): boolean {
  return foodGroupBySlug(key)?.tier === "limit";
}

// Push capped groups below EVERY uncapped one, regardless of usage. A stable partition,
// exactly like `demoteExcludedGroups`: both sides keep their (slot-frecency, #950) order
// among themselves, so this composes with the blend instead of replacing it.
//
// WHY RANKING NEEDED CONTEXT HERE. The nudge's ranking was usage-only, so a heavily
// logged capped group ("🍷 Alcohol") could take an above-the-fold quick-log button in a
// positive-habits nudge — an encouragement-shaped affordance for the very thing being
// capped, sitting ahead of the floor groups the nudge exists to prompt. The button must
// NOT vanish (logging alcohol is exactly the tracking a cap needs, and #559 says context
// gates ORDER, never what can be logged), so it is demoted, not filtered — still one
// "➕ Show more" away, in every slot rather than only the morning one.
export function demoteCappedGroups(rankedKeys: readonly string[]): string[] {
  const kept: string[] = [];
  const capped: string[] = [];
  for (const key of rankedKeys) {
    if (isCappedFoodGroup(key)) capped.push(key);
    else kept.push(key);
  }
  return [...kept, ...capped];
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

// ---- Slot signal by PROXIMITY, not by bucket (issue #2019) ----

// How far from a window's anchor a tap can be and still say anything about that window.
// Four hours: wide enough that a 15:30 lunch still counts for the midday nudge, narrow
// enough that breakfast says nothing about dinner.
export const SLOT_PROXIMITY_SPAN_MIN = 240;

// A tap's contribution to one window, from how close it was to that window's anchor.
// Linear to zero at the span edge, so the signal degrades smoothly instead of falling
// off a cliff.
//
// THE CLIFF THIS REPLACES. Bucket equality gave a 14:59 tap full credit for Midday and a
// 15:01 tap none at all — two taps two minutes apart landing in different worlds, on a
// boundary the user never chose (it was derived from their SUPPLEMENT reminder hours).
// Proximity keeps the same intent — "what does this profile eat at this time of day" —
// with no boundary anywhere in it, which is also why the event no longer has to claim a
// meal to participate.
export function slotProximityWeight(
  minuteOfDay: number,
  anchorMinute: number,
  span: number = SLOT_PROXIMITY_SPAN_MIN
): number {
  const d = clockDistanceMin(minuteOfDay, anchorMinute);
  return d >= span ? 0 : 1 - d / span;
}

// The slot occurrences for one window: every tap, weighted by how near it fell to that
// window's anchor. Zero-weight taps are dropped so the blend's decay never has to carry
// rows that contribute nothing.
//
// `minuteOfDay` is the EATING minute where one was captured (`eaten_at`) and the tap
// minute otherwise, which is the whole point of #2019 — a dinner tapped at 23:40 and
// corrected to 19:00 now ranks as a dinner instead of teaching the morning nudge.
export function slotProximityOccurrences(
  events: readonly { name: string; date: string; minuteOfDay: number }[],
  anchorMinute: number,
  span: number = SLOT_PROXIMITY_SPAN_MIN
): FoodOccurrence[] {
  const out: FoodOccurrence[] = [];
  for (const e of events) {
    const weight = slotProximityWeight(e.minuteOfDay, anchorMinute, span);
    if (weight > 0) out.push({ name: e.name, date: e.date, weight });
  }
  return out;
}
