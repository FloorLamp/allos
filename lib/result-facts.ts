// The summary row of the clinical-result form (#5302, over #3218's primitive and
// #5300's grammar) — the largest of the twelve, and the one the slicing comment said
// was most likely to argue back. It did.
//
// A RESULT IS ONE ANALYTE'S READING ON A DAY. The form asked FIFTEEN labelled
// questions, five of them only when editing. The NAME stays above the chips as rule 1's
// one identifying field (it is the required value both actions validate); the row
// states the date, the category and the reading itself; the rest fall behind the one
// trailing affordance.
//
// ── WHERE THIS DISAGREES WITH THE ENTRY IT REPLACES ──────────────────────────
//
// `FORM_GRAMMAR`'s old `fields` entry named `fasting`, `specimen`, `result_status` and
// `flag` as "facts the person states about THIS result", and dismissed the value, unit
// and reference range as "the least of what it asks for". Checked against the
// consumers, it comes out close to INVERTED, and the reason is the same in all four
// cases: each of those four has a module that says in its own words that ABSENCE IS A
// REAL ANSWER, while the reading's absence is a silent claim.
//
// WHY `reading` IS ESSENTIAL — the value and its unit, ONE fact over ONE editor.
//
//   • NO VALUE, NO READING. `addResult` derives `value_num` only from a purely numeric
//     `value` (app/(app)/results/clinical-result-actions.ts:77-80), and
//     `readingFromObservation` returns NULL on its first line when `value_num` is null
//     (lib/reading-model.ts:290) — "a qualitative result is a reading of a different
//     question and has no place in a numeric series". With no value at all the row is
//     neither: it charts nothing, `reconcileFlags`'s numeric pass skips it
//     (`value_num IS NOT NULL`, lib/queries/medical/flags.ts:186) and its qualitative
//     pass has no text to classify. It records that a test happened and nothing about
//     what it said.
//
//   • AND THE UNIT IS PART OF THE SAME FACT, because a number without one is not a
//     smaller fact — it is a DIFFERENT one. `convertToCanonical` treats a missing unit
//     as "already in the canonical unit" (lib/unit-conversions.ts:287-295), so an LDL
//     typed in mmol/L with the unit left blank is judged against the mg/dL band and
//     flagged `low` on a perfectly ordinary result; and for a bare count-per-volume
//     canonical it declines outright rather than guess, because the same assumption
//     "reads a normal ANC of 7.5 (×10^3/uL) as 7.5 cells/uL → a false 'agranulocytosis'
//     low". `reconciledFlag` then returns `undefined` at lib/reference-range/flags.ts:283
//     ("can't convert to the canonical unit — can't judge"). Value and unit read back as
//     ONE line everywhere else — `revisionSummary` prints `${value} ${displayUnit(unit)}`
//     (lib/lab-result-lifecycle.ts:204-215) — so they are one chip over one editor, the
//     region-and-side rule at this address.
//
//   • AND THE UNIT IS PROMPTED FOR ONLY WHEN THE VALUE IS NUMERIC. A qualitative
//     "Reactive" / "Non-reactive" HAS no unit, and `convertToCanonical` is never
//     reached for one — `value_num` is null, so the reading goes down the qualitative
//     path instead. Dashing every serology result for a unit it cannot have would press
//     for a fact the report does not make, which is #715's mistake in another domain.
//     The numeric test is the action's own (`Number.isFinite(Number(value))`), so the
//     chip prompts exactly where the column it guards gets written.
//
// WHY `date` IS ESSENTIAL. Both actions refuse a non-ISO date outright
// (`isRealIsoDate`, clinical-result-actions.ts:73 and :136), and every reading surface
// files the row by it: `readingFromObservation` sets `date: row.date` and
// `collapseReadings` groups on (identity, DATE, source, value), so the day is half of
// what makes two readings the same measurement. The dashed prompt is what the form says
// before the server does.
//
// WHY `category` IS ESSENTIAL. It is not a filing detail: `reconcileFlags`'s QUALITATIVE
// pass is gated `value_num IS NULL AND category = 'lab'` (lib/queries/medical/flags.ts:225),
// so a "Reactive" filed under any other category is never routed through the shared
// classifier and keeps whatever flag it arrived with. And the select can post blank,
// which `addResult` silently resolves to 'lab' (clinical-result-actions.ts:66-70) — a
// fallback the person should see coming rather than discover.
//
// ── AND THE FOUR THE OLD ENTRY NAMED, each argued at its own end ─────────────
//
// `result_status` is OPTIONAL because `normalizeResultStatus` is deliberately strict:
// "an unknown word means 'unstated', which is NOT the same claim as 'final' — a legacy
// or manual reading asserts nothing about its place in the lifecycle"
// (lib/lab-result-lifecycle.ts:56-59), and `resultStatusLabel` renders no badge at all
// for null "rather than a misleading 'Final'". Unstated is the answer a manual entry
// honestly gives.
//
// `fasting` is OPTIONAL for the reason its own type exists: it is a nullable TRI-STATE
// where null means "the source didn't say", and the module says a NOT NULL column
// "would silently assert every legacy reading was non-fasting" (lines 84-86). Nothing
// reads the column but `fastingLabel`.
//
// `specimen` is OPTIONAL on its module's own argument: the canonical biomarker
// vocabulary "already splits the analytes whose specimen changes the interpretation"
// ("Folate, RBC" vs "Folate", lines 113-116), so the specimen qualifies a reading the
// vocabulary has already disambiguated.
//
// `flag` is OPTIONAL because THE APP WRITES IT. `addResult` calls `reconcileFlags` on
// the row it just inserted, inside the same transaction (line 117), and only the four
// clinical flags are user-settable at all — "non-optimal" is derived from the optimal
// band. A dashed prompt would ask the person for a value the next line computes: the
// care-plan `status` reading (#5827) at this address.
//
// `canonical` is OPTIONAL because `addResult` defaults it to the observation's own name
// (line 83-84), so the column is never blank and every consumer reads it as
// `COALESCE(NULLIF(TRIM(canonical_name), ''), name)` anyway. The chip states it only
// when it DIFFERS from the name above the row — stating the heading twice is nothing to
// state.
//
// `reference` is OPTIONAL because the row's printed range is the LAST resort, ordered
// after the app's own optimal band on purpose: "where we publish a band, ours is the
// one on screen" (lib/reference-range/flags.ts, `labStatedFlag`).
//
// ── The five edit-only facts ─────────────────────────────────────────────────
//
// `panel`, `flag`, `provider` and `ordering` are rendered ONLY in edit mode, because
// `addResult` parses none of them. A fact the form does not post is not a fact (#5302's
// rule, first applied to the allergy form's absent code), so in add mode they are not
// in the summary at all — neither as chips nor behind the trailing affordance, which
// would otherwise name four editors the add door does not have.
//
// WHAT A TEST SHOULD ASSERT: the chip KEYS and their states, never this file's wording.
//
// Pure: no React, no DB, no clock. The form is a renderer over `resultFactSummary`.

import { displayUnit } from "./display-unit";
import {
  DEFAULT_FORMAT_PREFS,
  formatMonthDay,
  type DisplayFormatPrefs,
} from "./format-date";
import { fastingLabel, resultStatusLabel } from "./lab-result-lifecycle";
import { recordFactRow, type RecordFactSummary } from "./record-facts";

// The facts, in the order the row draws them. The three essentials lead; the
// collection attributes sit next to the reading they qualify, and the edit-only
// provenance facts come last.
export type ResultFactKey =
  | "date"
  | "category"
  | "reading"
  | "canonical"
  | "reference"
  | "specimen"
  | "fasting"
  | "status"
  | "panel"
  | "flag"
  | "provider"
  | "ordering"
  | "notes";

// The nouns, so the trailing affordance can name what it holds.
export const RESULT_FACT_NOUNS: Record<ResultFactKey, string> = {
  date: "date",
  category: "category",
  reading: "value and unit",
  canonical: "canonical name",
  reference: "reference range",
  specimen: "specimen",
  fasting: "fasting",
  status: "result status",
  panel: "panel",
  flag: "flag",
  provider: "performed by",
  ordering: "ordered by",
  notes: "notes",
};

export interface ResultFactInput {
  date: string;
  /** The category select's value. Born with one on both doors; "" is possible. */
  category: string;
  /** The analyte name above the row — read only to decide whether `canonical` adds anything. */
  name: string;
  canonical: string;
  /** The value field exactly as the input holds it; numeric-ness is decided here. */
  value: string;
  unit: string;
  referenceRange: string;
  specimen: string;
  /** The fasting select: "1", "0", or "" for unstated. */
  fasting: string;
  resultStatus: string;
  notes: string;
  /**
   * Edit mode. The add action parses none of the four facts below, so the row must not
   * offer them there — the skin form's `linkableVisits` rule, for a whole mode rather
   * than one picker.
   */
  editing: boolean;
  panel: string;
  flag: string;
  provider: string;
  orderingProvider: string;
  prefs?: DisplayFormatPrefs;
}

/** The action's own numeric test (clinical-result-actions.ts:77-80). */
function isNumericValue(value: string): boolean {
  const v = value.trim();
  return v !== "" && Number.isFinite(Number(v));
}

/**
 * Which facts the row states, which it prompts for, and which have gone behind the
 * trailing affordance.
 */
export function resultFactSummary(
  f: ResultFactInput
): RecordFactSummary<ResultFactKey> {
  const prefs = f.prefs ?? DEFAULT_FORMAT_PREFS;
  const row = recordFactRow<ResultFactKey>();

  const date = f.date.trim();
  if (date) row.stated("date", formatMonthDay(date, prefs));
  else row.missing("date", "Add the date");

  const category = f.category.trim();
  if (category) row.stated("category", category);
  else row.missing("category", "Choose a category");

  // The value and its unit as ONE line — the same one `revisionSummary` prints.
  const value = f.value.trim();
  const unit = displayUnit(f.unit.trim());
  if (!value) row.missing("reading", "Add the result");
  else if (isNumericValue(value) && !unit)
    // Only a NUMERIC value has a unit to be missing: see the header.
    row.missing("reading", "Add the unit");
  else row.stated("reading", unit ? `${value} ${unit}` : value);

  // Stated only when it says something the identifying field above does not.
  const canonical = f.canonical.trim();
  const distinct =
    canonical && canonical.toLowerCase() !== f.name.trim().toLowerCase()
      ? canonical
      : "";
  row.state("canonical", distinct, distinct);

  const reference = f.referenceRange.trim();
  row.state("reference", reference, reference ? `Ref ${reference}` : "");
  row.state("specimen", f.specimen, f.specimen.trim());
  // Through the one labeller every surface reads the tri-state with, so a blank and an
  // explicit "Non-fasting" can never look alike.
  const fasting = fastingLabel(
    f.fasting === "1" ? 1 : f.fasting === "0" ? 0 : null
  );
  row.state("fasting", fasting ?? "", fasting ?? "");
  const status = resultStatusLabel(f.resultStatus);
  row.state("status", status ?? "", status ?? "");

  if (f.editing) {
    row.state("panel", f.panel, f.panel.trim());
    row.state("flag", f.flag, f.flag.trim());
    row.state("provider", f.provider, f.provider.trim());
    row.state("ordering", f.orderingProvider, f.orderingProvider.trim());
  }

  // The notes MARKER, not the notes.
  row.state("notes", f.notes, "Notes added");

  return row.summary();
}
