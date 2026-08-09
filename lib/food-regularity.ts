// FOOD REGULARITY (issue #2380) — how reliably a food group shows up in one meal
// window. Pure, DB-free, clock-free: every caller passes its own `today` and its own
// already-derived events, so the same ledger produces the same answer forever.
//
// ── THE QUESTION, AND THE ONE IT IS NOT ──────────────────────────────────────
//
// Ranking (lib/food-rank.ts) asks "what does this person eat, and when" over a
// year of recency-DECAYED frecency, and answers with an ORDER. Regularity asks a
// narrower question over a short UNDECAYED span — "which groups show up nearly
// every time this window is logged at all" — and answers with a SHARE. The two
// windows nest strictly (21 days inside `RECENT_WINDOW_DAYS`' 365) and the answers
// cannot contradict, because a rank is a comparison between groups and a share is a
// statement about one group against its own window.
//
// It is an OBSERVATION, never a target (#2380's own ruling). `frequency_targets` and
// the cadence ledger own "how often SHOULD this happen"; this module owns "how often
// DOES it". Nothing here creates a target, a streak, a verdict or a duty, and a
// deviation is not an event — eating something different for breakfast is not a
// thing the app has an opinion about.
//
// ── THE DENOMINATOR IS THE DECISION ──────────────────────────────────────────
//
// A group's share is over the days this window was LOGGED AT ALL, not over every day
// in the span. A day with no morning log is no evidence about what this person eats
// for breakfast — it is evidence about whether they logged breakfast, which is a
// different question and a different feature (#2376). Splitting the two here is what
// keeps this measure usable as that feature's gate without absorbing it: "usually
// fermented and berries" stays true for someone who skips a morning, and stays
// SILENT for someone who has no morning habit at all.
//
// ── THE GATE PRODUCES SILENCE, NOT A HEDGE ──────────────────────────────────
//
// Under `FOOD_REGULARITY_MIN_WINDOW_DAYS` observed days the window answers `null`.
// Not "0.5 confidence", not "not enough data yet" — nothing. A consumer that reads
// null must treat it as NO HABIT (there is no expectation), never as a habit broken.

import { shiftDateStr } from "./date";
import { FOOD_SLOTS, type FoodSlot } from "./food-slot";

// How far back the measure looks. Three whole WEEKS: a whole number of weeks so a
// weekday-shaped rhythm (the Saturday cook, the weekday commute breakfast) is counted
// the same number of times whichever day the span starts on, and short enough that
// "regular" means the life this person is living now rather than the one they were
// living in spring. Strictly inside the ranking's 365-day frecency window, so the two
// reads of the same ledger nest (the window-coherence convention, docs/internals/findings.md §4).
export const FOOD_REGULARITY_SPAN_DAYS = 21;

// THE GATE. Below this many days on which the window was logged at all, the window
// has no measure — `foodRegularity` answers `null` for it and every consumer stays
// silent. Seven: a full week of observations of that window, so a pattern has had the
// chance to repeat across every weekday at least once before the app is willing to
// call it one. Four days of breakfasts is a fortnight of noise.
export const FOOD_REGULARITY_MIN_WINDOW_DAYS = 7;

// The share of observed days a group must appear on to count as HABITUAL. 0.6 is
// "most days, with room to miss": at the gate's seven days it means five of seven,
// which survives a weekend away and does not survive a coin flip.
export const FOOD_REGULARITY_HABITUAL_SHARE = 0.6;

// The first day of the span, given the profile's today — the module's own knowledge,
// the way `recentWindowStart` is the ranking's. A gather asks for it rather than
// re-deriving the shift, so the SQL bound and the arithmetic below can never describe
// two different spans.
export function foodRegularityWindowStart(
  today: string,
  spanDays: number = FOOD_REGULARITY_SPAN_DAYS
): string {
  return shiftDateStr(today, -(spanDays - 1));
}

// One food event as the measure reads it: which group, which profile-local day, and
// which window it DERIVED to. The window is the caller's — `foodEventWindow`'s
// precedence (declared slot → eating instant → tap instant) — so a habit counts the
// same whether its window was declared, captured or derived from the tap.
export interface FoodRegularityEvent {
  groupKey: string;
  date: string;
  window: FoodSlot;
}

// One group's regularity inside one window.
export interface FoodGroupRegularity {
  groupKey: string;
  // Distinct days in the span this group appeared in this window.
  days: number;
  // `days` over the window's observed days, in [0, 1].
  share: number;
}

// One window's measure. Only ever built when the gate passed, so `observedDays` is
// always at least `FOOD_REGULARITY_MIN_WINDOW_DAYS` and a consumer never has to
// re-check it.
export interface FoodWindowRegularity {
  window: FoodSlot;
  // Days in the span on which ANYTHING was logged in this window — the denominator.
  observedDays: number;
  // Every group seen in this window, share-descending (then days, then key, so the
  // order is total and reproducible). Includes groups well below the habitual share:
  // the MEASURE is complete, and `habitualFoodGroups` is where the threshold and the
  // exclusions apply.
  groups: FoodGroupRegularity[];
}

export type FoodRegularity = Record<FoodSlot, FoodWindowRegularity | null>;

// The measure for all three windows. `null` for a window under the gate — silence,
// which reads as "no expectation" and never as "habit broken".
export function foodRegularity(
  events: readonly FoodRegularityEvent[],
  opts: { today: string; spanDays?: number }
): FoodRegularity {
  // Inclusive of today: a partly-lived day distorts nothing, because a window with
  // nothing logged in it yet contributes to neither numerator nor denominator.
  const from = foodRegularityWindowStart(opts.today, opts.spanDays);
  const out = {} as FoodRegularity;
  for (const window of FOOD_SLOTS) out[window] = null;

  const observed = new Map<FoodSlot, Set<string>>();
  const byGroup = new Map<FoodSlot, Map<string, Set<string>>>();
  for (const window of FOOD_SLOTS) {
    observed.set(window, new Set());
    byGroup.set(window, new Map());
  }
  for (const event of events) {
    if (event.date < from || event.date > opts.today) continue;
    observed.get(event.window)!.add(event.date);
    const groups = byGroup.get(event.window)!;
    const days = groups.get(event.groupKey) ?? new Set<string>();
    days.add(event.date);
    groups.set(event.groupKey, days);
  }

  for (const window of FOOD_SLOTS) {
    const observedDays = observed.get(window)!.size;
    if (observedDays < FOOD_REGULARITY_MIN_WINDOW_DAYS) continue;
    const groups: FoodGroupRegularity[] = [...byGroup.get(window)!]
      .map(([groupKey, days]) => ({
        groupKey,
        days: days.size,
        share: days.size / observedDays,
      }))
      .sort(
        (a, b) =>
          b.share - a.share || b.days - a.days || a.groupKey.localeCompare(b.groupKey)
      );
    out[window] = { window, observedDays, groups };
  }
  return out;
}

// The groups a window's measure says are HABITUAL — the presentable half.
//
// `excluded` is the CAP-DIRECTION exclusion (#2380's ruling, and #998's language one
// level up). A group whose counter is a substance ledger, or which carries an active
// cap-direction target, may be measured but must never be reflected back as an
// expectation: "you usually have alcohol in the evening" is a sentence this app does
// not say, because saying it normalises the thing the cap exists to reduce. The
// exclusion is passed IN rather than decided here, because which groups are capped is
// a fact about the profile's targets and its substance catalog, not about arithmetic.
//
// Note what is NOT excluded: the catalog's `limit` TIER. #1980 ruled that tier may
// label a group and section an overflow but may never move it into or out of a fast
// path — a group you log often is a group you need to log fast, and demoting it only
// makes the app worse at capturing exactly the intake that matters. Alcohol is
// excluded because its ledger has cap SEMANTICS, not because it is disapproved of.
export function habitualFoodGroups(
  window: FoodWindowRegularity | null,
  opts: { excluded?: ReadonlySet<string> } = {}
): FoodGroupRegularity[] {
  if (!window) return [];
  const excluded = opts.excluded;
  return window.groups.filter(
    (g) =>
      g.share >= FOOD_REGULARITY_HABITUAL_SHARE && !excluded?.has(g.groupKey)
  );
}

// ---------------------------------------------------------------------------
// The one thing regularity is FOR: a faster path to the thing you log every day
// ---------------------------------------------------------------------------

// How many groups an offer must still be able to log for it to be worth offering.
// TWO, and the reason is arithmetic rather than taste: the ranked bar already logs a
// single group in one tap, so a one-group "usual" offer saves nothing and only adds a
// second thing to read. The offer exists exactly where the ledger says two or more
// taps are about to happen together — the #2380 observation is a pair logged 1.4
// seconds apart — and it collapses to silence the moment it stops being faster than
// the bar underneath it.
export const FOOD_USUAL_MIN_GROUPS = 2;

// WHAT A "LOG MY USUAL" TAP WOULD WRITE, from the habitual set and what is already in
// that window on that day. Empty means NO OFFER — either the window has no habit, or
// enough of it is already logged that the bar is the faster path again.
//
// This is the whole state-rendering contract of the affordance in one pure function
// (docs/internals/stateful-affordances.md): the button's label is this list, and the
// write core calls the SAME function against fresh server state and writes only its
// intersection with what the button named. The label therefore cannot promise a write
// the core would not perform, and the core cannot perform one the label did not name.
export function usualFoodOffer(
  // The habitual group KEYS for one window, share-descending — `habitualFoodGroups`
  // already applied the threshold and the cap-direction exclusion. Keys rather than
  // rows because both callers (the server's offer and the rendered button) have keys
  // and neither has any use for the share.
  habitual: readonly string[],
  loggedInWindow: ReadonlySet<string>
): string[] {
  const remaining = habitual.filter(
    (groupKey) => !loggedInWindow.has(groupKey)
  );
  return remaining.length >= FOOD_USUAL_MIN_GROUPS ? remaining : [];
}
