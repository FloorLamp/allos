// THE LIMIT DIRECTION AT THE MOMENT IT MATTERS (issue #2377) — pure, DB-free,
// clock-free. Two consumers, two shapes, one decision.
//
// #577 answered "what should I eat more of" from a LOW-flagged biomarker, and #775 gave
// that engine its high-side twin: `meta.reduceEntries` in the curated
// nutrient-food map, four entries, each with an evidence line and a public source
// (lib/food-suggest.ts, `direction: "reduce"`). What has never existed is a path from
// that curated answer to the moment a food decision is actually made — the LOG TAP —
// and to the morning digest. Both surfaces render today; the limit direction reaches
// neither. That is the whole of what this module adds: reach, not knowledge.
//
// ── WHY THIS IS NOT #2572's FORBIDDEN JUXTAPOSITION ──────────────────────────
//
// #2397/#2572 forbid a specific move: the app observes YOUR PATTERN, observes YOUR
// RESULT, and places them side by side so the reader draws a third statement the app
// has no standing to assert ("you consistently consume alcohol, and your liver
// biomarkers are flagged"). Flagged enzymes have many causes; juxtaposition is an
// assertion however carefully it is worded. `lib/food-habit-observation.ts` keeps that
// rule structurally, and its guard test is file-scoped — it does not reach this module
// and would not stop anything written here.
//
// This module does a DIFFERENT act, and the difference is not tone, it is what is being
// claimed:
//
//   • A CURATED, GENERAL statement — "published guidance for a high LDL/ApoB lists
//     fried food among the foods to limit" — is a LOOKUP in a human-reviewed table with
//     a cited source. It is true of everyone with that result and asserts nothing about
//     this person's diet. It is exactly the shape #577 has shipped since long before
//     #2397 ("Vitamin D is low → fatty fish is the richest dietary source"), only
//     pointing the other way.
//   • A CORRELATION the app invents — "you ate this N times and your marker is high" —
//     is a causal claim about one person from two of their own data series.
//
// The line between them is drawn HERE, structurally, in the same idiom as the incumbent
// guard, so a renderer downstream cannot cross it by choosing to:
//
//   A biomarker may be named beside a SINGLE ACT. It may never be named beside a
//   COUNT OVER DAYS.
//
//   • `FoodLimitTapNote` (the log tap) answers ONE serving the user just logged. It
//     names the flagged marker, because the marker is what SELECTED the guidance — the
//     #577 shape. There is no pattern in it: no count, no days, no trend, no share.
//   • `FoodLimitDayObservation` (the digest) reports the day's intersection, so it IS
//     pattern-shaped — and it therefore has NO FIELD for a biomarker, a flag, a reading
//     or a direction, and never names one. Pinned by a test in the same shape as
//     lib/__tests__/food-habit-observation.test.ts's.
//
// ── #998: A LIMIT IS A CAP, AND A CAP HAS NO STREAK ──────────────────────────
//
// Nothing here counts consecutive anything, reports a to-go, a pace or a run, or
// congratulates a day under a limit. Under-cap is a cap's success state and its success
// state is SILENCE (#998). A group that already carries cap semantics — alcohol,
// whose food_log counter IS the substance ledger, or any group under an active
// cap-direction frequency target — is refused by `foodLimitTapNote` outright, because
// two systems saying "limit alcohol" in two vocabularies is worse than one saying it
// well, and the cap vocabulary got there first.
//
// ── TWO SOURCES, TWO VOICES, NEVER THE SAME VOICE ───────────────────────────
//
// A food–drug interaction is a hard, sourced, safety-adjacent rule with a named
// mechanism ("avoid all alcohol during treatment and for 3 days after"). A
// biomarker-motivated dietary limit is a softer and sometimes contested claim.
// Rendering them identically either inflates the dietary advice or deflates the
// interaction, and the second failure is the dangerous one. So the interaction note IS
// the existing care-tier finding's own words (`foodDrugEventTitle`/`Detail` — one
// computation, moved to the moment), it always outranks the dietary note, and the
// surface is told to give it the higher prominence through `hold`.
//
// The cap refusal above does NOT extend to the interaction. #2377's cap-deferral clause
// is about the biomarker-motivated dietary claim, and alcohol + metronidazole is the
// live case the whole food–drug ledger was built for (#2021) — silencing it because
// alcohol carries a cap would delete the feature's reason to exist.
//
// ── FREQUENCY DISCIPLINE, WITH NO STORED "SHOWN" MARKER ──────────────────────
//
// A note on every tap of a limited group is wallpaper within a week and resented before
// that. Two gates, both DERIVED from the log the app already keeps, so there is no new
// table, no marker to sweep and no state that can rot:
//
//   • at most one note per group per day — the tap must be the day's FIRST serving of
//     that group (`servingsBefore === 0`);
//   • the dietary note additionally speaks only ONCE PER ACTIVATION — this must be the
//     first serving of the group logged since the flagged reading that motivates the
//     limit was collected (`firstSinceActive`). A note shown and not acted on is not
//     re-shown by simply logging again; a NEW result re-arms it exactly once.
//
// The interaction note is per-DAY rather than per-activation, matching the granularity
// its own dedupe key already declares (`foodDrugEventKey(item, rule, DATE)` — "a second
// course is a second signal"), which is the right cadence for a safety-adjacent rule.
//
// One consequence, accepted on purpose: when both fire on the same tap the interaction
// wins the single slot, and the dietary claim is not re-queued for tomorrow — by then
// the group has been logged since the flag and `firstSinceActive` is false. The ceiling
// is one note per group per day and the dietary claim's whole justification is
// timeliness; spending the moment on the safety-adjacent one is the right trade.
//
// ── #2385: HOW THIS WOULD LEARN IT SHOULD STOP ───────────────────────────────
//
// This feature claims to change behaviour, so it declares the three things, as prose —
// local queries over data the instance already holds, never telemetry and never a
// user-facing score:
//
//   • WHAT WOULD SHOW IT WORKING — for profiles that received a note, that group's
//     servings per LOGGED DAY falls over the following weeks, while the number of days
//     they log food at all holds steady.
//   • WHAT WOULD SHOW IT WRONG — food logging thins out after a note (fewer logged days,
//     fewer windows derived per day), or the profile stops logging that ONE group while
//     continuing to log everything else. Either means the note taught people to hide the
//     serving rather than reconsider it, and an honest log is worth more than a nudged
//     one.
//   • THE DECEPTIVE SUCCESS — "servings of the limited group went down" is exactly the
//     number that improves in the harm case, because a group that stopped being LOGGED
//     and a group that stopped being EATEN are indistinguishable in it. It may never be
//     read without the denominator beside it: days logged, and that group's presence in
//     the profile's own ledger before and after.
//
// Do not build a registry, a scoring engine or a metrics pipeline for this. It is a
// question to ask of one instance's own database when someone asks whether the feature
// earned its place.
//
// TONE (#992/#716). Every string here states a curated FACT plus its citation. Nothing
// judges the serving, infers a consequence, or says "you shouldn't have" — the write
// already happened, and #559's rule is that context gates ORDER, never what can be
// logged.

import {
  foodDrugEventDetail,
  foodDrugEventTitle,
  type FoodDrugEventFinding,
} from "./food-drug-ledger";
import { foodGroupBySlug } from "./food-groups";
import type { FoodSuggestion } from "./food-suggest";

// The mandatory tail every curated dietary string in the app carries, verbatim from the
// food–drug matcher's posture (lib/food-drug-ledger.ts keeps the interaction half).
const INFORMATIONAL_TAIL = "Informational, not medical advice.";

// The clause that says out loud what the structural rule above enforces: the guidance is
// about the MARKER, not about the serving that was just logged. It is the difference
// between a lookup and an accusation, and the reader should not have to infer it.
const GENERAL_GUIDANCE_CLAUSE =
  "General guidance for the marker, not a claim about this serving.";

// ---- The curated limits a profile currently has ----

// One curated `reduce` entry that is live for this profile right now, projected from the
// #577/#775 engine's own output so this module introduces no second copy of the map and
// no second safety screen. `groupKeys` is the loggable half of the entry: the catalog
// slugs its foods name, with the specific-substance notes that map to no group dropped —
// a limit can only meet a log tap through a group the tap can name.
export interface ActiveFoodLimit {
  /** The reduce-entry key — the `food-reduce:` dedupe family (#482). */
  key: string;
  /** The entry's display label ("LDL cholesterol / ApoB"). */
  label: string;
  /** The catalog food-group slugs this entry names, in curated order. */
  groupKeys: string[];
  /** The flagged biomarker names that made it live, in the engine's order. */
  triggeredBy: string[];
  /** The entry's own plain-language reason. */
  evidence: string;
  /** The entry's public, citable basis. */
  source: string;
  /** `food-reduce:<key>` — the shared suppression bus's key for this family. */
  dedupeKey: string;
}

// The live limits inside an engine run, in the engine's order. Reads `direction ===
// "reduce"` rather than re-selecting entries from the dataset, so every safety screen,
// every dedupe namespace and every ordering decision #577/#775 already made applies here
// untouched and cannot drift.
export function activeFoodLimits(
  suggestions: readonly FoodSuggestion[]
): ActiveFoodLimit[] {
  const out: ActiveFoodLimit[] = [];
  for (const s of suggestions) {
    if (s.direction !== "reduce") continue;
    const groupKeys: string[] = [];
    for (const f of s.foods) {
      if (f.foodGroup && !groupKeys.includes(f.foodGroup))
        groupKeys.push(f.foodGroup);
    }
    if (groupKeys.length === 0) continue;
    out.push({
      key: s.key,
      label: s.label,
      groupKeys,
      triggeredBy: s.triggeredBy,
      evidence: s.evidence,
      source: s.source,
      dedupeKey: s.dedupeKey,
    });
  }
  return out;
}

// ---- The log-tap note ----

export type FoodLimitNoteKind = "interaction" | "dietary";

// The ONE note a tap may answer with. `kind` is what the surface distinguishes on: an
// interaction and a dietary limit are different claims and must not render alike.
export interface FoodLimitTapNote {
  kind: FoodLimitNoteKind;
  /** The food group the tap logged. */
  groupKey: string;
  /** The lead clause — what this is about. */
  title: string;
  /** The cited guidance underneath it, already ending in the informational tail. */
  body: string;
  /**
   * Whether the surface should keep the note up until the reader dismisses it. True for
   * an interaction (safety-adjacent: it must not evaporate mid-meal), false for a
   * dietary note (it takes the ordinary dismiss timer). This is the "distinct
   * prominence" #2377 asks for, expressed as a property of the CLAIM rather than left
   * to each surface to decide — and it is deliberately not a tone: an error tone on a
   * tap that succeeded reads as "your tap failed" (#2296).
   */
  hold: boolean;
}

// One candidate dietary limit for the group being logged, with the arming fact the
// gather derived for it from the food log.
export interface DietaryLimitCandidate {
  limit: ActiveFoodLimit;
  /**
   * Whether this tap is the FIRST serving of the group logged on or since the day the
   * flagged reading behind this limit was collected. Derived from the log, never
   * stored — see the module header.
   */
  firstSinceActive: boolean;
}

export interface FoodLimitTapInput {
  /** The catalog slug the tap logged. */
  groupKey: string;
  /** Servings of that group already on the day's counter BEFORE this tap. */
  servingsBefore: number;
  /**
   * Whether the group carries cap semantics — a substance-ledger counter or an active
   * cap-direction target (`getCapDirectionFoodGroups`). Silences the DIETARY note only.
   */
  capGoverned: boolean;
  /** Today's food–drug EVENT findings, already screened and ordered by the ledger. */
  interactions: readonly FoodDrugEventFinding[];
  /** The live dietary limits naming this group, suppression already applied. */
  dietary: readonly DietaryLimitCandidate[];
}

// "fried_food" → "Fried food", through the catalog so a note names the group exactly as
// the row the user tapped does. Falls back to the slug for a group the catalog has since
// retired, which is a slug the tap could not have produced anyway.
function groupLabel(groupKey: string): string {
  return foodGroupBySlug(groupKey)?.name ?? groupKey;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function joinSentences(parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => !!p && p.trim().length > 0).join(" ");
}

// THE DECISION. Null is the overwhelmingly common answer and means exactly nothing to
// say — never "no interaction found", which would be an all-clear this never issues.
export function foodLimitTapNote(
  input: FoodLimitTapInput
): FoodLimitTapNote | null {
  // Gate 1: at most one note per group per day. Only the tap that puts the day's FIRST
  // serving of this group on the counter may speak; every repeat is silent.
  if (input.servingsBefore > 0) return null;

  // The interaction outranks the dietary note unconditionally, and is NOT subject to the
  // cap refusal — see the module header.
  const hit = input.interactions.find((f) => f.groups.includes(input.groupKey));
  if (hit) {
    return {
      kind: "interaction",
      groupKey: input.groupKey,
      title: foodDrugEventTitle(hit),
      body: foodDrugEventDetail(hit),
      hold: true,
    };
  }

  // #998: where a group already has cap semantics, the cap vocabulary owns the message
  // and this feature stays silent.
  if (input.capGoverned) return null;

  const armed = input.dietary.find((c) => c.firstSinceActive);
  if (!armed) return null;
  const { limit } = armed;
  const markers = joinNames(limit.triggeredBy);
  return {
    kind: "dietary",
    groupKey: input.groupKey,
    // Names the marker beside ONE act — the #577 shape, and the reason the structural
    // rule above permits it here and forbids it on the digest observation.
    title: markers
      ? `${groupLabel(input.groupKey)}: guidance for a high ${markers} lists it among the foods to limit.`
      : `${groupLabel(input.groupKey)} is among the foods this guidance says to limit.`,
    body: joinSentences([
      limit.evidence,
      `Source: ${limit.source}.`,
      GENERAL_GUIDANCE_CLAUSE,
      INFORMATIONAL_TAIL,
    ]),
    hold: false,
  };
}

// The whole note as one string, for a surface with a single line to spend (the log
// bar's toast). Kept here so every surface that flattens it flattens it the same way.
export function foodLimitNoteText(note: FoodLimitTapNote): string {
  return joinSentences([note.title, note.body]);
}

// ---- The digest observation ----

// One group the day logged that a live curated limit names.
//
// THIS TYPE IS THE FIREWALL. It is pattern-shaped — it reports what a day's log
// contained — so by the rule in the module header it may not carry a result. There is
// deliberately NO field for a biomarker, a flag, a reading, a value or a direction, and
// no count either: a renderer downstream cannot pair this person's intake with this
// person's lab result, because it is never handed one. Pinned by a test.
export interface FoodLimitDayObservation {
  groupKey: string;
  /** The catalog display name — "Fried food". */
  label: string;
}

export interface FoodLimitDayInput {
  /** The catalog slugs with at least one serving on the day, in any order. */
  loggedGroups: readonly string[];
  /** The live curated limits, suppression already applied by the gather. */
  limits: readonly ActiveFoodLimit[];
  /** Cap-governed groups (#998) — measured, never reflected back. */
  capGoverned: ReadonlySet<string>;
}

// How many groups one digest line names. Three, for the same reason
// FOOD_HABIT_MAX_NAMED is three: enough to be recognisable, few enough to stay a
// sentence rather than a diary. Anything past it is dropped rather than counted — "+2
// more foods to limit" would be a tally of the person's day, which is the shape this
// surface is bounded against.
export const FOOD_LIMIT_MAX_NAMED = 3;

// The day's intersection, in the curated map's own order (limits, then the groups each
// names), deduped. Empty is silence.
export function foodLimitDayObservations(
  input: FoodLimitDayInput
): FoodLimitDayObservation[] {
  const logged = new Set(input.loggedGroups);
  const seen = new Set<string>();
  const out: FoodLimitDayObservation[] = [];
  for (const limit of input.limits) {
    for (const groupKey of limit.groupKeys) {
      if (seen.has(groupKey)) continue;
      if (!logged.has(groupKey)) continue;
      if (input.capGoverned.has(groupKey)) continue;
      seen.add(groupKey);
      out.push({ groupKey, label: groupLabel(groupKey) });
      if (out.length >= FOOD_LIMIT_MAX_NAMED) return out;
    }
  }
  return out;
}

// The digest's wording for the day's intersection, or null for silence.
//
// STATES A MEMBERSHIP, NOT A VERDICT AND NOT A COUNT. "Foods to limit, logged
// yesterday: fried food and added sugar." No marker is named (the rule above), no
// servings are tallied, no day is compared to another, and there is no run, pace or
// to-go anywhere in it (#998). It is the flattest true sentence about the intersection,
// and the reader can act on it or not.
export function foodLimitDigestHead(
  observations: readonly FoodLimitDayObservation[]
): string | null {
  if (observations.length === 0) return null;
  return `Foods to limit, logged yesterday: ${joinNames(
    observations.map((o) => o.label.toLowerCase())
  )}.`;
}
