// The summary row of the protocol form (#3219), stated in the shared
// facts-with-editors grammar (#3218): the facts the form is about to write, each one
// the door to its own editor.
//
// A PROTOCOL IS A SENTENCE — "Sauna · 3–5×/week · 12 weeks · with Omega-3" — and the
// form that writes it was six stacked sections of fields whether or not the person
// disagreed with any of them. This module decides only WHICH facts the row states and
// WHAT each one reads; how a chip looks and discloses its editor belongs to
// components/facts/FactChipRow.
//
// THE TAP TRADE, written down once because every consumer of this pattern makes it and
// nobody should have to re-derive it. A summary-first form costs ONE EXTRA TAP per fact
// the person actually wants to change (open the chip, edit, Done) and saves the reading
// of every fact they do not. That is a good trade exactly when most facts are already
// right — which is why the pattern is offered to forms whose fields are discrete facts
// with defaults worth keeping, and refused for free numeric entry where every field is
// the reason you opened the form (the measurements form is the recorded counter-case in
// FactChipRow's header). The protocol form qualifies: a template or a practice pick
// answers most of it, and the common create disagrees with none of them.
//
// WHAT A TEST SHOULD ASSERT. The chip KEYS, their states, and which facts fall behind
// the trailing affordance — not this file's wording. Copy changes; "a protocol with a
// practice but no cadence PROMPTS rather than inventing a number" does not.
//
// Pure: no React, no DB. The form is a renderer over `protocolFactSummary`.

import { foodGroupName } from "./food-groups";
import {
  DEFAULT_FORMAT_PREFS,
  formatLongDate,
  type DisplayFormatPrefs,
} from "./format-date";
import { daysBetweenDateStr } from "./date";

// The facts, in reading order. `practice` is the seeding pick and comes first because
// it is what the rest of the sentence is about.
export type ProtocolFactKey =
  "practice" | "cadence" | "window" | "link" | "situation" | "notes";

export type ProtocolFactState = "stated" | "missing";

export interface ProtocolFactChip {
  key: ProtocolFactKey;
  /** The sentence this chip states. */
  label: string;
  state: ProtocolFactState;
}

export interface ProtocolFactSummary {
  chips: ProtocolFactChip[];
  /**
   * The OPTIONAL facts with nothing to state, in reading order. They render nothing of
   * their own and are reached through the one trailing affordance, which names them
   * (see `moreProtocolFactsLabel`).
   */
  more: ProtocolFactKey[];
  /**
   * True when no practice has been chosen, which is the one fact that renders as a
   * "+ practice" PROMPT rather than as a dashed missing essential: a protocol without a
   * weekly practice is complete and common ("Creatine 5 g/day" tracks no sessions), so
   * the row must not accuse it of missing something.
   */
  practiceAbsent: boolean;
}

export const PROTOCOL_FACT_NOUNS: Record<ProtocolFactKey, string> = {
  practice: "practice",
  cadence: "cadence",
  window: "window",
  link: "link",
  situation: "situation",
  notes: "notes",
};

export interface ProtocolFactInput {
  /**
   * The practice select's value, already resolved to a scope by the caller, or null
   * when nothing is tracked. `label` is the practice's own noun — "Sauna", "Strength",
   * "Fatty fish" — NOT the "<x> sessions" phrase the protocol detail card uses: a chip
   * states the subject, and the counting noun belongs beside a count.
   */
  practice: {
    scopeKind: "type" | "food_group" | "practice";
    value: string;
  } | null;
  /** Whole sessions per week the cadence editor holds, or null when blank/invalid. */
  perWeek: number | null;
  /** The optional weekly ceiling, or null. Ignored unless `perWeek` is set. */
  perWeekMax: number | null;
  startDate: string;
  endDate: string;
  /** The linked intake item's display name, when one is linked. */
  intakeItemName: string | null;
  /** The linked equipment's display name, when one is linked. */
  equipmentName: string | null;
  situation: string;
  notes: string;
}

const PRACTICE_TYPE_NOUNS: Record<string, string> = {
  strength: "Strength",
  cardio: "Cardio",
  sport: "Sport",
};

/**
 * The practice's own noun, as the chip states it.
 *
 * Deliberately NOT `protocolPracticeLabel`, which appends "sessions"/"servings". That
 * phrase reads correctly beside a weekly count ("3 of 4 Sauna sessions") and wrongly as
 * the subject of a sentence whose next chip is the count.
 */
export function practiceFactLabel(
  scopeKind: "type" | "food_group" | "practice",
  value: string
): string {
  if (scopeKind === "food_group") return foodGroupName(value);
  if (scopeKind === "practice") return value;
  return PRACTICE_TYPE_NOUNS[value] ?? value;
}

/** "3×/week", or "3–5×/week" when the practice carries a weekly range (#1259). */
export function cadenceFactLabel(
  perWeek: number,
  perWeekMax: number | null
): string {
  return perWeekMax != null && perWeekMax > perWeek
    ? `${perWeek}–${perWeekMax}×/week`
    : `${perWeek}×/week`;
}

/**
 * What the window chip says.
 *
 * A CLOSED window states its LENGTH rather than its two endpoints — "12 weeks" is the
 * fact a person checks a protocol against, and two dates make them do the subtraction.
 * An open-ended one states the endpoint it has. Weeks while the span divides evenly into
 * them, days below a week, otherwise the endpoint: "11 weeks 3 days" is arithmetic
 * nobody asked for.
 */
export function windowFactLabel(
  startDate: string,
  endDate: string,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
): string | null {
  if (!startDate && !endDate) return null;
  if (!startDate) return `Until ${formatLongDate(endDate, prefs)}`;
  if (!endDate) return `From ${formatLongDate(startDate, prefs)}`;

  const days = daysBetweenDateStr(startDate, endDate);
  if (days == null || days < 0)
    return `Until ${formatLongDate(endDate, prefs)}`;
  if (days < 7) return days === 1 ? "1 day" : `${days} days`;
  if (days % 7 === 0) {
    const weeks = days / 7;
    return weeks === 1 ? "1 week" : `${weeks} weeks`;
  }
  return `Until ${formatLongDate(endDate, prefs)}`;
}

/** The single trailing affordance's own sentence: the optional facts it holds, named. */
export function moreProtocolFactsLabel(
  more: readonly ProtocolFactKey[]
): string {
  if (more.length === 0) return "";
  return `${more.map((k) => PROTOCOL_FACT_NOUNS[k]).join(", ")}…`;
}

/**
 * What the row states, and what falls behind the trailing affordance.
 *
 * THE CADENCE CHIP EXISTS ONLY ONCE A PRACTICE DOES. "3×/week" of nothing is not a
 * fact, and a dashed "add a cadence" beside a protocol that tracks no practice would
 * demand an answer to a question the person never asked. So cadence is an essential of
 * the PRACTICE, not of the protocol.
 */
export function protocolFactSummary(
  f: ProtocolFactInput,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
): ProtocolFactSummary {
  const chips: ProtocolFactChip[] = [];
  const more: ProtocolFactKey[] = [];

  if (f.practice)
    chips.push({
      key: "practice",
      label: practiceFactLabel(f.practice.scopeKind, f.practice.value),
      state: "stated",
    });

  if (f.practice)
    chips.push(
      f.perWeek == null
        ? { key: "cadence", label: "Add a cadence", state: "missing" }
        : {
            key: "cadence",
            label: cadenceFactLabel(f.perWeek, f.perWeekMax),
            state: "stated",
          }
    );

  const window = windowFactLabel(f.startDate, f.endDate, prefs);
  chips.push(
    window == null
      ? { key: "window", label: "Add a start", state: "missing" }
      : { key: "window", label: window, state: "stated" }
  );

  // ONE LINK CHIP OVER TWO FIELDS, because "what this protocol is about" is one
  // question the person answers in whichever of the two vocabularies fits — an intake
  // item (#660, the creatine case) or a piece of recovery gear (#344). Two chips would
  // state one fact twice and leave one of them permanently absent.
  const link =
    f.intakeItemName && f.equipmentName
      ? `With ${f.intakeItemName} · ${f.equipmentName}`
      : f.intakeItemName
        ? `With ${f.intakeItemName}`
        : f.equipmentName
          ? `Using ${f.equipmentName}`
          : null;
  if (link) chips.push({ key: "link", label: link, state: "stated" });
  else more.push("link");

  const situation = f.situation.trim();
  if (situation)
    chips.push({
      key: "situation",
      label: `When ${situation}`,
      state: "stated",
    });
  else more.push("situation");

  // A MARKER, NOT THE TEXT. Notes are a paragraph; a chip that tried to state one would
  // either truncate a sentence mid-word or blow the row apart on a narrow screen. The
  // fact the row can honestly state is THAT there are notes.
  if (f.notes.trim())
    chips.push({ key: "notes", label: "Notes", state: "stated" });
  else more.push("notes");

  return { chips, more, practiceAbsent: f.practice == null };
}
