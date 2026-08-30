// The summary row of the injury bar's two forms (#3221), stated in the shared
// facts-with-editors grammar (#3218): the facts the form is about to write, each one the
// door to its own editor.
//
// AN INJURY IS ONE SENTENCE — "Right shoulder · Chest · right side · Pushing · Active" —
// and the form that writes it was eight stacked fieldsets, three of them carrying a
// paragraph of explanation, shown in full whether or not the person disagreed with any of
// it. This module decides only WHICH facts the row states and WHAT each one reads; how a
// chip looks and discloses its editor belongs to components/facts/FactChipRow.
//
// THE TAP TRADE stays here because #3390's committed baseline at
// scripts/census-chrome-baseline.json records rendered geometry, not tap counts;
// #3219, #3220 and #3222 use the same point-of-contact record. A summary-first form costs
// ONE EXTRA TAP per fact the person actually wants to change (open the chip, edit, Done)
// and saves the READING of every fact they do not.
//
// THE INJURY BAR QUALIFIES FOR A REASON THE OTHER SIX DID NOT HAVE, and it is worth
// stating rather than asserting. Three of its eight facts — the side, the movement
// patterns, the named lifts — are the #2024/#2199 PRECISION, and every one of them is
// explicitly optional: "leaving every field alone records exactly the region-scoped
// constraint this form always recorded". They are also the three that cost the most
// vertical space, because each carries a paragraph explaining when to reach for it. So
// the common log — a label, a region, a status — was reading past three fieldsets of
// prose written for the uncommon one. Behind the trailing affordance they cost nothing
// until they are wanted, and the paragraphs travel with them.
//
// WHERE THE PATTERN IS STILL REFUSED, unchanged: a surface whose fields are free numeric
// entry rather than discrete facts (the measurements form, recorded in FactChipRow's
// header).
//
// WHAT A TEST SHOULD ASSERT. The chip KEYS, their states, and which facts fall behind the
// trailing affordance — not this file's wording. Copy changes; "an injury with no region
// PROMPTS rather than saving something the write would refuse" does not.
//
// ONE VOCABULARY, and it is `lib/injury-model.ts`'s (#2948's invariant, restated as
// #3221's third criterion). Every label below is composed from `MOVEMENT_PATTERN_LABEL`,
// the `InjuryLaterality` union, `REGION_SCOPES` and `exerciseDisplayName`. There is no
// body-part list, no side list and no movement list in this file.
//
// Pure: no React, no DB, no clock. Both forms are renderers over `injuryFactSummary`.

import {
  DEFAULT_FORMAT_PREFS,
  formatMonthDay,
  type DisplayFormatPrefs,
} from "./format-date";
import {
  MOVEMENT_PATTERN_LABEL,
  type InjuryLaterality,
  type InjuryStatus,
} from "./injury-model";
import { exerciseDisplayName } from "./lifts";
import type { MovementPattern, MuscleRegion } from "./lifts";

// The facts, in the order the row draws them — the same order the fields were stacked in,
// so a reader who knew the old form finds the new one saying the same things in the same
// sequence.
//
// `label` leads because it is what the rest of the sentence is about. `status` sits
// between the precision and the recovery preference exactly where the old select did.
export type InjuryFactKey =
  | "label"
  | "regions"
  | "laterality"
  | "movements"
  | "exercises"
  | "status"
  | "loadFactor"
  | "reviewDate";

export type InjuryFactState = "stated" | "missing";

export interface InjuryFactChip {
  key: InjuryFactKey;
  /** The sentence this chip states. */
  label: string;
  state: InjuryFactState;
}

export interface InjuryFactSummary {
  /** The facts with something to state, plus any MISSING essential, in reading order. */
  chips: InjuryFactChip[];
  /**
   * The OPTIONAL facts with nothing to state, in reading order. They render nothing of
   * their own and are reached through the one trailing affordance, which names them (see
   * `moreInjuryFactsLabel`).
   */
  more: InjuryFactKey[];
}

export const INJURY_FACT_NOUNS: Record<InjuryFactKey, string> = {
  label: "what's hurt",
  regions: "regions",
  laterality: "side",
  movements: "movements",
  exercises: "lifts",
  status: "status",
  loadFactor: "recovery load",
  reviewDate: "reminder",
};

// The status wording the chip states. Deliberately the SHORT form — the select spells out
// what each one does ("Active — set the affected work aside") and the chip states which
// one is chosen, because a chip states the fact and the editor explains it.
export const INJURY_STATUS_FACT_LABEL: Record<InjuryStatus, string> = {
  active: "Active",
  recovering: "Recovering",
  resolved: "Resolved",
};

// ── What each chip reads ─────────────────────────────────────────────────────

/** "Chest, Shoulders", or null when no region has been picked. */
export function regionsFactLabel(
  regions: readonly MuscleRegion[]
): string | null {
  return regions.length > 0 ? regions.join(", ") : null;
}

/**
 * "right side" / "both sides", or null when the person did not say.
 *
 * THE SAME PHRASING `scopeSummary` USES for a one-sided constraint, so the chip the
 * person confirms and the chip the bar lists afterwards read alike. "Both sides" is
 * spelled out rather than "bilateral side", which is not English.
 */
export function lateralityFactLabel(
  laterality: InjuryLaterality | "" | null
): string | null {
  if (!laterality) return null;
  return laterality === "bilateral" ? "both sides" : `${laterality} side`;
}

/** "Pushing, Overhead", or null when no pattern is named. */
export function movementsFactLabel(
  movements: readonly MovementPattern[]
): string | null {
  return movements.length > 0
    ? movements.map((m) => MOVEMENT_PATTERN_LABEL[m]).join(", ")
    : null;
}

/**
 * "Curl, Overhead Press", or null when no lift is named.
 *
 * Rendered through `exerciseDisplayName` for the reason the picker's own chips are: the
 * constraint is stored as a canonical identity, and the row must read like what the
 * person picked rather than the lowercase key it is kept as.
 */
export function exercisesFactLabel(
  exercises: readonly string[]
): string | null {
  return exercises.length > 0
    ? exercises.map(exerciseDisplayName).join(", ")
    : null;
}

/**
 * "easing to 70%", or null when the profile has not set one.
 *
 * The empty string is the app's disclosed 60% fallback, which is NOT a fact the person
 * stated — so the chip says nothing and the fact sits behind the trailing affordance. A
 * chip reading "easing to 60%" would assert a preference nobody expressed (#846).
 */
export function loadFactorFactLabel(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const fraction = Number(value);
  if (!Number.isFinite(fraction)) return null;
  return `easing to ${Math.round(fraction * 100)}%`;
}

/** "revisit 12 Sep", or null when no reminder is set. */
export function reviewDateFactLabel(
  reviewDate: string,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
): string | null {
  const value = reviewDate.trim();
  return value ? `revisit ${formatMonthDay(value, prefs)}` : null;
}

/** The single trailing affordance's own sentence: the optional facts it holds, named. */
export function moreInjuryFactsLabel(more: readonly InjuryFactKey[]): string {
  if (more.length === 0) return "";
  return `${more.map((k) => INJURY_FACT_NOUNS[k]).join(", ")}…`;
}

export interface InjuryFactInput {
  label: string;
  regions: readonly MuscleRegion[];
  laterality: InjuryLaterality | "";
  movements: readonly MovementPattern[];
  exercises: readonly string[];
  loadFactor: string;
  reviewDate: string;
  /**
   * The status a NEW injury is born with, or null on the edit form — where the status is
   * not a fact the form writes at all.
   *
   * The lifecycle belongs to the chip's own Recovering/Resolve buttons (#2297), and
   * `updateInjury` is a PARTIAL that never names it (#2359). A status chip on the edit
   * form would therefore state a fact that Save does not write, which is the one thing
   * this row exists not to do: "a row of chips stating exactly what Save will write".
   */
  status: InjuryStatus | null;
}

/**
 * What the row states, and what falls behind the trailing affordance.
 *
 * THE TWO ESSENTIALS ARE THE TWO THE WRITE REFUSES WITHOUT — a label and at least one
 * region (`logInjuryCore`/`updateInjuryCore`, surfaced by the actions as "Add a label and
 * at least one affected region."). They render as DASHED prompts rather than as absent
 * facts, because the form already knows it wants them.
 *
 * EVERYTHING ELSE IS OPTIONAL AND SILENT WHEN EMPTY, which is #2024's own posture stated
 * in chips: "leaving every field alone records exactly the region-scoped constraint this
 * form always recorded". An absent optional is not a gap in the record and the row must
 * not accuse the person of one.
 */
export function injuryFactSummary(
  f: InjuryFactInput,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
): InjuryFactSummary {
  const chips: InjuryFactChip[] = [];
  const more: InjuryFactKey[] = [];

  const label = f.label.trim();
  chips.push(
    label
      ? { key: "label", label, state: "stated" }
      : { key: "label", label: "what's hurt?", state: "missing" }
  );

  const regions = regionsFactLabel(f.regions);
  chips.push(
    regions
      ? { key: "regions", label: regions, state: "stated" }
      : { key: "regions", label: "pick a region", state: "missing" }
  );

  const optional: [InjuryFactKey, string | null][] = [
    ["laterality", lateralityFactLabel(f.laterality)],
    ["movements", movementsFactLabel(f.movements)],
    ["exercises", exercisesFactLabel(f.exercises)],
  ];
  for (const [key, stated] of optional) {
    if (stated) chips.push({ key, label: stated, state: "stated" });
    else more.push(key);
  }

  // The status is always stated where it exists: a new injury is born ACTIVE unless the
  // person says otherwise, and a default the form will write is exactly the kind of fact
  // the row exists to show before it is written.
  if (f.status)
    chips.push({
      key: "status",
      label: INJURY_STATUS_FACT_LABEL[f.status],
      state: "stated",
    });

  const loadFactor = loadFactorFactLabel(f.loadFactor);
  if (loadFactor)
    chips.push({ key: "loadFactor", label: loadFactor, state: "stated" });
  else more.push("loadFactor");

  const reviewDate = reviewDateFactLabel(f.reviewDate, prefs);
  if (reviewDate)
    chips.push({ key: "reviewDate", label: reviewDate, state: "stated" });
  else more.push("reviewDate");

  return { chips, more };
}

export interface InjuryProblem {
  /** The fact whose editor the form must open. */
  fact: InjuryFactKey;
  message: string;
}

/**
 * The first fact that would make the write refuse, and which chip's editor holds it.
 *
 * WHY THE FORM ASKS THIS AT ALL, rather than leaving it to the `required` attribute it
 * carried before: a `required` control inside a CLOSED fact panel is `hidden`, and a
 * browser will not validate a hidden control — it blocks the submit with "An invalid form
 * control is not focusable" and shows the person nothing at all. So the form asks the
 * question itself and OPENS the fact that needs answering, which is the affordance the
 * chip row makes possible and the plain field wall did not. The same trade #3220 made.
 *
 * IT MIRRORS THE ACTIONS' OWN REFUSAL rather than holding a second opinion about it:
 * `logInjury` and `updateInjury` both answer "Add a label and at least one affected
 * region." Anything this misses still returns the action's inline error; nothing it
 * reports can be saved. Split into two messages because the row can now open exactly the
 * one that is missing, and "add a label" is not advice about regions.
 */
export function firstInjuryProblem(f: {
  label: string;
  regions: readonly MuscleRegion[];
}): InjuryProblem | null {
  if (!f.label.trim()) return { fact: "label", message: "Say what's hurt." };
  if (f.regions.length === 0)
    return {
      fact: "regions",
      message: "Pick at least one affected region.",
    };
  return null;
}
