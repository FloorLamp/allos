// Copy policy for the Upcoming biomarker RETEST item (issues #513 / #514). An
// Upcoming `biomarker` item is purely a retest-overdue signal: it fires for any
// stale lab/biomarker reading whose last draw + curated cadence is in the past,
// REGARDLESS of range status. Two defects this module fixes, kept pure + tested
// so the page and any future surface share one copy computation:
//
//   1. The title must carry the ACTION verb ("Retest HDL Cholesterol"), not the
//      bare analyte name — a bare name in an urgency-banded list reads as "your
//      HDL is wrong" when it means "consider retesting". Same copy rule as the
//      notification builders (state the action).
//   2. The signal is range-blind — a below-optimal HDL and a pristine-but-old HDL
//      produce identical items. When the stale reading is FLAGGED (out-of-range or
//      non-optimal) the detail acknowledges the status ("Below optimal at last
//      test · …") so the user isn't left asking "what do I do with this?" — the
//      flag surface (dashboard hero) still owns the management action; this item
//      stays the retest clock, now honest about the reading's status.

import { flagLabel, isNonOptimal, isOutOfRange } from "./reference-range";
import type { MedicalFlag } from "./types";

// The action-carrying title for a retest item: the verb up front so the row reads
// as an action ("Retest HDL Cholesterol"), never a bare analyte name.
export function biomarkerRetestTitle(name: string): string {
  return `Retest ${name}`;
}

// Whether a stored flag warrants the status prefix — any out-of-range (clinical)
// or non-optimal reading. A normal/absent flag stays quiet (the plain retest line).
export function isFlaggedForRetest(
  flag: MedicalFlag | null | undefined
): boolean {
  return isOutOfRange(flag) || isNonOptimal(flag);
}

// The detail line for a retest item. Always states the last-tested date and the
// cadence; when the reading was flagged it LEADS with the status ("Below optimal
// at last test · …") so a flagged analyte's row explains itself.
export function biomarkerRetestDetail(o: {
  effectiveDate: string;
  agoMonths: number;
  intervalMonths: number;
  flag?: MedicalFlag | null;
}): string {
  const base = `Last tested ${o.effectiveDate} (${o.agoMonths}mo ago) · retest every ${o.intervalMonths}mo`;
  if (isFlaggedForRetest(o.flag)) {
    return `${flagLabel(o.flag)} at last test · ${base}`;
  }
  return base;
}
