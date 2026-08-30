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
// THE TAP TRADE stays here because #3390's committed baseline at
// scripts/census-chrome-baseline.json records rendered geometry, not tap counts;
// #3219 and #3222 use the same point-of-contact record. A summary-first form costs
// ONE EXTRA TAP per fact the person actually wants to change (open the
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
import { formatSeconds } from "./duration";
import { displayUnit } from "./display-unit";
import {
  DEFAULT_FORMAT_PREFS,
  formatDateWithYear,
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
      return weight
        ? `${weight} ${t.weightUnit}${reps ? ` × ${reps}` : ""}`
        : null;
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
    const shownUnit = displayUnit(t.unit);
    return `${DIRECTION_WORD[t.direction]} ${value}${shownUnit ? ` ${shownUnit}` : ""}`;
  }
  const value = num(t.value);
  if (!value) return null;
  return t.unit.trim() ? `${value} ${t.unit.trim()}` : value;
}

/**
 * "by 31 Dec 2026", or null when the goal carries no deadline.
 *
 * WITH THE YEAR, and short-month, unlike the protocol row's window. A deadline is
 * routinely a year out ("by next December"), and the weekday a long date leads with
 * is the one part of it nobody sets a goal by.
 */
export function deadlineFactLabel(
  targetDate: string,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
): string | null {
  const value = targetDate.trim();
  if (!value) return null;
  return `by ${formatDateWithYear(value, prefs)}`;
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
      chips.push({
        key: "category",
        label: f.category.trim(),
        state: "stated",
      });
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

// ── The two derivations the form used to do inline ───────────────────────────
//
// Both live here rather than in the component for the ordinary reason (business
// logic belongs in lib/) and for one specific one: each is a claim about what the
// WRITE will do — where progress will start from, and which fact the action would
// refuse — and a claim about the write is exactly the kind of thing that must be
// testable without a browser.

export interface GoalStartingFromInput {
  kind: OutcomeGoalKind;
  /** The lifetime best for the picked movement, in canonical units, or null. */
  exerciseBest: {
    weightKg: number | null;
    reps: number | null;
    durationSec: number | null;
  } | null;
  metric: OutcomeGoalMetric;
  /** The latest body-metric value, canonical kg for weight, or null. */
  bodyLatest: number | null;
  bodyMetric: BodyMetricKind;
  /** The latest reading of the picked analyte and the unit its plot is in. */
  biomarkerLatest: number | null;
  biomarkerUnit: string | null;
  /** What the freeform `current_value` field holds. */
  currentValue: string;
  /** What the freeform `unit` field holds. */
  freeformUnit: string;
  /** Converts a canonical kg into the display unit, rounded as the form displays it. */
  toDisplayWeight: (kg: number) => number;
  /** The label for that display unit — "kg" or "lb". */
  weightUnit: string;
}

/**
 * Where a new goal is starting from, as the chip states it, or null when history has
 * nothing to say.
 *
 * THE MEASURED KINDS READ HISTORY; THE FREEFORM KIND READS THE FIELD. That asymmetry
 * is the whole of #3220's seeding criterion: a strength, body or lab goal's baseline
 * is captured server-side at write time (`createGoal`), so the form's job is to STATE
 * it rather than to collect it — while a freeform goal has no series behind it and
 * the number can only come from the person.
 *
 * THE `sets` METRIC HAS NO STARTING POINT, deliberately: it counts, per session, the
 * sets clearing this goal's own rep bar, so it is a property of the target rather
 * than of the movement, and there is nothing honest to state before the target exists.
 */
export function goalStartingFrom(i: GoalStartingFromInput): string | null {
  if (i.kind === "exercise") {
    if (!i.exerciseBest) return null;
    if (i.metric === "weight")
      return i.exerciseBest.weightKg == null
        ? null
        : startingFromFactLabel({
            value: i.toDisplayWeight(i.exerciseBest.weightKg),
            unit: i.weightUnit,
          });
    if (i.metric === "reps")
      return i.exerciseBest.reps == null
        ? null
        : startingFromFactLabel({ value: i.exerciseBest.reps, unit: "reps" });
    if (i.metric === "hold")
      return i.exerciseBest.durationSec == null
        ? null
        : startingFromFactLabel({
            value: i.exerciseBest.durationSec,
            unit: null,
            asDuration: true,
          });
    return null;
  }
  if (i.kind === "body")
    return i.bodyLatest == null
      ? null
      : startingFromFactLabel({
          value:
            i.bodyMetric === "weight"
              ? i.toDisplayWeight(i.bodyLatest)
              : i.bodyLatest,
          unit: bodyTargetUnit(i.bodyMetric, i.weightUnit),
        });
  if (i.kind === "biomarker")
    return i.biomarkerLatest == null
      ? null
      : startingFromFactLabel({
          value: i.biomarkerLatest,
          unit: displayUnit(i.biomarkerUnit),
        });
  const typed = Number(i.currentValue.trim());
  if (!i.currentValue.trim() || !Number.isFinite(typed)) return null;
  return startingFromFactLabel({
    value: typed,
    unit: i.freeformUnit.trim() || null,
  });
}

export interface GoalProblem {
  /** The fact whose editor the form must open. */
  fact: GoalFactKey;
  message: string;
}

export interface GoalProblemInput {
  kind: OutcomeGoalKind;
  exercise: string;
  metric: OutcomeGoalMetric;
  targetWeight: string;
  targetReps: string;
  targetSets: string;
  targetDuration: string;
  /** True when this movement offers a load context AND none has been chosen (#1610). */
  machineUnchosen: boolean;
  bodyTarget: string;
  /** True once an analyte from the picker's own vocabulary is selected. */
  biomarkerPicked: boolean;
  biomarkerTarget: string;
  title: string;
}

/**
 * The first fact that would make the write refuse, and which chip's editor holds it.
 *
 * WHY THE FORM ASKS THIS AT ALL, rather than leaving it to `required` attributes as
 * it did before (#3220): a `required` control inside a CLOSED fact panel is `hidden`,
 * and a browser will not validate a hidden control — it blocks the submit with "An
 * invalid form control is not focusable" and shows the person nothing at all. So the
 * form asks the question itself and OPENS the fact that needs answering, which is the
 * affordance the chip row makes possible and the plain field wall did not.
 *
 * IT MIRRORS `goalColsFromForm`'s REFUSALS, not a second opinion about them: the
 * exercise metric's primary target, both halves of a sets target, a body or lab
 * number, a freeform title, and #1610's deliberate machine choice. Anything it misses
 * still returns the action's own inline error; nothing it reports can be saved.
 */
export function firstGoalProblem(i: GoalProblemInput): GoalProblem | null {
  const blank = (s: string) => !s.trim();
  if (i.kind === "exercise") {
    if (blank(i.exercise))
      return {
        fact: "subject",
        message: "Pick the exercise this goal is about.",
      };
    if (i.metric === "weight" && blank(i.targetWeight))
      return { fact: "target", message: "Enter the weight you’re aiming for." };
    if (i.metric === "reps" && blank(i.targetReps))
      return { fact: "target", message: "Enter the reps you’re aiming for." };
    if (i.metric === "sets" && (blank(i.targetSets) || blank(i.targetReps)))
      return { fact: "target", message: "Enter both the sets and the reps." };
    if (i.metric === "hold" && blank(i.targetDuration))
      return { fact: "target", message: "Enter the hold you’re aiming for." };
    if (i.machineUnchosen)
      return {
        fact: "equipment",
        message: "Pick the machine this target is for.",
      };
    return null;
  }
  if (i.kind === "body")
    return blank(i.bodyTarget)
      ? { fact: "target", message: "Enter the number you’re aiming for." }
      : null;
  if (i.kind === "biomarker") {
    if (!i.biomarkerPicked)
      return {
        fact: "subject",
        message: "Pick the lab or vital this goal is about.",
      };
    return blank(i.biomarkerTarget)
      ? { fact: "target", message: "Enter the number you’re aiming for." }
      : null;
  }
  return blank(i.title)
    ? { fact: "subject", message: "Name this goal." }
    : null;
}
