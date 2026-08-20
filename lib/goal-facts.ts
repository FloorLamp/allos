// The summary row of the training-goal form (#3220), stated in the shared
// facts-with-editors grammar (#3218): the facts the form is about to write, each one
// the door to its own editor.
//
// A GOAL IS ONE SENTENCE — "Bench Press · 100 kg × 5 · by 31 Dec 2026 · from 92.5 kg"
// — and the form that writes it was 832 lines of field wall across four kind
// branches, shown in full whether or not the person disagreed with any of it. This
// module decides only WHICH facts the row states and WHAT each one reads; how a chip
// looks and discloses its editor belongs to components/facts/FactChipRow.
//
// THE TAP TRADE, written down here because the acceptance criterion that asked for a
// "census baseline" names a file that does not exist in this tree, and #3219 and
// #3222 both answered it in their own fact module's header instead. A summary-first
// form costs ONE EXTRA TAP per fact the person actually wants to change (open the
// chip, edit, Done) and saves the READING of every fact they do not. That is a good
// trade exactly when most facts are already right.
//
// THE GOAL FORM QUALIFIES HARDER THAN ANY OTHER ADOPTER, and it is worth saying why
// rather than asserting it. The kind decides which of four target vocabularies
// applies, so of the form's 30 named inputs a given goal uses six or seven — the
// other two dozen were rendered as structure the person had to read past. And the
// facts that remain are pre-answered: the subject pick decides the kind, history
// already holds the starting value, and the analyte or body metric already carries
// its unit. The common create disagrees with none of them.
//
// WHERE THE PATTERN IS STILL REFUSED, unchanged: a surface whose fields are free
// numeric entry rather than discrete facts (the measurements form, recorded in
// FactChipRow's header). The freeform goal kind is the closest this form gets —
// title, number, unit, all typed — which is exactly why the freeform subject IS its
// title rather than a chip stacked on top of one.
//
// WHAT A TEST SHOULD ASSERT. The chip KEYS, their states, their suggestion marking,
// and which facts fall behind the trailing affordance — not this file's wording.
// Copy changes; "an exercise pick DERIVES the kind and says that it did" does not.
//
// Pure: no React, no DB. The form is a renderer over `goalFactSummary`.

import type {
  BodyMetricKind,
  OutcomeGoalDirection,
  OutcomeGoalKind,
  OutcomeGoalMetric,
} from "./types";
import { BODY_METRIC_LABELS } from "./outcome-goals";
import { formatSeconds } from "./duration";
import {
  DEFAULT_FORMAT_PREFS,
  formatLongDate,
  type DisplayFormatPrefs,
} from "./format-date";

// The facts, in reading order. `subject` is the seeding pick and comes first because
// it is what the rest of the sentence is about — and, since #3220, because it is
// what DECIDES the kind.
export type GoalFactKey =
  | "subject"
  | "kind"
  | "target"
  | "equipment"
  | "deadline"
  | "startingFrom"
  | "title"
  | "category"
  | "notes";

export type GoalFactState = "stated" | "missing";

export interface GoalFactChip {
  key: GoalFactKey;
  /** The sentence this chip states. */
  label: string;
  state: GoalFactState;
  /**
   * Whether this value was supplied FOR the person rather than stated by them
   * (#846/#3222). Undefined where the form does not track suggestion for that fact
   * at all, which is different from tracking it and finding it false.
   */
  suggested?: boolean;
}

export interface GoalFactSummary {
  chips: GoalFactChip[];
  /**
   * The OPTIONAL facts with nothing to state, in reading order. They render nothing
   * of their own and are reached through the one trailing affordance, which names
   * them (see `moreGoalFactsLabel`).
   */
  more: GoalFactKey[];
  /**
   * True when nothing has been picked yet, which is the one fact that renders as a
   * "+ what to track" PROMPT rather than as a dashed missing essential: before the
   * subject there is no goal to be missing anything, and every other chip would be
   * accusing the person of not answering questions they have not been asked.
   */
  subjectAbsent: boolean;
}

export const GOAL_FACT_NOUNS: Record<GoalFactKey, string> = {
  subject: "what to track",
  kind: "kind",
  target: "target",
  equipment: "machine",
  deadline: "deadline",
  startingFrom: "starting point",
  title: "title",
  category: "category",
  notes: "description",
};

export const GOAL_KIND_LABEL: Record<OutcomeGoalKind, string> = {
  exercise: "Exercise goal",
  body: "Body metric",
  biomarker: "Lab or vital",
  freeform: "Freeform",
};

// ── The subject pick, and the kind it implies ────────────────────────────────
//
// THE DERIVATION IS THE POINT (#3220): "an exercise pick implies a strength goal; a
// body metric implies a body goal". A person opening this form knows what they want
// to track and does not know, and should not have to decide, which of four storage
// shapes the app keeps it in. So the subject vocabulary is offered as ONE list with
// group headers and the kind falls out of the pick — stated back as a chip that is
// marked as a suggestion and can be corrected (#3216), never as a silent inference.
export type GoalSubjectGroup = "exercise" | "body" | "biomarker";

export interface GoalSubjectOption {
  /** What the picker shows and matches. Unique across the whole list. */
  label: string;
  /** Which vocabulary this row came from, and so which kind it implies. */
  group: GoalSubjectGroup;
  /**
   * The dropdown header this row sits under.
   *
   * THE BIOMARKER ROWS KEEP THEIR OWN HEADERS, and that is the whole reason this is a
   * string rather than `GOAL_SUBJECT_GROUP_LABEL[group]`. Merging the vocabularies
   * into one picker must not cost the analytes the ranked, group-headed order every
   * biomarker picker has shown since #1675 — "Due or flagged", then "Your markers",
   * then "All biomarkers", with the header saying why. So a biomarker row carries the
   * header the ranker gave it and the two training vocabularies simply precede them.
   */
  groupLabel: string;
  /**
   * The value the form stores for the kind this row implies: the exercise name, the
   * body-metric key, or the analyte's canonical name.
   */
  value: string;
}

export const GOAL_SUBJECT_GROUP_LABEL: Record<GoalSubjectGroup, string> = {
  exercise: "Exercises",
  body: "Body metrics",
  biomarker: "Labs and vitals",
};

/** The kind a subject row implies. */
export function kindForSubjectGroup(group: GoalSubjectGroup): OutcomeGoalKind {
  return group === "exercise"
    ? "exercise"
    : group === "body"
      ? "body"
      : "biomarker";
}

/**
 * The one subject list, in reading order: the movements this profile logs, then the
 * three body metrics, then the analytes the biomarker picker already ranks.
 *
 * LABEL COLLISIONS ARE RESOLVED, NOT HOPED AWAY. `seriesPickerOptions` guarantees
 * the analyte labels are unique among THEMSELVES, and nothing guarantees an exercise
 * is not also called "Cortisol". A duplicate label would make the label→subject map
 * lossy and a pick ambiguous, so a later row that repeats an earlier label is
 * qualified with its group's noun rather than dropped — dropping it would silently
 * remove a real analyte from the vocabulary.
 */
export function goalSubjectOptions(input: {
  lifts: readonly string[];
  bodyMetrics: readonly BodyMetricKind[];
  biomarkers: readonly { name: string; label: string; group: string }[];
}): GoalSubjectOption[] {
  const out: GoalSubjectOption[] = [];
  const seen = new Set<string>();
  const push = (
    label: string,
    group: GoalSubjectGroup,
    groupLabel: string,
    value: string
  ) => {
    if (!label.trim()) return;
    const key = label.trim().toLowerCase();
    const unique = seen.has(key)
      ? `${label} (${GOAL_SUBJECT_GROUP_LABEL[group].toLowerCase()})`
      : label;
    seen.add(key);
    seen.add(unique.trim().toLowerCase());
    out.push({ label: unique, group, groupLabel, value });
  };
  for (const lift of input.lifts)
    push(lift, "exercise", GOAL_SUBJECT_GROUP_LABEL.exercise, lift);
  for (const bm of input.bodyMetrics)
    push(BODY_METRIC_LABELS[bm], "body", GOAL_SUBJECT_GROUP_LABEL.body, bm);
  for (const bio of input.biomarkers)
    push(bio.label, "biomarker", bio.group, bio.name);
  return out;
}

// ── What each chip reads ─────────────────────────────────────────────────────

/**
 * The target the row states, per kind.
 *
 * Every number arrives as the STRING the field holds, because that is what the form
 * has and because "" and "0" are different answers: a blank target is missing, and a
 * zero one is a target the write will refuse. Nothing here parses units or converts.
 */
export type GoalTargetInput =
  | {
      kind: "exercise";
      metric: OutcomeGoalMetric;
      weight: string;
      reps: string;
      sets: string;
      duration: string;
      /** The unit the weight field is captured in — "kg" or "lb". */
      weightUnit: string;
    }
  | { kind: "body"; metric: BodyMetricKind; value: string; weightUnit: string }
  | {
      kind: "biomarker";
      direction: OutcomeGoalDirection;
      value: string;
      unit: string | null;
    }
  | { kind: "freeform"; value: string; unit: string };

const DIRECTION_WORD: Record<OutcomeGoalDirection, string> = {
  below: "under",
  above: "over",
};

/** The unit a body-metric target is entered in. Weight follows the profile's pref. */
export function bodyTargetUnit(
  metric: BodyMetricKind,
  weightUnit: string
): string {
  if (metric === "weight") return weightUnit;
  return metric === "body_fat" ? "%" : "bpm";
}

const num = (raw: string): string => raw.trim();

/**
 * What the target chip says, or null when there is no target yet.
 *
 * A SETS TARGET READS "3 × 8", NOT "3 sets of 8 reps at 60 kg". The chip states the
 * fact; the editor spells it out. Where an optional companion IS set it rides along
 * (`× 5` on a weight target, `@ 60 kg` on a rep or set count) because that companion
 * changes what the goal means — "100 kg" and "100 kg × 5" are different lifts.
 */
export function targetFactLabel(t: GoalTargetInput): string | null {
  if (t.kind === "exercise") {
    const weight = num(t.weight);
    const reps = num(t.reps);
    const sets = num(t.sets);
    const duration = num(t.duration);
    const at = weight ? ` @ ${weight} ${t.weightUnit}` : "";
    if (t.metric === "weight")
      return weight ? `${weight} ${t.weightUnit}${reps ? ` × ${reps}` : ""}` : null;
    if (t.metric === "reps") return reps ? `${reps} reps${at}` : null;
    if (t.metric === "sets")
      return sets && reps ? `${sets} × ${reps}${at}` : null;
    return duration ? `${duration} hold` : null;
  }
  if (t.kind === "body") {
    const value = num(t.value);
    if (!value) return null;
    const unit = bodyTargetUnit(t.metric, t.weightUnit);
    return unit === "%" ? `${value}%` : `${value} ${unit}`;
  }
  if (t.kind === "biomarker") {
    const value = num(t.value);
    if (!value) return null;
    return `${DIRECTION_WORD[t.direction]} ${value}${t.unit ? ` ${t.unit}` : ""}`;
  }
  const value = num(t.value);
  if (!value) return null;
  return t.unit.trim() ? `${value} ${t.unit.trim()}` : value;
}

/** "by 31 December 2026", or null when the goal carries no deadline. */
export function deadlineFactLabel(
  targetDate: string,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
): string | null {
  const value = targetDate.trim();
  if (!value) return null;
  return `by ${formatLongDate(value, prefs)}`;
}

/**
 * WHERE THE GOAL IS STARTING FROM, and this is the fact history pre-answers (#3220).
 *
 * `value` is already in the unit the chip will state, converted at the form's
 * boundary the way every other display does. A hold is seconds and reads as m:ss,
 * because "120 s" is not how anyone says a two-minute plank.
 */
export function startingFromFactLabel(input: {
  value: number | null;
  unit: string | null;
  asDuration?: boolean;
}): string | null {
  if (input.value == null) return null;
  if (input.asDuration) return `from ${formatSeconds(input.value)}`;
  const unit = input.unit?.trim();
  if (unit === "%") return `from ${input.value}%`;
  return unit ? `from ${input.value} ${unit}` : `from ${input.value}`;
}

/** The single trailing affordance's own sentence: the optional facts it holds, named. */
export function moreGoalFactsLabel(more: readonly GoalFactKey[]): string {
  if (more.length === 0) return "";
  return `${more.map((k) => GOAL_FACT_NOUNS[k]).join(", ")}…`;
}

export interface GoalFactInput {
  /** The kind the form will post. */
  kind: OutcomeGoalKind;
  /**
   * True while the kind came from the subject pick and the person has not since
   * stated one themselves. Drives the chip's suggestion marking (#3216/#3222) —
   * "we worked this out for you, and you can say otherwise".
   */
  kindDerived: boolean;
  /**
   * What the goal is about, as the row states it: the exercise, the body metric's
   * label, the analyte's label, or the freeform goal's own title. Empty when nothing
   * has been picked.
   */
  subject: string;
  target: GoalTargetInput;
  targetDate: string;
  /** Already-formatted starting point — see `startingFromFactLabel`. */
  startingFrom: string | null;
  /**
   * Whether the starting point was read out of history rather than typed. The
   * measured kinds always suggest it; the freeform kind never does.
   */
  startingFromSuggested: boolean;
  /**
   * The load context this goal is scoped to (#1610), or null when the movement has
   * none to choose from. "any machine" is the explicit movement-wide answer and is a
   * STATED label, not an absent one — #1610's whole finding is that silently folding
   * every machine is the bug, so the row says which answer was given.
   */
  equipment: { label: string | null } | null;
  title: string;
  category: string;
  notes: string;
}

/**
 * What the row states, and what falls behind the trailing affordance.
 *
 * THE DEADLINE IS A MISSING ESSENTIAL RATHER THAN AN OPTIONAL, which is a departure
 * from the protocol row's treatment of its window and is deliberate. A goal with no
 * `target_date` is invisible to goal pacing (#45) and to Upcoming's goal fold
 * (#2579) — the two surfaces that exist to tell you a goal is slipping. The write
 * still accepts one without a date, so this is a dashed prompt, never a block.
 *
 * NOTHING ELSE IS STATED BEFORE THE SUBJECT IS. Until the person has said what the
 * goal is about there is no kind, no target vocabulary and no history to read, so
 * the row is the prompt alone.
 */
export function goalFactSummary(
  f: GoalFactInput,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
): GoalFactSummary {
  const chips: GoalFactChip[] = [];
  const more: GoalFactKey[] = [];
  const subject = f.subject.trim();
  if (!subject) return { chips, more, subjectAbsent: true };

  chips.push({ key: "subject", label: subject, state: "stated" });

  // THE CORRECTABLE KIND (#3216). Marked as a suggestion while it was derived from
  // the subject pick, and tracked-and-false once the person has chosen one — which
  // is the difference `data-suggested="0"` exists to carry.
  chips.push({
    key: "kind",
    label: GOAL_KIND_LABEL[f.kind],
    state: "stated",
    suggested: f.kindDerived,
  });

  const target = targetFactLabel(f.target);
  chips.push(
    target == null
      ? { key: "target", label: "add a target", state: "missing" }
      : { key: "target", label: target, state: "stated" }
  );

  if (f.equipment)
    chips.push(
      f.equipment.label == null
        ? { key: "equipment", label: "pick a machine", state: "missing" }
        : { key: "equipment", label: f.equipment.label, state: "stated" }
    );

  const deadline = deadlineFactLabel(f.targetDate, prefs);
  chips.push(
    deadline == null
      ? { key: "deadline", label: "add a deadline", state: "missing" }
      : { key: "deadline", label: deadline, state: "stated" }
  );

  if (f.startingFrom)
    chips.push({
      key: "startingFrom",
      label: f.startingFrom,
      state: "stated",
      suggested: f.startingFromSuggested,
    });
  else more.push("startingFrom");

  // A TITLE IS AN OVERRIDE, NOT A NAME. Every measured kind composes its own title
  // server-side from the facts above ("LDL Cholesterol under 100"), so an empty one
  // is the normal case and the row must not prompt for it. The freeform kind is the
  // exception and has no title chip at all — its title IS its subject.
  if (f.kind !== "freeform") {
    if (f.title.trim())
      chips.push({
        key: "title",
        label: `titled “${f.title.trim()}”`,
        state: "stated",
      });
    else more.push("title");
  }

  if (f.kind === "freeform") {
    if (f.category.trim())
      chips.push({ key: "category", label: f.category.trim(), state: "stated" });
    else more.push("category");

    // A MARKER, NOT THE TEXT — the same reading the protocol row's notes chip takes.
    // A description is a paragraph; the fact the row can honestly state is THAT
    // there is one.
    if (f.notes.trim())
      chips.push({ key: "notes", label: "description", state: "stated" });
    else more.push("notes");
  }

  return { chips, more, subjectAbsent: false };
}
