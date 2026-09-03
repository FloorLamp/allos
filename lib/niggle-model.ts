// The pure niggle layer (issue #2948, part 1) — types, the expiry clock, and the
// live-set derivation. No DB, no network, no clock: the store (lib/niggle-store.ts), the
// Server Action, and the tests all read the same functions.
//
// ── WHAT A NIGGLE IS, AND WHAT IT DELIBERATELY IS NOT ────────────────────────
//
// A niggle is the tier BELOW an injury. The prod evidence for it: `injuries` is empty
// while the owner's own `activities.notes` read "right knee weird" and "left hip no
// good" — the injury entity (regions, muscles, movements, exercises, a three-state
// lifecycle, review dates, load factors) is too heavy to reach for after an ordinary
// session, so the signal lands where nothing can read it.
//
// So a niggle carries exactly four facts: WHERE (a `MuscleRegion` from the injury/lifts
// vocabulary), WHICH SIDE (an `InjuryLaterality`, or null when the person did not say),
// WHERE IT CAME FROM (an optional activity id and/or canonical exercise identity), and
// WHEN it was first and most recently reported. There is:
//
//   • NO status machine. An injury has active/recovering/resolved because someone
//     manages it. Nobody manages a niggle — that is the entire point.
//   • NO management UI. The only write is the user's tap on a confirm chip.
//   • NO stored expiry flag. A niggle is LIVE or not purely as a function of
//     `lastReportedAt` and now, so nothing has to run to resolve one and no cron can
//     leave the table in a state a reader disagrees with. "Auto-expiry is the default
//     lifecycle; a niggle needs zero interaction to go away" (#2948 invariants).
//
// The region vocabulary is `lib/injury-model.ts`'s and nothing else — see
// lib/curated/niggle-lexicon.ts for how a typed word reaches it.

import { daysBetweenDateStr, weekdayOfDateStr, WEEKDAYS_LONG } from "./date";
import { formatRelativeDate } from "./format-date";
import type { InjuryLaterality } from "./injury-model";
import {
  exerciseDisplayName,
  exerciseHistoryKey,
  regionForExercise,
  REGION_SCOPES,
} from "./lifts";
import type { MuscleRegion } from "./lifts";

// ── THE QUIET SPELL ──────────────────────────────────────────────────────────
//
// How long a niggle stays live with NO re-report. #2948 asked for a named constant in
// the 10–14 day range; 14 is the pick, for a training-shaped reason: the app's weekly
// frequency model means a lift is typically revisited once or twice a week, so 14 days
// is the smallest window that reliably contains TWO more sessions touching the region.
// A 10-day clock can expire a niggle between a fortnightly squat day and the next one,
// which would silently drop the very re-report that should have advanced it.
//
// A SUGGESTION-strength constant, not a medical claim: nothing is treated, and expiry
// only means the app stops mentioning it.
export const NIGGLE_QUIET_DAYS = 14;

const MS_PER_DAY = 86_400_000;

// A stored niggle row (the read shape).
export interface Niggle {
  id: number;
  // The coarse region — `lib/lifts` REGION_SCOPES, via the injury vocabulary.
  region: MuscleRegion;
  // The side the person named. NULL means they did not say, and is NEVER a guess: a
  // one-sided niggle recorded with no side is strictly less than we know, which is the
  // honest direction to be wrong in.
  laterality: InjuryLaterality | null;
  // The word the person actually used ("knee", "hip"). DISPLAY ONLY — the `Injury.label`
  // precedent. Nothing keys on it, nothing filters by it, and it is not a vocabulary.
  bodyTerm: string | null;
  // Where it came from, when it came from somewhere: the activity whose notes carried it
  // and/or the canonical exercise identity (`exerciseHistoryKey`) it was blamed on.
  sourceActivityId: number | null;
  sourceExercise: string | null;
  // First report, and most recent report. Canonical UTC instants (#2205).
  reportedAt: string;
  lastReportedAt: string;
}

// The IDENTITY of a niggle for re-report purposes: a person does not have two
// simultaneous right-knee niggles, they have one that keeps coming back. Region +
// laterality, with a null side kept DISTINCT from a stated one — "my knee" and "my right
// knee" are different amounts of knowledge and merging them would invent a side.
export function niggleKey(
  region: MuscleRegion,
  laterality: InjuryLaterality | null
): string {
  return `${region}:${laterality ?? "unstated"}`;
}

// The instant a niggle expires if nothing re-reports it. Pure; canonical instant in,
// canonical instant out.
export function niggleExpiresAt(lastReportedAt: string): string {
  const t = Date.parse(lastReportedAt);
  if (!Number.isFinite(t)) return lastReportedAt;
  return (
    new Date(t + NIGGLE_QUIET_DAYS * MS_PER_DAY).toISOString().slice(0, 19) +
    "Z"
  );
}

// Is this niggle still live at `now`? The boundary is EXCLUSIVE at the far end: a niggle
// last reported exactly NIGGLE_QUIET_DAYS ago has gone quiet for the full spell and is
// expired. An unparseable stamp reads as expired rather than as immortal — a row we
// cannot date must not keep tempering anything forever.
export function isNiggleLive(
  n: Pick<Niggle, "lastReportedAt">,
  now: string
): boolean {
  const last = Date.parse(n.lastReportedAt);
  const at = Date.parse(now);
  if (!Number.isFinite(last) || !Number.isFinite(at)) return false;
  return at - last < NIGGLE_QUIET_DAYS * MS_PER_DAY;
}

// The live subset, input order preserved.
export function liveNiggles<T extends Pick<Niggle, "lastReportedAt">>(
  niggles: readonly T[],
  now: string
): T[] {
  return niggles.filter((n) => isNiggleLive(n, now));
}

// How the app SAYS a niggle, in the person's own word where there is one. "right knee",
// "left hip", "knee" (side unstated), "knee (both sides)". Falls back to the region when
// no surface form was captured — a niggle written by something other than the note
// extractor still has to render.
export function niggleLabel(
  n: Pick<Niggle, "region" | "laterality" | "bodyTerm">
): string {
  const part = n.bodyTerm && n.bodyTerm.trim() ? n.bodyTerm.trim() : n.region;
  if (n.laterality === "bilateral") return `${part} (both sides)`;
  if (n.laterality === "left" || n.laterality === "right")
    return `${n.laterality} ${part}`;
  return part;
}

// ── THE THIRD AND WEAKEST COACHING TIER (#3211 part 3) ───────────────────────
//
// A live niggle gets #838's RECOVERING TREATMENT, not exclusion (#2948 part 3): the
// region STAYS in the recommendation at tempered targets, with the disclosure naming
// why. Three invariants, and all three are pinned in
// lib/__tests__/workout-recommendation-niggles.test.ts:
//
//   1. THE TILT ONLY EVER WEAKENS A SESSION. It never strengthens, never excludes, and
//      never re-ranks: `recommendNextWorkout` composes the tier AFTER the pick, so the
//      items/focus/exercises a niggle-carrying profile gets are byte-for-byte the ones
//      it would get with no niggle at all. Only the TARGET moves, and only downward —
//      composed with a stronger tier by `Math.min`, never by replacement.
//   2. ILLNESS HOLDS AND INJURY EXCLUSIONS OUTRANK IT. The illness hold is structural:
//      `recommendCoaching` returns the held note before `recommendNextWorkout` is ever
//      called, so a niggle cannot speak under a hold. The injury exclusion is enforced
//      here — `niggleTempers` drops a region an ACTIVE injury already excluded, and
//      `resolveTrainingTemper` returns the exclusion untouched.
//   3. NEVER SILENT. Every temper carries its own rendered `note`, which every surface
//      renders beside the suggestion (the #838 always-disclose rule).
//
// The tier is DELIBERATELY NOT an `InjuryConstraint` in disguise. A niggle is not an
// injury — #2948 leaves the injury entity untouched — and every injury disclosure label
// appends the word "injury" (`withInjuryWord`), so a niggle threaded through that
// machinery would tell the user they have an injury they never created, and its
// synthetic id would collide with a real one in `nw.injuryConstraints`. It rides the
// SAME seam instead: one optional field on `NextWorkoutInput`, one field on
// `NextWorkout`, one composition point per consumer.

// How far a live niggle backs a target off, as a fraction of the ordinary next-set
// target. STRICTLY MILDER than `RECOVERING_LOAD_FACTOR` (0.6) on purpose: "third and
// weakest tier" is only true if the weakest tier also tempers the least, and a knee that
// felt weird after Tuesday's squats is not a declared, managed injury. It is also kept
// distinct from `DELOAD_LOAD_FACTOR` (0.9) so a niggle temper and a deload week are never
// confusable in a rendered target.
//
// A SUGGESTION-strength constant, adjust-in-review — nothing is prescribed and the user
// can always log whatever they lift.
export const NIGGLE_LOAD_FACTOR = 0.85;

// What the coaching gather hands the pure core: one LIVE niggle, already resolved to the
// profile's own day. Liveness and the timezone both belong to the gather (the store's
// `getLiveNiggles` and `getTimezone`), so the core stays pure and clock-free — the same
// split `injuries` and `illness` already use.
export interface NiggleCoachingContext {
  region: MuscleRegion;
  // `niggleLabel(n)` — "right knee", "hip", "knee (both sides)".
  label: string;
  // The profile-LOCAL day of the most recent report (YYYY-MM-DD), so the disclosure can
  // say "from Tuesday" without the core knowing a timezone (#2205: instants are stored,
  // days are derived at the boundary).
  lastReportedDay: string;
  // The canonical exercise identity the niggle was blamed on (`exerciseHistoryKey`), when
  // the report named one. Carried for the pre-workout heads-up (#3211 part 4), whose
  // trigger is "today's session touches the region OR THE SOURCE EXERCISE" — the second
  // half reaches sessions the region test cannot (a shoulder niggle from Bench Press is
  // Shoulders, while the bench itself ranks as Chest). Absent/null ⇒ the region is the
  // whole test, which is every niggle the confirm chip writes today.
  sourceExercise?: string | null;
}

// One tempered region, with everything a surface needs to disclose it.
export interface NiggleTemper {
  region: MuscleRegion;
  label: string;
  // The load fraction the suggestion applies.
  factor: number;
  lastReportedDay: string;
  // Carried through from the context so the pre-workout heads-up (#3211 part 4) can both
  // MATCH on it and NAME it. Null when the report blamed no lift.
  sourceExercise: string | null;
  // The rendered disclosure line. Carried on the model rather than re-derived per
  // surface, because the phrase needs `today` and the pure formatters downstream
  // (`contextNotes`, the Training-tab chips) do not have it — the same shape
  // `endurancePlanArm.note` and `ConditionConsideration.note` already use.
  note: string;
}

// "Tuesday" / "yesterday" / "2 weeks ago" — when the person said it, in the shape that
// stays true across the whole 14-day quiet spell. A weekday name is unambiguous only
// inside the last week; past that it would name two possible days, so the phrase falls
// back to the relative form the rest of the app uses.
function reportedWhen(day: string, today: string): string {
  const d = daysBetweenDateStr(day, today);
  if (d == null) return day;
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 7) return WEEKDAYS_LONG[weekdayOfDateStr(day)] ?? day;
  return formatRelativeDate(day, today).toLowerCase();
}

// "Easing off Legs — right knee niggle from Tuesday" (#2948's own copy). Names the
// region the target moved for, the niggle in the person's own word, and when they said
// it — so the change is never silent and never mysterious.
export function niggleTemperLine(
  t: Pick<NiggleCoachingContext, "region" | "label" | "lastReportedDay">,
  today: string
): string {
  return `Easing off ${t.region} — ${t.label} niggle from ${reportedWhen(
    t.lastReportedDay,
    today
  )}`;
}

// The tempers a live niggle set produces, with the INJURY EXCLUSION APPLIED: a region an
// ACTIVE injury has already taken off the table is not tempered, because there is
// nothing left to temper and the card must not offer an eased-off target for a lift it
// is simultaneously avoiding. Ordered by REGION_SCOPES (then input order) for a stable
// read; two niggles on one region each keep their own line, because "left knee" and
// "right knee" are two things the person said.
export function niggleTempers(
  niggles: readonly NiggleCoachingContext[],
  excludedRegions: ReadonlySet<MuscleRegion>,
  today: string
): NiggleTemper[] {
  const kept = niggles.filter((n) => !excludedRegions.has(n.region));
  const order = new Map(REGION_SCOPES.map((r, i) => [r, i]));
  return kept
    .map((n, i) => ({ n, i }))
    .sort(
      (a, b) =>
        (order.get(a.n.region) ?? REGION_SCOPES.length) -
          (order.get(b.n.region) ?? REGION_SCOPES.length) || a.i - b.i
    )
    .map(({ n }) => ({
      region: n.region,
      label: n.label,
      factor: NIGGLE_LOAD_FACTOR,
      lastReportedDay: n.lastReportedDay,
      sourceExercise: n.sourceExercise ?? null,
      note: niggleTemperLine(n, today),
    }));
}

// The tempers covering one lift, by the lift's coarse region — the niggle tier is
// region-scoped and only region-scoped (a niggle records WHERE it hurts, never a
// movement pattern or a named lift, so there is no finer level to honor).
export function nigglesCoveringExercise(
  tempers: readonly NiggleTemper[],
  exerciseName: string
): NiggleTemper[] {
  const region = regionForExercise(exerciseName);
  if (region == null) return [];
  return tempers.filter((t) => t.region === region);
}

// The composed verdict for ONE lift across all three tiers, in their fixed order. This
// is the ONE place the ordering is written down, so every surface that seeds a target
// (the coaching card, the Telegram nudge, the Training-overview session card) inherits
// the same answer and a reorder cannot happen in one of them quietly.
export interface TrainingTemper {
  // Which tier decided this lift. "injury" covers a lift a recovering injury tempers
  // (whether or not a niggle also covers it); "niggle" is the niggle-only case.
  tier: "excluded" | "injury" | "niggle" | "clear";
  // The `NextSetContext` flags — a tempered lift backs its load off to `factor`.
  recoveringRegion: boolean;
  factor: number;
  // The niggle labels this lift's temper names, when the niggle tier contributed.
  niggleLabels: string[];
  // The next-set rationale to render, when the niggle tier is the ONLY reason the target
  // moved. Null otherwise — a lift a recovering injury tempers keeps the injury copy,
  // which is the honest one.
  rationale: string | null;
}

export function resolveTrainingTemper(
  // The injury tier's verdict for this lift (`exerciseInjuryVerdict`), passed in so this
  // module never has to know how a constraint resolves.
  verdict: { kind: "clear" | "tempered" | "excluded"; factor: number },
  tempers: readonly NiggleTemper[],
  exerciseName: string
): TrainingTemper {
  // TIER 1 — an injury exclusion outranks everything below it. A lift that is off the
  // table has no target to ease off, and offering one would contradict the exclusion the
  // same card discloses.
  if (verdict.kind === "excluded")
    return {
      tier: "excluded",
      recoveringRegion: false,
      factor: 1,
      niggleLabels: [],
      rationale: null,
    };

  const covering = nigglesCoveringExercise(tempers, exerciseName);
  const niggleFactor = covering.length
    ? Math.min(...covering.map((t) => t.factor))
    : null;
  const niggleLabels = covering.map((t) => t.label);

  // TIER 2 — a recovering injury tempers. The niggle can only make the ask SMALLER
  // (`Math.min`), never larger: that is invariant 1, and it is why this is a min and not
  // a replacement. In practice the injury's 0.6 already beats the niggle's 0.85, so the
  // min is normally the injury's own factor — but a user-declared loadFactor above the
  // niggle's would otherwise let a niggle STRENGTHEN the session, which must not happen.
  if (verdict.kind === "tempered")
    return {
      tier: "injury",
      recoveringRegion: true,
      factor:
        niggleFactor == null
          ? verdict.factor
          : Math.min(verdict.factor, niggleFactor),
      niggleLabels,
      rationale: null,
    };

  // TIER 3 — the niggle alone.
  if (niggleFactor != null)
    return {
      tier: "niggle",
      recoveringRegion: true,
      factor: niggleFactor,
      niggleLabels,
      rationale: `Easing off — ${niggleLabels.join(", ")} niggle`,
    };

  return {
    tier: "clear",
    recoveringRegion: false,
    factor: 1,
    niggleLabels: [],
    rationale: null,
  };
}

// ── THE PRE-WORKOUT HEADS-UP (#3211 part 4, the first moment) ────────────────
//
// Part 3 moved the TARGET and disclosed it on every in-app surface (`contextNotes`, the
// Training-tab chips). The Telegram workout nudge said nothing: it formats a
// `WorkoutRecommendation`, which carried no niggle field at all — so the one channel
// that reaches somebody BEFORE they train was the only one silent about the knee they
// mentioned on Tuesday.
//
// THE TRIGGER IS NARROWER THAN THE TEMPER'S, deliberately. `niggleTempers` lists every
// live niggle (minus injury-excluded regions), which is right for a surface showing the
// whole context. A push at 7am must speak only when TODAY'S session actually touches the
// niggle, or a knee nobody is about to use becomes a fortnight of daily reminders.

// The tempers today's session touches: its focus regions, the regions its exercises
// train, or — the half the region test cannot reach — the very lift the niggle was
// blamed on. A shoulder tweaked on Bench Press is region `Shoulders` while the bench
// itself ranks `Chest`, so the source exercise is the only thing tying it to chest day.
// Input order preserved (the caller's is already REGION_SCOPES-ordered).
export function nigglesTouchingSession(
  tempers: readonly NiggleTemper[],
  focus: readonly MuscleRegion[],
  exercises: readonly string[]
): NiggleTemper[] {
  const focusRegions = new Set<MuscleRegion>(focus);
  const exerciseRegions = new Set<MuscleRegion>();
  const exerciseKeys = new Set<string>();
  for (const name of exercises) {
    const r = regionForExercise(name);
    if (r) exerciseRegions.add(r);
    const key = exerciseHistoryKey(name);
    if (key) exerciseKeys.add(key);
  }
  return tempers.filter(
    (t) =>
      focusRegions.has(t.region) ||
      exerciseRegions.has(t.region) ||
      (t.sourceExercise != null && exerciseKeys.has(t.sourceExercise))
  );
}

// "Right knee niggle after Squats from Tuesday — take it easy today."
//
// The leading fragment is part 3's `niggleTemperLine` phrasing verbatim ("<label> niggle
// from <when>") so one niggle reads the same wherever the app mentions it; only the ask
// and the blamed lift are new. The lift is named from the stored canonical key through
// `exerciseDisplayName`, which is what that function exists for — the key has lost its
// casing and there is no logged label here to fall back on. Omitted when the report
// blamed no lift, which is every niggle the confirm chip writes today (a note names a
// body part, not a movement).
export function niggleHeadsUpLine(
  t: Pick<NiggleTemper, "label" | "lastReportedDay" | "sourceExercise">,
  today: string
): string {
  const label = t.label.charAt(0).toUpperCase() + t.label.slice(1);
  const lift = t.sourceExercise
    ? ` after ${exerciseDisplayName(t.sourceExercise)}`
    : "";
  return `${label} niggle${lift} from ${reportedWhen(
    t.lastReportedDay,
    today
  )} — take it easy today.`;
}
