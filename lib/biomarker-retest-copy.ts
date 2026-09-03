// Copy policy for the Upcoming biomarker RETEST item (issues #513 / #514). An
// Upcoming `biomarker` item is purely a retest-overdue signal: it fires for any
// stale lab reading whose last draw + curated cadence is in the past,
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
//      flagged-result dashboard placement still owns the management action; this item
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

// THE RETEST FACTS, CARRIED RATHER THAN COMPOSED (#3526). The item holds these and
// each channel writes its own sentence, because the only part that differs between
// channels is HOW THE DAY IS SPELLED: the generator that builds them is a login-less
// query layer, so it cannot resolve a DisplayFormatPrefs, and threading one into it
// would hand the digest and Telegram one login's date shape. Every other fact here
// renders identically everywhere.
export interface BiomarkerRetestFacts {
  // The last draw, as a profile-local YYYY-MM-DD. RAW on purpose: the channel that
  // has a login formats it, the ones that do not keep the unambiguous ISO day.
  effectiveDate: string;
  agoMonths: number;
  intervalMonths: number;
  flag?: MedicalFlag | null;
  // Calm risk-priority reasons (issue #517) appended so a modulated cadence /
  // ranked item explains WHY ("Family history of heart disease"). Empty = routine.
  reasons?: string[];
}

// The detail line for a retest item. Always states the last-tested date and the
// cadence; when the reading was flagged it LEADS with the status ("Below optimal
// at last test · …") so a flagged analyte's row explains itself.
//
// `dayText` is REQUIRED and is the whole point of the split: a caller must say which
// spelling of the last-tested day it is rendering — the login's date shape on a page,
// the ISO day on a login-less channel — rather than inheriting one by accident.
export function biomarkerRetestDetail(
  o: BiomarkerRetestFacts,
  dayText: string
): string {
  const base = `Last tested ${dayText} (${o.agoMonths}mo ago) · retest every ${o.intervalMonths}mo`;
  const withStatus = isFlaggedForRetest(o.flag)
    ? `${flagLabel(o.flag)} at last test · ${base}`
    : base;
  const reasons = o.reasons?.filter(Boolean) ?? [];
  return reasons.length ? `${withStatus} · ${reasons.join(", ")}` : withStatus;
}
