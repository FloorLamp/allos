// Pure slot-aware food-group ranking (issue #950) — DB-free so it's unit-tested
// (lib/__tests__). Blends two recency-decayed signals into ONE order used by BOTH
// surfaces (the web one-tap bar and the Telegram nudge — #221):
//   • OVERALL frecency, from the food_log daily counter (servings × recency decay) —
//     exactly the pre-#950 ranking, so a profile with no ledger data (pre-migration
//     history, a fresh profile) degrades to the old order with NO cliff.
//   • SLOT frecency, from the food_log_events ledger, counting only the taps whose
//     derived window matches the current window (each tap × recency decay).
//
// Blend is LEXICOGRAPHIC: slot ABSENCE sinks (see below), then slot weight leads,
// overall weight backfills, catalog order breaks the final tie. So a group eaten in
// THIS slot leads (fish at lunch), groups with no slot signal keep their overall order
// among themselves, and a group whose own ledger says it is never eaten here sinks
// beneath them — a cold slot (all slot weights 0) sorts purely by overall, reproducing
// the pre-#950 ranking. Ranking is presentation-only; every catalog group still appears
// exactly once (#559 — context gates order, never what CAN be logged).

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
  // A COLD SLOT says nothing about anything (#2369). When no group carries any weight in
  // this window — a fresh profile, a pre-ledger one, or simply a person who has never
  // logged at this hour — there is no slot evidence to read either way, so the two-sided
  // axis stays switched off and the order collapses to pure overall frecency, byte-
  // identical to the pre-#950 ranking. Without this guard the absence rule would fire on
  // EVERY logged group at once and hand a cold window's head to the catalog tail.
  const slotIsCold = ![...slotW.values()].some((w) => w > 0);
  return curated
    .map((name, i) => {
      const s = slotW.get(name) ?? 0;
      const o = overallW.get(name) ?? 0;
      return { name, i, s, o, absent: !slotIsCold && slotAbsence(s, o) };
    })
    .sort(
      (a, b) =>
        Number(a.absent) - Number(b.absent) ||
        b.s - a.s ||
        b.o - a.o ||
        a.i - b.i
    )
    .map((x) => x.name);
}

// ---- The slot axis is TWO-SIDED (issue #2369) ----
//
// The slot signal used to be a positive boost ONLY, which made "no taps in this window"
// indistinguishable from "no history at all" — both contribute 0. Those are opposite
// facts. A group logged twenty times, in the evening and at midday, and not once in the
// morning, is the ledger SAYING something about mornings; a group never logged at all
// says nothing. Tying them let the heaviest never-eaten-here groups (alcohol, red meat)
// take the morning quick six on overall frecency alone — and since #2225 that six is
// also what the morning nudge sends.
//
// So the axis reads the group's slot SHARE — its slot weight against its OWN overall
// weight — and sinks a group with real history and essentially none of it here BELOW the
// groups with no history. It is still not a verdict about food (#1980/#992/#716): the
// only input is the profile's own ledger, and the demotion is ORDER, never availability
// (#559 — alcohol stays one tap away in the full catalog). A hard-coded "no drinks before
// noon" rule was rejected in #2369 for exactly the reason the rest of this file gives:
// the ranker does not editorialize, it reads evidence.

// How much decayed overall weight a group needs before its ABSENCE from a window counts
// as evidence. Food space has three windows (lib/food-slot.ts), so a group with no
// time-of-day preference lands in any one of them about a third of the time, and never
// landing in this one across n logged servings has probability ≈ (2/3)^n: 67% at n=1,
// 20% at n=4, 8.8% at n=6, 3.9% at n=8. Eight is the first count where "never here" is
// likelier a habit than a coincidence at the conventional 5% — which is exactly the gap
// #2369 names between "one lifetime log, in the evening" (no evidence of anything, and
// demoting it below a never-logged group would be over-reading one tap) and "logged on
// the order of twenty times, never in the morning" (evidence). The units are DECAYED
// servings, so this is the conservative reading of that count: eight decayed servings
// takes at least eight real ones, and more the older they are — a habit from ten months
// ago is weaker evidence about this morning, which is the direction we want to err in,
// since a wrong demotion is invisible to the person it happens to.
export const SLOT_ABSENCE_MIN_OVERALL = 8;

// What counts as a NEAR-ZERO share of that weight. The demotion is for groups whose slot
// signal is arithmetic dust, not for ones with a genuine minority presence here, so the
// bar sits between the two: proximity weighting (`slotProximityWeight`) gives a tap at
// the very edge of the span a sliver — a tap 3h55m from a 4h-span anchor contributes
// 0.02, i.e. a share of 0.003 against the floor above — while ONE ordinary tap inside the
// window (proximity ≥ 0.5, within two hours of the anchor) is worth 0.025 even against
// twenty logged servings. Two per cent separates them: a group whose entire slot signal
// is edge crumbs sinks, a group with one real tap here does not. It is also far below the
// ~1/3 share a group with no time-of-day preference would show, so the rule only ever
// fires on a clear absence.
export const SLOT_ABSENCE_MAX_SHARE = 0.02;

// Does this group's own ledger say it is not eaten in this window? Both sides must hold:
// enough overall weight for silence to mean anything, and a near-zero share of it here.
// Below the floor the answer is always false — no evidence is not negative evidence.
//
// Both boundaries are decided, not incidental: the floor engages AT its value (a group
// carrying exactly eight decayed servings is read), and the share does NOT (a share of
// exactly 2% counts as presence). Ties go to leaving the group where it was, because the
// demotion is the claim being made and the claim is the thing that has to be earned.
//
// Pure and total: the comparator that consumes this falls through to the catalog index,
// which is unique, so the same inputs always produce the same order — the bar and the
// nudge slice the same six from one call, and must not disagree run to run.
function slotAbsence(slotWeight: number, overallWeight: number): boolean {
  // The floor also guarantees a positive denominator, so a group with slot taps and no
  // overall weight at all (the reserved __protein__ entry, which rides the event ledger
  // only) can never be demoted and never divides by zero.
  if (overallWeight < SLOT_ABSENCE_MIN_OVERALL) return false;
  return slotWeight / overallWeight < SLOT_ABSENCE_MAX_SHARE;
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
//
// ---- …and neither does SELECTION (owner ruling, #2225) ----
//
// The same line, one level up. The web bar used to compose its quick set from a tier
// QUOTA (4 encourage / 1 neutral / 1 limit), which is the capped demotion expressed as
// selection instead of weight: a group's tier moved it into or out of the fast path, so
// a profile whose staples are all `encourage` saw a different six on the page than in
// the chat. That quota is deleted. BOTH surfaces now take the head of this one ranking.
// Tier may LABEL a group and SECTION the overflow; it may not decide which are fast.

// How many of the ranked keys are the FAST path — the web log bar's quick rows and the
// Telegram nudge's quick-log buttons, one number so the two agree BY CONSTRUCTION rather
// than by coincidence (#2225). It also sets the nudge's progressive-expansion page size
// in both directions (#1075/#1807), which is why an EVEN count matters there: the
// keyboard lays two buttons per row. Kept small so the keyboard and the phone-width bar
// stay scannable; the long tail is one disclosure ("More food groups" / "➕ Show more")
// away on both surfaces, never unreachable (#559).
//
// The two surfaces still budget the slots in their own medium, and that asymmetry is
// deliberate (#2225): the protein entry consumes one of the nudge's keyboard slots, while
// the page strips it out of `groups` (getFoodBarOrder) and renders it as its own stepper
// beside the six. Same count, same head of the same list, one control that is a button in
// a chat and a stepper on a page.
export const FOOD_QUICK_COUNT = 6;

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
// `minuteOfDay` is the EATING minute where one was captured (`occurred_at`) and the tap
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
