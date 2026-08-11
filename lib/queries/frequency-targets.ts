import type { FrequencyPace } from "../frequency-targets";
import { frequencyRangeState } from "../practice";
import type { FrequencyTarget } from "../types";
import { getCadenceLedger } from "./cadence-ledger";

// The active-target list moved to the ledger (#2034) — it IS the ledger's tenant
// roll — and is re-exported here so every existing `@/lib/queries` import site is
// unaffected.
export { getFrequencyTargets } from "./cadence-ledger";

// Weekly frequency targets — the scope-kind-GENERIC `frequency_targets` read
// machinery. It lived under the training query namespace until #1637, which was
// misleading in both directions: training goals are only ONE of five consumers
// (training goals, nutrition food groups, substance use, protocols, and wellness
// practices), and non-training work kept importing domain-neutral machinery from
// `training/`. Genuinely training-specific goal reads stayed behind in
// the training outcome-goal module. Pure relocation: no SQL, semantics, or scoping
// changed.
//
// Every read here is profile-scoped, and the module is reached through the
// lib/queries.ts barrel, so existing `@/lib/queries` import sites are unaffected.
// It imports nothing from `training/`: the shared weekly window it needs moved to
// lib/queries/profile-week.ts, which is where its other non-training consumers
// (nutrition, substance use) now read it from too.

export interface FrequencyTargetProgress {
  target: FrequencyTarget;
  count: number;
  per_week: number;
  // The optional weekly ceiling (#1259): a range target ("3–5×/week") is DONE for the
  // week once count reaches it — a calm "that's plenty", never a red state. NULL for a
  // single-floor target. Copied through so every surface reads the SAME range.
  per_week_max: number | null;
  met: boolean;
  // At/above the ceiling (per_week_max != null && count >= per_week_max). Silences the
  // nudge and flips the surfaces to the calm plenty state (#1259).
  atCeiling: boolean;
  // Paced status (#748 item 3): "met" once complete, "on-pace" while keeping up with the
  // share of the week elapsed, else "behind". Computed once here so every surface agrees.
  pace: FrequencyPace;
  // On-days remaining in the profile's week window AFTER today (0..6) — the same window
  // `pace` is computed against, carried so a surface can ask "is this still reachable
  // without training today?" without re-deriving the window (#221). Rolling mode's
  // window is always the trailing 7 days, so this is 0 there: every day is the last day.
  daysLeftInWindow: number;
}

// This week's progress for every FLOOR target — the current window of the cadence
// ledger (#2034), formatted into the shape every weekly surface already reads.
//
// Substance reduction targets (#998) are absent because they are `cap`-direction
// tenants of the same ledger, not because this reader subtracts them: their per_week
// is a weekly CEILING, so a floor-semantics reader (this rollup, the digest's
// goals-due list, the Upcoming unmet-target generator, the presence recap) would
// render "2 of 7 — 5 to go" and nudge toward MORE consumption. `direction: "floor"`
// is that exclusion stated positively; lib/queries/substance.ts reads the cap side of
// the same ledger.
export function getFrequencyTargetProgress(
  profileId: number
): FrequencyTargetProgress[] {
  return getCadenceLedger(profileId, {
    weeks: 1,
    includeCurrent: true,
    direction: "floor",
  }).map(({ target, weeks }) => {
    const week = weeks[0];
    // Range semantics (#1259): the FLOOR (per_week) drives met + pace; the optional
    // ceiling (per_week_max) flips atCeiling once reached — a calm "that's plenty",
    // never a red state. One computation (frequencyRangeState) shared by every surface.
    const range = frequencyRangeState(
      week.count,
      target.per_week,
      target.per_week_max,
      week.elapsedDays
    );
    return {
      target,
      count: week.count,
      per_week: target.per_week,
      per_week_max: target.per_week_max,
      met: range.met,
      atCeiling: range.atCeiling,
      pace: range.pace,
      daysLeftInWindow: Math.max(0, 7 - week.elapsedDays),
    };
  });
}

// ---- Completed-week history (#1670) ---------------------------------------

// One completed target week for a target: the window's inclusive start date and the
// count that week produced under the SAME per-scope counting rules
// getFrequencyTargetProgress applies to the current week.
export interface FrequencyTargetWeek {
  start: string;
  count: number;
}

// A target's trailing history: its COMPLETED weeks (oldest first — the current,
// in-progress week is deliberately absent, see below) plus whether the target itself
// existed for the whole of that window.
export interface FrequencyTargetHistory {
  target: FrequencyTarget;
  weeks: FrequencyTargetWeek[];
  existedWholeWindow: boolean;
}

// Per-target weekly counts over the `weeks` COMPLETED target weeks before the current
// one — the revealed-preference ledger the #1670 right-sizing detector reads. The same
// cadence ledger as the current-week rollup with the in-progress window dropped, which
// is why a suggestion can never disagree with the card beside it.
//
// Three properties are load-bearing, all of them now properties of the ledger itself:
//
//   • The weeks are the profile's OWN weekly windows, so calendar mode (resetting on
//     the configured week-start day) and rolling mode (trailing 7-day blocks) both get
//     the answer their surfaces already show.
//   • The CURRENT week is excluded (`includeCurrent: false`). It is under its floor by
//     construction on every day but the last, so including it would make almost every
//     target look chronic.
//   • Counting is the same per-scope rule as the current-week rollup, because it is
//     the same registry. Substance CAPS are absent for the same reason as there: a cap
//     is not a floor, and "chronically under it" is that scope's success state.
//
// `asOf` moves the anchor (#1632). It defaults to today — the detector's whole point
// is the weeks leading up to now — but a WINDOWED analytics surface may end its range
// in the past, and the honest ledger for such a window is the completed weeks before
// ITS end. The week containing `asOf` is excluded exactly as the current week is.
export function getFrequencyTargetWeeklyHistory(
  profileId: number,
  weeks: number,
  asOf?: string
): FrequencyTargetHistory[] {
  if (weeks < 1) return [];
  return getCadenceLedger(profileId, {
    weeks,
    includeCurrent: false,
    direction: "floor",
    asOf,
  }).map((entry) => ({
    target: entry.target,
    weeks: entry.weeks.map((w) => ({ start: w.start, count: w.count })),
    existedWholeWindow: entry.existedWholeWindow,
  }));
}
