// The CADENCE LEDGER's declared axes (#2034) — pure, no DB, client-safe.
//
// `frequency_targets` is ONE physical table with ONE identity (`target.id`) that four
// separately-maintained read models used to answer the same question about: "how did
// this target do in week W?". The current-week rollup, the completed-week history, the
// substance week state and the substance weekly trend each inlined their own six-branch
// scope dispatch, their own weekly-cell shape and their own verdict vocabulary, so a
// new scope kind meant editing three dispatchers and hoping four answers still agreed.
//
// This module holds the three axes that dispatch USED to encode as branches:
//
//   1. SOURCE + GRAIN — which event ledger a scope counts, and whether a week's number
//      is distinct days or a sum. Declared once per scope kind, total over
//      `FREQUENCY_SCOPE_KINDS` by the type.
//   2. DIRECTION — `floor` (a target to reach) vs `cap` (a limit to stay under). The
//      same move `trailingAverage` made for #1909 with `basis`.
//   3. The in-progress week's inclusion, which is a reader option, not a scope fact.
//
// ---------------------------------------------------------------------------
// Why direction is a PARAMETER and not a separate module (owner ruling, 2026-08-05)
// ---------------------------------------------------------------------------
//
// Substance reduction targets (#998/#1259) were excluded from every floor-semantics
// reader for a real safety reason: a floor reader renders "2 of 7 — 5 to go" on
// alcohol, i.e. it nudges toward MORE consumption. That argument is correct and it
// survives here — but it argues for direction being DECLARED, not for a fourth module.
//
// So the anti-nudge rule moved from module separation into the verdict vocabulary: a
// `cap` target's verdict set has no "N to go" state at all, its under-cap weeks ARE its
// success state (#1670), and `cadenceToGo` is structurally null for the cap direction.
// `lib/__tests__/cadence.test.ts` pins that no cap verdict or label can carry
// pace-toward-more language. Types enforce what keeping the code apart used to.

import { FREQUENCY_SCOPE_KINDS, type FrequencyScopeKind } from "./goals";
import { frequencyRangeState } from "./practice";
import { substanceCapStatus } from "./substance-use";

// ---------------------------------------------------------------------------
// The axes
// ---------------------------------------------------------------------------

// Which way a weekly number is read. `floor` is a target to REACH (every training,
// nutrition, mobility and practice scope); `cap` is a limit to STAY UNDER (substance
// reduction). Nothing else about a scope changes between the two.
export type CadenceDirection = "floor" | "cap";

// What a week's number IS. Distinct days answers "on how many days did this happen"
// (a second same-day session never double-counts, #223); sum answers "how much".
export type CadenceGrain = "distinct-days" | "sum";

// Which event ledger a scope counts. Not one per scope kind: `region` and `group` share
// the exercise-set ledger, and `type` and `mobility_region` both read activities.
export type CadenceSource =
  | "exercise-sets"
  | "activity-type"
  | "mobility-moves"
  | "food-servings"
  | "practice-logs"
  | "substance-ledger";

export interface CadenceScopeSpec {
  source: CadenceSource;
  grain: CadenceGrain;
  direction: CadenceDirection;
  /** Why this scope counts the way it does — the decision, not a restatement. */
  note: string;
}

// Every frequency-target scope kind's counting rule, in ONE place. `Record<
// FrequencyScopeKind, …>` makes it total by construction: an eighth scope kind is a
// compile error here rather than a silent fall-through in three dispatchers.
export const CADENCE_SCOPES: Record<FrequencyScopeKind, CadenceScopeSpec> = {
  region: {
    source: "exercise-sets",
    grain: "distinct-days",
    direction: "floor",
    note: "distinct TRAINING days whose logged sets map to the region (#482: trained, not mobilized)",
  },
  group: {
    source: "exercise-sets",
    grain: "distinct-days",
    direction: "floor",
    note: "the union of its regions' training days — a day counts once for the group however many of its regions it hit",
  },
  type: {
    source: "activity-type",
    grain: "distinct-days",
    direction: "floor",
    note: "distinct days an activity of that type was logged, multi-part components included",
  },
  food_group: {
    source: "food-servings",
    grain: "sum",
    direction: "floor",
    note: "the week's SERVINGS for the group (#579's rollup) — servings, not days, because two portions in a day are two servings",
  },
  mobility_region: {
    source: "mobility-moves",
    grain: "distinct-days",
    direction: "floor",
    note: "distinct days a recovery session's moves MOBILIZED the region (#840) — a separate view from the strength `region` scope",
  },
  practice: {
    source: "practice-logs",
    grain: "distinct-days",
    direction: "floor",
    note: "distinct days a session was logged into practice_logs, day-distinct so a second same-day session never double-counts",
  },
  substance: {
    source: "substance-ledger",
    grain: "sum",
    direction: "cap",
    note: "the week's units (standard drinks / uses) from the substance's own ledger, read as a CAP (#998) — under it is the success state",
  },
};

// The direction a scope kind is read in, or null for a kind that is not a registered
// cadence scope. Named rather than subtracted: every reader that used to filter
// `scope_kind !== "substance"` now selects a DIRECTION, so a new inverted scope joins
// the right readers by declaring itself instead of by being remembered.
export function cadenceDirection(kind: string): CadenceDirection | null {
  return CADENCE_SCOPES[kind as FrequencyScopeKind]?.direction ?? null;
}

export function isCadenceScopeKind(kind: string): kind is FrequencyScopeKind {
  return (FREQUENCY_SCOPE_KINDS as readonly string[]).includes(kind);
}

// ---------------------------------------------------------------------------
// The verdict vocabulary
// ---------------------------------------------------------------------------

// A FLOOR week's verdict. Exactly the states the range model already had (#1259):
// `at-ceiling` implies `met` (a valid cadence has ceiling > floor), so a met count
// includes both.
export const FLOOR_VERDICTS = ["at-ceiling", "met", "under"] as const;
export type FloorVerdict = (typeof FLOOR_VERDICTS)[number];

// A CAP week's verdict. Deliberately NOT the mirror image of the floor set: there is no
// "on-pace" and no "to go", because a cap has no pace to keep up with and nothing to go
// toward. `under-cap` is the SUCCESS state (#1670), not an incomplete one.
export const CAP_VERDICTS = ["under-cap", "at-cap", "over-cap"] as const;
export type CapVerdict = (typeof CAP_VERDICTS)[number];

export type CadenceVerdict = FloorVerdict | CapVerdict;

export function verdictDirection(verdict: CadenceVerdict): CadenceDirection {
  return (CAP_VERDICTS as readonly string[]).includes(verdict)
    ? "cap"
    : "floor";
}

export interface CadenceVerdictInput {
  direction: CadenceDirection;
  count: number;
  /** The floor to reach, or the cap to stay under. */
  target: number;
  /** The optional weekly maximum of a RANGE target. Ignored for a cap. */
  ceiling?: number | null;
  /** Days of the week window elapsed through its end (1..7). 7 for a completed week. */
  elapsedDays?: number;
}

// One week's verdict, for either direction. The two branches delegate to the
// computations their surfaces already render — `frequencyRangeState` (the /wellness
// card, the Goals-and-habits widget, Upcoming, the Telegram nudge) and
// `substanceCapStatus` (the substance page, the coaching finding) — so consolidating
// the READ model changed no verdict anywhere.
export function cadenceVerdict(input: CadenceVerdictInput): CadenceVerdict {
  const { direction, count, target } = input;
  if (direction === "cap") {
    const status = substanceCapStatus(count, target);
    if (status.over) return "over-cap";
    return status.atCap ? "at-cap" : "under-cap";
  }
  const state = frequencyRangeState(
    count,
    target,
    input.ceiling ?? null,
    input.elapsedDays ?? 7
  );
  if (state.atCeiling) return "at-ceiling";
  return state.met ? "met" : "under";
}

// Whether a week's verdict is a good one. For a floor that means the floor was cleared
// (at-ceiling counts — it is the range model's most complete state); for a cap it means
// the limit held. The one predicate consistency rates roll up.
export function cadenceWeekMet(verdict: CadenceVerdict): boolean {
  return verdict !== "under" && verdict !== "over-cap";
}

// Short, neutral labels. The cap labels are STATEMENTS OF FACT with no remaining-count
// and no comparative: a cap surface must never imply there is room to fill.
export const CADENCE_VERDICT_LABEL: Record<CadenceVerdict, string> = {
  "at-ceiling": "At weekly maximum",
  met: "Floor met",
  under: "Under floor",
  "under-cap": "Under the cap",
  "at-cap": "At the cap",
  "over-cap": "Over the cap",
};

// How many more a FLOOR week still owes — and structurally `null` for a cap, which is
// the #998 anti-nudge rule expressed as a type rather than as a module boundary. A cap
// surface cannot ask this question and get a number back, so no formatter can grow a
// "5 to go" line on alcohol by accident.
export function cadenceToGo(
  direction: CadenceDirection,
  count: number,
  target: number
): number | null {
  if (direction === "cap") return null;
  return Math.max(0, target - count);
}
