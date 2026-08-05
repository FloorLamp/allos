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

// ---- Ranking does not editorialize (owner ruling, #1980 reversing #1822 item 5) ----
//
// Rank is FRECENCY plus the user's own exclusions, and nothing else. The catalog's
// `limit` tier ("less of this") deliberately carries NO ranking weight: a group you log
// often is a group you need to log FAST, so pushing alcohol below every uncapped group
// made the app slower at capturing exactly the intake a cap exists to measure. Position
// is a speed affordance, not a verdict — the non-judgmental posture of #992/#716 applied
// to sort order. The `limit` tier keeps its meaning everywhere else (targets, the
// inverted-cap reads, the bar's tier headings); it just never moves a button.
//
// Do not re-add a capped demotion here. It shipped once (#1822 item 5, Telegram only),
// diverged the two surfaces for two releases, and was reversed on purpose.

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

// ---- Where the protein control sits among RENDERED rows (#1980, fixed in #2061) ----

// The bar renders the reserved protein entry as its own control, at the position the one
// ranking gave it: `proteinRank` groups sit ahead of it. Turning that rank into a slice
// point is only trivial while the rendered rows ARE the ranked order — and the quick set
// is not. A deep link (a protocol's "Log servings") pins its own group to the FRONT of
// the quick rows whatever that group's rank is, so the rendered order can start with a
// low-ranked row.
//
// The old count — "how many quick rows outrank protein" — assumed the rendered order was
// still monotone in rank, and a pinned group broke it: the split landed past the pin,
// which pushed a HIGHER-ranked row below the control while the pinned lower-ranked one
// stayed above it. Scanning the rendered order for the first row protein outranks gives
// the same answer whenever the order is monotone (every earlier row outranks protein by
// construction) and the RIGHT one when it isn't.
//
// `ranks` are the true ranks of the rows in the order they are rendered; a null
// `proteinRank` means the profile does not track protein yet and the entry was never
// ranked, so the control renders after every row rather than vanishing (#559 — a cold
// start must not be a dead end).
export function proteinSplitIndex(
  ranks: readonly number[],
  proteinRank: number | null
): number {
  if (proteinRank == null) return ranks.length;
  const first = ranks.findIndex((rank) => rank >= proteinRank);
  return first === -1 ? ranks.length : first;
}
