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
// AND WHY THE THREE ADMINISTRATION COLUMNS ARE **ONE** FACT. `lot_number`, `route` and
// `site` reach exactly one consumer, and it reads them back as ONE LINE:
// `immunizationAdministrationLine` ("Lot AB1234 · IM · Left deltoid") is already the one
// computation the history table, the per-vaccine dose list and the export share, "so
// they can never phrase the same dose differently". Three chips would state one line
// three times and let the chip disagree with the row it becomes — the skin form's
// region-and-side rule at this address, with the labeller supplied rather than invented.
// The fact is optional because the printed record is built for its absence: one row per
// dose "with every stated fact and an em dash for every unstated one — never a guess"
// (lib/immunization-record.ts:7-9).
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
import { immunizationAdministrationLine } from "./record-format";
import { recordFactRow, type RecordFactSummary } from "./record-facts";
import { IMMUNIZATION_ROUTES } from "./types";

// The facts, in the order the row draws them. The one essential leads.
export type ImmunizationFactKey =
  "date" | "dose" | "administration" | "reaction" | "provider" | "notes";

// The nouns, so the trailing affordance can name what it holds.
export const IMMUNIZATION_FACT_NOUNS: Record<ImmunizationFactKey, string> = {
  date: "date given",
  dose: "dose label",
  administration: "lot, route and site",
  reaction: "reaction",
  provider: "administered by",
  notes: "notes",
};

export interface ImmunizationFactInput {
  /** The date field as the picker holds it. Seeded to today on the add door. */
  date: string;
  doseLabel: string;
  /** The three administration columns; read back as one line. */
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

/** A route the CHECK set holds, else null — the action's own `routeOf` rule. */
function storedRoute(raw: string): string | null {
  const v = raw.trim();
  return (IMMUNIZATION_ROUTES as readonly string[]).includes(v) ? v : null;
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

  // Through the ONE line the history table, the dose list and the export already read
  // these three columns with — and through the action's own route rule, so a value the
  // CHECK set would refuse is never stated as though it will be stored.
  const administration = immunizationAdministrationLine({
    lot_number: f.lotNumber || null,
    route: storedRoute(f.route),
    site: f.site || null,
  });
  row.state("administration", administration, administration);

  // The reaction MARKER, not the reaction: what was recorded is a sentence, and a chip
  // states a fact (the skin row's reading of its finding field).
  row.state("reaction", f.reaction, "Reaction noted");
  row.state("provider", f.provider, f.provider.trim());
  // The notes MARKER, not the notes.
  row.state("notes", f.notes, "Notes added");

  return row.summary();
}
