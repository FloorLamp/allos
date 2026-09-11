// The summary row of the immunization form (#5302, over #3218's primitive and #5300's
// grammar) — the first of slice 4's four, and the last slice of the family.
//
// AN IMMUNIZATION IS A NAMED PRODUCT GIVEN ON A DAY. The form asked nine labelled
// questions — vaccine, date, dose label, lot number, route, site, reaction, notes and
// who administered it — for a record whose two downstream jobs are a SCHEDULE
// ASSESSMENT and a TRANSCRIBABLE RECORD. The VACCINE stays above the chips as rule 1's
// one identifying field (it is the coded pick, a `Combobox` over the CVX catalog, and
// the action normalizes it back to a catalog code on save); the row states the date;
// everything else falls behind the one trailing affordance.
//
// WHY `date` IS ESSENTIAL, and it is the only one here. Both consumers DROP an undated
// dose outright, and neither says so on any surface:
//
//   • `buildImmunizationRecord` opens its gather with `if (!r.date) continue`
//     (lib/immunization-record.ts:69) — "an undated dose can't be transcribed onto a
//     form and can't be numbered" — so the dose is missing from the printed record a
//     school, camp, employer or travel clinic asked for, which is the artifact the lot
//     / route / site columns exist for in the first place.
//   • `assessSchedule`'s own gather does the same (`if (!r.date) continue`,
//     lib/immunization-status.ts:669) before filling `datesByCode`, so the dose never
//     reaches `VaccineAssessment` at all: the vaccine keeps reading `due` or `overdue`
//     with the shot already given, and `nextRecommended` keeps naming it.
//
// A vaccine record that counts for neither is a row that exists and does nothing, which
// is what the dashed prompt says.
//
// AND WHY `dose` IS OPTIONAL, argued at its own end rather than by contrast. An absent
// dose label is not an absent fact: `resolveDoseLabels` (lib/immunization-status.ts:729)
// numbers each dose WITHIN its vaccine's own date-ordered sequence and only lets a
// non-empty user label win — so a blank field reads back as "Dose 2 of 4", which is
// what a school form wants and what the person would have typed. The field is for the
// case the numbering cannot know ("2025 seasonal").
//
// AND WHY THE THREE ADMINISTRATION COLUMNS ARE OPTIONAL AND SEPARATE. `lot`, `route`
// and `site` reach exactly one consumer, `buildImmunizationRecord`, which prints "one
// row per dose with every stated fact and an em dash for every unstated one — never a
// guess" (lib/immunization-record.ts:7-9). Absence is designed for there. They stay
// THREE chips rather than one grouped fact because no labeller reads them back as one
// line: the printed record gives each its own column, and the skin form's region-plus-
// side is one chip precisely because `bodyMapLabel` is the single function every skin
// surface reads those two columns through. There is no such function here, and
// inventing one to make the row shorter would state a line no other surface prints.
//
// WHAT A TEST SHOULD ASSERT: the chip KEYS and their states, never this file's wording.
//
// Pure: no React, no DB, no clock. The form is a renderer over
// `immunizationFactSummary`.

import {
  DEFAULT_FORMAT_PREFS,
  formatMonthDay,
  type DisplayFormatPrefs,
} from "./format-date";
import { recordFactRow, type RecordFactSummary } from "./record-facts";
import { IMMUNIZATION_ROUTES } from "./types";

// Human labels for the CHECK-pinned route vocabulary (#1406). "Not stated" is the
// default and a real answer — never a guessed 'intramuscular'. They live beside the
// fact that reads them so the chip and the form's own select cannot name a route
// differently.
export const IMMUNIZATION_ROUTE_LABELS: Record<
  (typeof IMMUNIZATION_ROUTES)[number],
  string
> = {
  intramuscular: "Intramuscular (IM)",
  subcutaneous: "Subcutaneous (SC)",
  intradermal: "Intradermal (ID)",
  oral: "Oral (PO)",
  intranasal: "Intranasal (IN)",
  other: "Other",
};

function isRoute(v: string): v is (typeof IMMUNIZATION_ROUTES)[number] {
  return (IMMUNIZATION_ROUTES as readonly string[]).includes(v);
}

/** The stored route as a person reads it, or "" when none is stated. */
export function immunizationRouteLabel(raw: string): string {
  const v = raw.trim();
  return isRoute(v) ? IMMUNIZATION_ROUTE_LABELS[v] : "";
}

// The facts, in the order the row draws them. The one essential leads; the three
// administration columns sit together because a transcriber reads them together.
export type ImmunizationFactKey =
  | "date"
  | "dose"
  | "lot"
  | "route"
  | "site"
  | "reaction"
  | "provider"
  | "notes";

// The nouns, so the trailing affordance can name what it holds.
export const IMMUNIZATION_FACT_NOUNS: Record<ImmunizationFactKey, string> = {
  date: "date given",
  dose: "dose label",
  lot: "lot number",
  route: "route",
  site: "site",
  reaction: "reaction",
  provider: "administered by",
  notes: "notes",
};

export interface ImmunizationFactInput {
  /** The date field as the picker holds it. Seeded to today on the add door. */
  date: string;
  doseLabel: string;
  lotNumber: string;
  /** The route select's value — "" is "Not stated", which is a real answer. */
  route: string;
  site: string;
  /** An adverse reaction to THIS dose; the dose's general note is `notes`. */
  reaction: string;
  provider: string;
  notes: string;
  prefs?: DisplayFormatPrefs;
}

/**
 * Which facts the row states, which it prompts for, and which have gone behind the
 * trailing affordance.
 */
export function immunizationFactSummary(
  f: ImmunizationFactInput
): RecordFactSummary<ImmunizationFactKey> {
  const prefs = f.prefs ?? DEFAULT_FORMAT_PREFS;
  const row = recordFactRow<ImmunizationFactKey>();

  const date = f.date.trim();
  if (date) row.stated("date", `Given ${formatMonthDay(date, prefs)}`);
  else row.missing("date", "Add the date given");

  const dose = f.doseLabel.trim();
  row.state("dose", dose, dose);
  const lot = f.lotNumber.trim();
  row.state("lot", lot, lot ? `Lot ${lot}` : "");
  // Through the label map the form's own select renders, so the chip cannot name a
  // route differently from the option that set it.
  const route = immunizationRouteLabel(f.route);
  row.state("route", route, route);
  row.state("site", f.site, f.site.trim());
  // The reaction MARKER, not the reaction: what was recorded is a sentence, and a chip
  // states a fact (the skin row's reading of its finding field).
  row.state("reaction", f.reaction, "Reaction noted");
  row.state("provider", f.provider, f.provider.trim());
  // The notes MARKER, not the notes.
  row.state("notes", f.notes, "Notes added");

  return row.summary();
}
