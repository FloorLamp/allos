// The summary row of the manual sleep-and-mood entry (#3222), stated in the shared
// facts-with-editors grammar (#3218): the facts the dialog is about to write, each one
// the door to its own editor.
//
// THE SMALLEST CONSUMER, and deliberately so — three facts and no seeding pick beyond
// the profile's own history. It exercises the primitive's lower bound: if the grammar
// only reads well on a form with a dozen fields, it is a decoration rather than a
// pattern.
//
// WHAT A TEST SHOULD ASSERT. The chip KEYS and their states — which facts the row states
// — not this file's wording. Copy changes; "a night with no manual duration and no
// history to borrow from prompts rather than inventing one" does not.
//
// Pure: no React, no DB. The dialog is a renderer over `sleepFactSummary`.

import { shiftDateStr } from "./date";
import {
  DEFAULT_FORMAT_PREFS,
  formatLongDate,
  type DisplayFormatPrefs,
} from "./format-date";
import { moodLabel } from "./mood";
import type { SleepMoodHistoryRow } from "./sleep-summary";

export type SleepFactKey = "night" | "duration" | "mood";

export type SleepFactState = "stated" | "missing";

export interface SleepFactChip {
  key: SleepFactKey;
  // The sentence this chip states.
  label: string;
  state: SleepFactState;
  // The value came from the profile's own recent nights, not from the person (#846).
  // It is an editable SUGGESTION and the chip has to say so — that marking is the whole
  // difference between prefilling and asserting.
  suggested?: boolean;
}

export interface SleepFactSummary {
  chips: SleepFactChip[];
}

export interface SleepFactInput {
  // The night chip is offered only where the date is editable, which is the add path.
  // An edit opens one existing row and its date is stated by the dialog's own title; a
  // chip that opened an editor with nothing in it would be a disclosure over nothing.
  nightLabel: string | null;
  // Whole minutes the duration editor currently holds, or null when it is blank or
  // out of range.
  durationMinutes: number | null;
  // False for an imported or windowed night, which stays read-only (#2556).
  durationEditable: boolean;
  // What a read-only night already shows, so its chip states the duration rather than
  // making the person open an editor to be told they cannot use it.
  importedMinutes: number | null;
  durationSuggested: boolean;
  valence: number | null;
}

export const SLEEP_FACT_NOUNS: Record<SleepFactKey, string> = {
  night: "night",
  duration: "duration",
  mood: "mood",
};

/** "7 h 40 m", "7 h", "40 m". */
export function sleepDurationLabel(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} m`;
  if (minutes === 0) return `${hours} h`;
  return `${hours} h ${minutes} m`;
}

/**
 * What the night chip says. A sleep row is dated by the day the person WOKE, so the
 * entry dated today is the night that just ended — "Last night", which is the phrase
 * nine times out of ten and the reason the date is a chip rather than a required field.
 */
export function sleepNightLabel(
  date: string,
  today: string,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
): string {
  if (date === today) return "Last night";
  if (date === shiftDateStr(today, -1)) return "The night before";
  return formatLongDate(date, prefs);
}

/** How many recent manual nights the typical duration is drawn from. */
export const TYPICAL_SLEEP_WINDOW = 14;

/**
 * The profile's typical manual duration, in whole minutes, or null when there is
 * nothing to borrow from.
 *
 * ONLY MANUAL NIGHTS COUNT. The suggestion offered on an empty duration has to be the
 * kind of number this dialog writes — a duration somebody typed — not an imported
 * night's measured total, which is a different instrument and is not what the person is
 * about to record.
 *
 * The MEDIAN rather than the mean, because one 2 a.m. deadline should not move the
 * default, and rounded to five minutes because a suggestion claiming 7 h 26 m is
 * claiming a precision it does not have.
 */
export function typicalSleepMinutes(
  history: readonly SleepMoodHistoryRow[],
  window: number = TYPICAL_SLEEP_WINDOW
): number | null {
  const minutes = history
    .filter((row) => row.sleepEditHours != null)
    .slice(-window)
    .map((row) => Math.round((row.sleepEditHours ?? 0) * 60))
    .filter((total) => total >= 1 && total <= 24 * 60);
  if (minutes.length === 0) return null;

  const sorted = [...minutes].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? sorted[middle]
      : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  return Math.round(median / 5) * 5;
}

export function sleepFactSummary(f: SleepFactInput): SleepFactSummary {
  const chips: SleepFactChip[] = [];

  if (f.nightLabel != null)
    chips.push({ key: "night", label: f.nightLabel, state: "stated" });

  if (!f.durationEditable)
    // A synced night states what it measured and says who measured it. The editor
    // behind the chip is the read-only explanation, unchanged.
    chips.push({
      key: "duration",
      label:
        f.importedMinutes == null
          ? "duration is read-only"
          : `${sleepDurationLabel(f.importedMinutes)} · synced`,
      state: "stated",
    });
  else if (f.durationMinutes != null)
    chips.push({
      key: "duration",
      label: sleepDurationLabel(f.durationMinutes),
      state: "stated",
      suggested: f.durationSuggested,
    });
  else
    // The prompt, NEVER an invented number: a profile with no manual nights to borrow
    // from is asked, not answered on its own behalf.
    chips.push({ key: "duration", label: "add a duration", state: "missing" });

  chips.push(
    f.valence == null
      ? { key: "mood", label: "add a mood", state: "missing" }
      : {
          key: "mood",
          label: `mood ${moodLabel(f.valence).toLowerCase()}`,
          state: "stated",
        }
  );

  return { chips };
}
