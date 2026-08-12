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

import {
  FREQUENCY_SCOPE_KINDS,
  WEEKLY_PACE_MAX_NAMED,
  frequencyScopeLabel,
  type FrequencyScopeKind,
} from "./frequency-targets";
import { regionsForGroup, type BodyGroup } from "./lifts";
import { frequencyRangeState } from "./practice";
import { isSubstance, substanceCapStatus, substanceDef } from "./substance-use";

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

// ---------------------------------------------------------------------------
// What ONE session advances
// ---------------------------------------------------------------------------

// The ledger answers "how many this week"; this answers "did THIS session put one of
// them on the board" — the same membership rule as `cadenceCounts`, asked of a single
// activity instead of a window. It exists because a surface that congratulates a
// session must not read the week's rollup as if the session had produced it: the
// post-workout recap did exactly that, and a 1.4 km walk reported a Chest target a
// barbell session had advanced earlier in the week (#2503).
//
// The facts are the two the workout gathers actually key on — the activity's own type
// plus its components' types (`activity-type`), and the regions its logged sets map to
// (`exercise-sets`). Nothing about the WEEK is in here.
export interface SessionCadenceFacts {
  /** The activity's `type`, plus every component type it logged. */
  readonly types: readonly string[];
  /** The `MuscleRegion`s this session's logged sets map to. */
  readonly regions: readonly string[];
}

type SessionAdvanceRule = (
  value: string,
  facts: SessionCadenceFacts
) => boolean;

// Per scope kind: how a single session advances it, or NULL for a scope no activity
// row can advance from these facts. Null is a declaration, not a "no" — it says the
// question is unanswerable here, which is why `sessionAdvancesScope` and the recap's
// scope filter both read it rather than each keeping their own list of kinds. Total
// over `FrequencyScopeKind`, so an eighth scope must answer before it compiles.
export const SESSION_ADVANCE_RULES: Record<
  FrequencyScopeKind,
  SessionAdvanceRule | null
> = {
  region: (value, facts) => facts.regions.includes(value),
  // A day counts once for the group however many of its regions it hit — the same
  // union `cadenceCounts` takes, one session wide.
  group: (value, facts) =>
    regionsForGroup(value as BodyGroup).some((r) => facts.regions.includes(r)),
  type: (value, facts) => facts.types.includes(value),
  // The mobility ledger reads a recovery session's MOVES (#840), which these facts do
  // not carry: a `null` says so rather than answering a confident `false` that a future
  // recovery-recap author would inherit as a silent wrong answer.
  mobility_region: null,
  // Nutrition and practice scopes count their own ledgers; no activity row advances
  // one, which is the #1122 exclusion stated as a rule instead of a remembered list.
  food_group: null,
  practice: null,
  // A CAP is never "advanced" (#998). Asking would be asking for a to-go number on
  // alcohol, which is the one answer this vocabulary refuses to have.
  substance: null,
};

// Whether one session put a mark on this scope's board. False for a scope whose rule
// is null — an unanswerable question is not a yes.
export function sessionAdvancesScope(
  scope: { kind: string; value: string },
  facts: SessionCadenceFacts
): boolean {
  const rule = SESSION_ADVANCE_RULES[scope.kind as FrequencyScopeKind] ?? null;
  return rule ? rule(scope.value, facts) : false;
}

// The scope kinds a training session can advance at all — derived from the rules above
// rather than hand-listed, so the recap's #1122 narrowing and the advance rule cannot
// drift apart.
export const SESSION_ADVANCEABLE_SCOPE_KINDS: readonly FrequencyScopeKind[] =
  FREQUENCY_SCOPE_KINDS.filter((k) => SESSION_ADVANCE_RULES[k] != null);

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

// ---------------------------------------------------------------------------
// Reporting a CLOSED week's verdicts (#2395)
// ---------------------------------------------------------------------------
//
// The daily digest reports weekly-target PACE ("2 of 4 training targets on pace —
// behind on Back", lib/frequency-targets.ts `weeklyTargetPaceLine`); the message that
// CLOSES the week reported raw activity counts and never mentioned the targets the
// week is defined over. This is that line's twin: the same rollup grammar, but over a
// week's VERDICT rather than its pace, so the two system-initiated messages share one
// vocabulary instead of inventing a second one.
//
// It reads verdicts, it does not compute them. `cadenceVerdict` above is the only
// place a week's outcome is decided, and the cadence ledger is the only place it is
// read from — this function turns an already-decided set into words.
//
// DIRECTION IS SELECTED, NEVER SUBTRACTED. Floor tenants roll up as met/short; cap
// tenants roll up as held/over, in a vocabulary with no to-go, no pace and no
// comparative (#998/#1670). A cap can never reach the "short on …" clause, because the
// clause is built from the FLOOR partition; there is no branch to forget.

// One target's outcome for one closed week, ready to be worded. `label` is the scope's
// noun (see `cadenceScopeNoun`) — the sentence, not the label, carries the direction.
export interface CadenceTargetVerdict {
  label: string;
  direction: CadenceDirection;
  verdict: CadenceVerdict;
  /**
   * A FLOOR target whose optional weekly MAXIMUM was passed this week (#1259's range
   * ceiling: count strictly greater than `per_week_max`). #2395's ruling for a target
   * carrying both a floor and a cap — report the floor verdict, mention the ceiling
   * only on exceedance. Never set for a cap tenant: a cap's exceedance IS its
   * `over-cap` verdict, and reporting it twice would double-count it.
   */
  overCeiling?: boolean;
}

// The scope's plain NOUN — "Alcohol", not "Alcohol (weekly cap)". `frequencyScopeLabel`
// annotates a substance with its direction because a chip has no sentence around it to
// carry that; a sentence does ("over the Alcohol cap"), and pasting the annotation in
// produces "the Alcohol (weekly cap) cap". One place decides, so no message builder has
// to strip a suffix.
export function cadenceScopeNoun(kind: string, value: string): string {
  if (kind === "substance" && isSubstance(value))
    return substanceDef(value).label;
  return frequencyScopeLabel(kind, value);
}

// A rollup's parts, in the shared message-line roles: a head and its qualifiers. The
// caller decides the row label and the punctuation — this never assembles a separator.
export interface CadenceVerdictLine {
  value: string;
  notes: string[];
}

// Up to `WEEKLY_PACE_MAX_NAMED` names, with the overflow counted rather than listed —
// the same tail `weeklyTargetPaceLine` uses, so a laggard list and a shortfall list are
// punctuated identically.
function namedList(labels: readonly string[]): string {
  const named = labels.slice(0, WEEKLY_PACE_MAX_NAMED);
  const rest = labels.length - named.length;
  return rest > 0 ? `${named.join(", ")}, +${rest} more` : named.join(", ");
}

const plural = (n: number, word: string): string =>
  `${word}${n === 1 ? "" : "s"}`;

// The closed week's rollup: "4 of 5 targets met" with the laggards named, and the cap
// tenants stated in their own vocabulary. Null for a profile with no targets.
export function cadenceWeekVerdictLine(
  entries: readonly CadenceTargetVerdict[]
): CadenceVerdictLine | null {
  if (entries.length === 0) return null;
  const floors = entries.filter((e) => e.direction === "floor");
  const caps = entries.filter((e) => e.direction === "cap");

  const short = floors.filter((e) => e.verdict === "under");
  const overCeiling = floors.filter((e) => e.overCeiling === true);
  const overCaps = caps.filter((e) => e.verdict === "over-cap");
  const heldCaps = caps.filter((e) => e.verdict !== "over-cap");

  // The head counts whichever partition the profile actually has. A cap-only profile
  // gets a cap-only head: rolling its caps into a "targets met" count would state a
  // floor's success condition over a scope that has none.
  const value =
    floors.length > 0
      ? `${floors.length - short.length} of ${floors.length} ${plural(
          floors.length,
          "target"
        )} met`
      : `${heldCaps.length} of ${caps.length} weekly ${plural(
          caps.length,
          "cap"
        )} held`;

  const notes = [
    short.length > 0
      ? `short on ${namedList(short.map((e) => e.label))}`
      : null,
    overCeiling.length > 0
      ? `past the weekly maximum on ${namedList(
          overCeiling.map((e) => e.label)
        )}`
      : null,
    // A cap clause states a FACT and stops. No remaining count, no comparative, and
    // nothing that reads as room to fill.
    overCaps.length > 0
      ? `over the ${namedList(overCaps.map((e) => e.label))} ${plural(
          overCaps.length,
          "cap"
        )}`
      : null,
    heldCaps.length > 0 && floors.length > 0
      ? `within the ${namedList(heldCaps.map((e) => e.label))} ${plural(
          heldCaps.length,
          "cap"
        )}`
      : null,
  ].filter((n): n is string => n != null);

  return { value, notes };
}

// ---------------------------------------------------------------------------
// A cap over SEVERAL closed weeks (#2397)
// ---------------------------------------------------------------------------

// How a declared cap fared across a period's completed weeks. `overWeeks` of `weeks`,
// both counted off the same ledger read — never a run, never a streak (#1955), and
// never joined to a biomarker (#2397): this states the verdict on a target the USER
// set and stops there.
export interface CadenceCapWeeks {
  label: string;
  overWeeks: number;
  weeks: number;
}

// One cap's period sentence. Under-cap weeks are the SUCCESS state (#1670), so a period
// with no exceedance says so plainly rather than going silent — silence would be
// indistinguishable from having declared no cap at all.
export function cadenceCapWeeksSentence(cap: CadenceCapWeeks): string {
  return cap.overWeeks > 0
    ? `over the ${cap.label} cap in ${cap.overWeeks} of ${cap.weeks} ${plural(
        cap.weeks,
        "week"
      )}`
    : `${cap.label} cap held all ${cap.weeks} ${plural(cap.weeks, "week")}`;
}
